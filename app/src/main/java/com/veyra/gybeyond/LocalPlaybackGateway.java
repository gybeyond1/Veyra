package com.veyra.gybeyond;

import android.content.Context;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.GZIPInputStream;

/**
 * 本机播放网关：把「仅直连」这一档真正做成 guoapp 那种结构。
 *
 * <p>播放器只跟 {@code 127.0.0.1} 说话，网关再拿着源站要的 Referer / Cookie / UA
 * 去跟源站说话。这样做的三件事，是直接让播放器连源站做不到的：
 *
 * <ul>
 *   <li>m3u8 逐行重写：分片、子清单、{@code #EXT-X-KEY}、{@code #EXT-X-MAP} 的 URI
 *       全部换成本机地址，播放器再也不会拿着裸地址去撞防盗链；</li>
 *   <li>每条上游请求都补头：清单、分片、密钥三条链路都带同一套凭据；</li>
 *   <li>key 在内存里吐：{@code #EXT-X-KEY} 指向的 AES-128 密钥由网关取回并直接返回
 *       16 字节，播放器不需要再去请求源站。</li>
 * </ul>
 *
 * <p>和 guoapp 的 {@code app_stream.go} 结构对齐：会话（token）→ 资源（assetId）→
 * 惰性取流，Range / If-Range 原样透传，206 直通。
 *
 * <p>只监听 127.0.0.1，端口每次启动随机；会话最多 8 个、空闲 10 分钟回收。
 */
final class LocalPlaybackGateway {

    private static final String TAG = "VeyraLocalGateway";
    private static final int MAX_SESSIONS = 8;
    private static final long IDLE_MS = 10L * 60 * 1000;
    private static final int MAX_PLAYLIST = 4 << 20;
    private static final Pattern URI_ATTR = Pattern.compile("URI=\"([^\"]+)\"");

    private static volatile LocalPlaybackGateway instance;

    private final ServerSocket server;
    private final int port;
    private final ExecutorService pool = Executors.newFixedThreadPool(6, runnable -> {
        Thread thread = new Thread(runnable, "veyra-local-gateway");
        thread.setDaemon(true);
        return thread;
    });
    private final Map<String, Session> sessions = new ConcurrentHashMap<>();

    /** 一次性会话：一集一个 token，带着这一集的源站凭据。 */
    private static final class Session {
        final String token;
        final String referer;
        final String origin;
        final Map<String, String> headers;
        final byte[] key;
        volatile long lastUsed = System.currentTimeMillis();
        final Map<String, Asset> assets = new ConcurrentHashMap<>();

        Session(String token, String referer, String origin, Map<String, String> headers, byte[] key) {
            this.token = token == null ? "" : token;
            this.referer = referer == null ? "" : referer;
            this.origin = origin == null ? "" : origin;
            this.headers = headers == null ? new LinkedHashMap<>() : new LinkedHashMap<>(headers);
            this.key = key;
        }
    }

    /** 一个可播资源：要么自带内容（密钥 / 预置清单），要么指向源站地址惰性取。 */
    private static final class Asset {
        final String kind;          // entry_playlist / child_playlist / segment / key / map / media
        final String address;       // 源站真实地址（相对地址已在重写时解析成绝对）
        final String contentType;
        final byte[] data;          // 非空表示不走网络

        Asset(String kind, String address, String contentType, byte[] data) {
            this.kind = kind;
            this.address = address;
            this.contentType = contentType;
            this.data = data;
        }
    }

    private LocalPlaybackGateway() throws IOException {
        ServerSocket socket = null;
        int chosen = 0;
        // 端口冲突就换一个，最多试 20 次；本机回环不需要也不应该固定端口
        for (int i = 0; i < 20; i++) {
            try {
                socket = new ServerSocket(0, 32, InetAddress.getByName("127.0.0.1"));
                chosen = socket.getLocalPort();
                break;
            } catch (IOException error) {
                if (i == 19) throw error;
            }
        }
        if (socket == null) throw new IOException("本机播放网关启动失败");
        this.server = socket;
        this.port = chosen;
        Thread acceptor = new Thread(this::acceptLoop, "veyra-local-gateway-accept");
        acceptor.setDaemon(true);
        acceptor.start();
    }

    static LocalPlaybackGateway get(Context context) {
        LocalPlaybackGateway local = instance;
        if (local != null) return local;
        synchronized (LocalPlaybackGateway.class) {
            if (instance == null) {
                try {
                    instance = new LocalPlaybackGateway();
                } catch (IOException error) {
                    Log.w(TAG, "网关启动失败", error);
                    return null;
                }
            }
            return instance;
        }
    }

    /**
     * 给一集开一个会话，返回播放器该用的地址。
     *
     * @param url     后端下发的源站真实地址（net=1）
     * @param headers 后端随地址下发的 Referer / Cookie / User-Agent 等
     */
    String open(String url, Map<String, String> headers) throws IOException {
        prune();
        byte[] random = new byte[16];
        new SecureRandom().nextBytes(random);
        String token = hex(random);

        String referer = headers == null ? "" : headers.get("Referer");
        if (referer == null || referer.isEmpty()) referer = baseOf(url) + "/";
        // 绝大多数是 HLS；真给的是 mp4 时 serveAsset 会按上游 Content-Type 纠正
        String contentType = guessType(url, "application/vnd.apple.mpegurl");
        String kind = "application/vnd.apple.mpegurl".equals(contentType) ? "entry_playlist" : "media";

        Session session = new Session(token, referer, hostOf(url), headers, null);
        Asset entry = new Asset(kind, url, contentType, null);
        sessions.put(token, session);
        return assetUrl(session, entry);
    }

    /** 播完一集就回收，别把凭据留在内存里等超时。 */
    void release(String url) {
        // 界面上传的是网关地址，反查出 token
        String token = tokenOf(url);
        if (token != null) sessions.remove(token);
    }

    private void prune() {
        long now = System.currentTimeMillis();
        Iterator<Map.Entry<String, Session>> iterator = sessions.entrySet().iterator();
        while (iterator.hasNext()) {
            Map.Entry<String, Session> entry = iterator.next();
            if (now - entry.getValue().lastUsed > IDLE_MS) iterator.remove();
        }
        while (sessions.size() >= MAX_SESSIONS) {
            String oldest = null;
            long stamp = Long.MAX_VALUE;
            for (Map.Entry<String, Session> entry : sessions.entrySet()) {
                if (entry.getValue().lastUsed < stamp) {
                    stamp = entry.getValue().lastUsed;
                    oldest = entry.getKey();
                }
            }
            if (oldest == null) break;
            sessions.remove(oldest);
        }
    }

    /* ---------------- 连接处理 ---------------- */

    private void acceptLoop() {
        while (!server.isClosed()) {
            try {
                Socket socket = server.accept();
                pool.execute(() -> serve(socket));
            } catch (IOException error) {
                if (server.isClosed()) return;
            }
        }
    }

    private void serve(Socket socket) {
        try (Socket client = socket) {
            client.setSoTimeout(30000);
            InputStream raw = new BufferedInputStream(client.getInputStream(), 8192);
            OutputStream out = client.getOutputStream();

            String requestLine = readLine(raw);
            if (requestLine == null || requestLine.isEmpty()) return;
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) return;
            boolean head = "HEAD".equalsIgnoreCase(parts[0]);
            String target = parts[1];
            String path = target;
            int mark = path.indexOf('?');
            if (mark >= 0) path = path.substring(0, mark);

            Map<String, String> requestHeaders = new HashMap<>();
            String line;
            while ((line = readLine(raw)) != null && !line.isEmpty()) {
                int colon = line.indexOf(':');
                if (colon > 0) {
                    requestHeaders.put(line.substring(0, colon).trim().toLowerCase(Locale.ROOT), line.substring(colon + 1).trim());
                }
            }

            String[] segments = path.replaceAll("^/+|/+$", "").split("/");
            if (segments.length != 2) {
                writeStatus(out, 404, "Not Found", head);
                return;
            }
            Session session = sessions.get(segments[0]);
            if (session == null) {
                writeStatus(out, 410, "Gone", head);
                return;
            }
            session.lastUsed = System.currentTimeMillis();
            Asset asset = session.assets.get(segments[1]);
            if (asset == null) {
                writeStatus(out, 404, "Not Found", head);
                return;
            }
            serveAsset(out, head, requestHeaders, session, asset);
        } catch (Exception error) {
            Log.d(TAG, "请求处理失败: " + error.getMessage());
        }
    }

    private void serveAsset(OutputStream out, boolean head, Map<String, String> requestHeaders,
                            Session session, Asset asset) throws IOException {
        if (asset.data != null) {
            if ("application/vnd.apple.mpegurl".equals(asset.contentType)) {
                String body = rewrite(session, new String(asset.data, StandardCharsets.UTF_8), asset.address);
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                writeHead(out, 200, "OK", "application/vnd.apple.mpegurl", bytes.length, null, head);
                if (!head) out.write(bytes);
            } else {
                writeHead(out, 200, "OK", asset.contentType, asset.data.length, null, head);
                if (!head) out.write(asset.data);
            }
            out.flush();
            return;
        }

        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(asset.address).openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            conn.setInstanceFollowRedirects(true);
            conn.setUseCaches(false);
            conn.setRequestMethod(head ? "HEAD" : "GET");
            // 上游一定发身份编码，否则拿到的清单是 gzip 的没法逐行改写
            conn.setRequestProperty("Accept-Encoding", "identity");
            String targetHost = hostOf(asset.address);
            for (Map.Entry<String, String> header : session.headers.entrySet()) {
                String name = header.getKey();
                if (name == null || header.getValue() == null) continue;
                String lower = name.toLowerCase(Locale.ROOT);
                if (lower.equals("host") || lower.equals("content-length") || lower.equals("range")
                        || lower.equals("if-range") || lower.equals("accept-encoding")) continue;
                // 签名 Cookie 只回源站自己：分片常落在另一条 CDN，发过去会被当成非法请求
                if (lower.equals("cookie") && !sameSite(targetHost, session.origin)) continue;
                conn.setRequestProperty(name, header.getValue());
            }
            if (session.referer != null && !session.referer.isEmpty() && !hasHeader(session.headers, "referer")) {
                conn.setRequestProperty("Referer", session.referer);
            }
            String range = requestHeaders.get("range");
            if (range != null) conn.setRequestProperty("Range", range);
            String ifRange = requestHeaders.get("if-range");
            if (ifRange != null) conn.setRequestProperty("If-Range", ifRange);

            int status = conn.getResponseCode();
            if (status != 200 && status != 206) {
                byte[] body = readLimited(conn.getErrorStream(), 64 << 10);
                writeHead(out, status, "Upstream Error", "text/plain; charset=utf-8", body.length, null, head);
                if (!head) out.write(body);
                out.flush();
                return;
            }

            String contentType = String.valueOf(conn.getContentType() == null ? "" : conn.getContentType()).toLowerCase(Locale.ROOT);
            InputStream stream = conn.getInputStream();
            if ("gzip".equalsIgnoreCase(conn.getContentEncoding())) stream = new GZIPInputStream(stream);
            BufferedInputStream body = new BufferedInputStream(stream, 16384);

            boolean playlist = contentType.contains("mpegurl");
            if (!playlist) {
                body.mark(1024);
                byte[] peek = new byte[512];
                int read = body.read(peek);
                body.reset();
                if (read > 0) {
                    String head3 = new String(peek, 0, read, StandardCharsets.UTF_8).trim();
                    if (head3.startsWith("\ufeff")) head3 = head3.substring(1).trim();
                    if (head3.startsWith("#EXTM3U")) playlist = true;
                }
            }

            if (playlist) {
                byte[] raw = readLimited(body, MAX_PLAYLIST);
                String text = new String(raw, StandardCharsets.UTF_8).trim();
                if (text.startsWith("\ufeff")) text = text.substring(1).trim();
                if (!text.startsWith("#EXTM3U")) {
                    writeStatus(out, 502, "Bad Gateway", head);
                    return;
                }
                String rewritten = rewrite(session, text, conn.getURL().toString());
                byte[] bytes = rewritten.getBytes(StandardCharsets.UTF_8);
                writeHead(out, 200, "OK", "application/vnd.apple.mpegurl", bytes.length, null, head);
                if (!head) out.write(bytes);
                out.flush();
                return;
            }

            int length = conn.getContentLength();
            Map<String, String> extra = new LinkedHashMap<>();
            copyHeader(conn, extra, "Content-Range");
            copyHeader(conn, extra, "Accept-Ranges");
            copyHeader(conn, extra, "ETag");
            writeHead(out, status, status == 206 ? "Partial Content" : "OK",
                    contentType.isEmpty() ? "application/octet-stream" : contentType, length, extra, head);
            if (!head) {
                byte[] buffer = new byte[32768];
                int count;
                while ((count = body.read(buffer)) > 0) out.write(buffer, 0, count);
            }
            out.flush();
        } catch (IOException error) {
            writeStatus(out, 502, "Bad Gateway", head);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /* ---------------- m3u8 重写 ---------------- */

    private String rewrite(Session session, String body, String address) {
        String normalized = body.replace("\r\n", "\n");
        String[] lines = normalized.split("\n", -1);
        StringBuilder output = new StringBuilder(normalized.length() + 1024);
        boolean nextPlaylist = false;
        for (int index = 0; index < lines.length; index++) {
            String line = lines[index];
            String text = line.trim();
            if (!text.isEmpty() && !text.startsWith("#")) {
                String type = nextPlaylist ? "application/vnd.apple.mpegurl" : guessType(text, "video/mp2t");
                String replaced = assetFor(session, text, address, type);
                nextPlaylist = false;
                output.append(replaced == null ? text : replaced);
            } else if (text.contains("URI=")) {
                output.append(rewriteAttributes(session, line, text, address));
            } else {
                output.append(line);
            }
            if (index < lines.length - 1) output.append('\n');
        }
        return output.toString();
    }

    private String rewriteAttributes(Session session, String line, String text, String base) {
        boolean key = text.startsWith("#EXT-X-KEY:") || text.startsWith("#EXT-X-SESSION-KEY:");
        String type = "";
        if (key) type = "application/octet-stream";
        else if (text.startsWith("#EXT-X-MAP:")) type = "video/mp4";
        else if (text.startsWith("#EXT-X-MEDIA:") || text.startsWith("#EXT-X-I-FRAME-STREAM-INF:")
                || text.startsWith("#EXT-X-RENDITION-REPORT:")) type = "application/vnd.apple.mpegurl";

        Matcher matcher = URI_ATTR.matcher(line);
        StringBuffer buffer = new StringBuffer();
        while (matcher.find()) {
            String reference = matcher.group(1);
            String resolved = assetFor(session, reference, base, type);
            if (resolved == null) resolved = reference;
            matcher.appendReplacement(buffer, Matcher.quoteReplacement("URI=\"" + resolved + "\""));
        }
        matcher.appendTail(buffer);
        return buffer.toString();
    }

    /**
     * 把一条相对 / 绝对地址换成网关地址。地址不合法（data:、非 http）时返回 null，
     * 调用方保留原样，别把整份清单搞坏。
     */
    private String assetFor(Session session, String reference, String base, String contentType) {
        if (reference == null || reference.isEmpty() || reference.startsWith("data:")) return null;
        String address;
        try {
            address = new URL(new URL(base), reference).toString();
        } catch (Exception error) {
            return null;
        }
        if (!address.startsWith("http://") && !address.startsWith("https://")) return null;

        String type = contentType == null || contentType.isEmpty() ? guessType(address, "video/mp2t") : contentType;
        String kind;
        if (type.startsWith("application/vnd.apple.mpegurl")) kind = "child_playlist";
        else if (type.equals("application/octet-stream")) kind = "key";
        else if (type.equals("video/mp4")) kind = "map";
        else kind = "segment";

        byte[] data = null;
        if (kind.equals("key") && session.key != null && session.key.length == 16) {
            data = session.key;
            type = "application/octet-stream";
        }
        Asset asset = new Asset(kind, address, type, data);
        return assetUrl(session, asset);
    }

    private String assetUrl(Session session, Asset asset) {
        MessageDigest digest;
        String id;
        try {
            digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest((asset.address + "\u0000" + asset.contentType).getBytes(StandardCharsets.UTF_8));
            byte[] head = new byte[12];
            System.arraycopy(hash, 0, head, 0, 12);
            id = hex(head) + extensionOf(asset);
        } catch (Exception error) {
            id = Integer.toHexString(asset.address.hashCode()) + extensionOf(asset);
        }
        session.assets.put(id, asset);
        return "http://127.0.0.1:" + port + "/" + session.token + "/" + id;
    }

    private static String extensionOf(Asset asset) {
        if ("application/vnd.apple.mpegurl".equals(asset.contentType)) return ".m3u8";
        if ("application/octet-stream".equals(asset.contentType)) return ".key";
        if ("video/mp4".equals(asset.contentType)) return ".mp4";
        String path = asset.address;
        int query = path.indexOf('?');
        if (query >= 0) path = path.substring(0, query);
        String lower = path.toLowerCase(Locale.ROOT);
        for (String candidate : new String[]{".m3u8", ".ts", ".m4s", ".mp4", ".aac", ".m4a", ".mp3", ".vtt", ".webvtt", ".key"}) {
            if (lower.endsWith(candidate)) return candidate;
        }
        return ".ts";
    }

    private static String guessType(String address, String fallback) {
        String path = address == null ? "" : address;
        int query = path.indexOf('?');
        if (query >= 0) path = path.substring(0, query);
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
        if (lower.endsWith(".mp4")) return "video/mp4";
        if (lower.endsWith(".m4s")) return "video/iso.segment";
        if (lower.endsWith(".key")) return "application/octet-stream";
        return fallback == null ? "application/octet-stream" : fallback;
    }

    /* ---------------- HTTP 小工具 ---------------- */

    private static void writeHead(OutputStream out, int status, String reason, String type, int length,
                                  Map<String, String> extra, boolean head) throws IOException {
        StringBuilder builder = new StringBuilder();
        builder.append("HTTP/1.1 ").append(status).append(' ').append(reason).append("\r\n");
        builder.append("Content-Type: ").append(type).append("\r\n");
        if (length >= 0) builder.append("Content-Length: ").append(length).append("\r\n");
        if (extra != null) {
            for (Map.Entry<String, String> header : extra.entrySet()) {
                builder.append(header.getKey()).append(": ").append(header.getValue()).append("\r\n");
            }
        }
        builder.append("Cache-Control: no-store\r\n");
        builder.append("Connection: close\r\n\r\n");
        out.write(builder.toString().getBytes(StandardCharsets.UTF_8));
        if (head) out.flush();
    }

    private static void writeStatus(OutputStream out, int status, String reason, boolean head) throws IOException {
        writeHead(out, status, reason, "text/plain; charset=utf-8", 0, null, head);
        out.flush();
    }

    private static void copyHeader(HttpURLConnection conn, Map<String, String> target, String name) {
        String value = conn.getHeaderField(name);
        if (value != null && !value.isEmpty()) target.put(name, value);
    }

    private static boolean hasHeader(Map<String, String> headers, String name) {
        if (headers == null) return false;
        for (String key : headers.keySet()) {
            if (key != null && key.equalsIgnoreCase(name)) return true;
        }
        return false;
    }

    private static byte[] readLimited(InputStream stream, int limit) throws IOException {
        if (stream == null) return new byte[0];
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int total = 0;
        int count;
        while ((count = stream.read(chunk)) > 0) {
            total += count;
            if (total > limit) throw new IOException("响应超过上限");
            buffer.write(chunk, 0, count);
        }
        return buffer.toByteArray();
    }

    private static String readLine(InputStream stream) throws IOException {
        StringBuilder builder = new StringBuilder();
        int value;
        while ((value = stream.read()) != -1) {
            if (value == '\n') break;
            if (value != '\r') builder.append((char) value);
            if (builder.length() > 8192) break;
        }
        if (value == -1 && builder.length() == 0) return null;
        return builder.toString();
    }

    private static String hex(byte[] bytes) {
        StringBuilder builder = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) builder.append(String.format("%02x", value & 0xff));
        return builder.toString();
    }

    private static String hostOf(String url) {
        try {
            String host = new URL(url).getHost();
            return host == null ? "" : host.toLowerCase(Locale.ROOT);
        } catch (Exception error) {
            return "";
        }
    }

    private static boolean sameSite(String host, String origin) {
        if (host == null || host.isEmpty() || origin == null || origin.isEmpty()) return false;
        return host.equals(origin) || host.endsWith("." + origin) || origin.endsWith("." + host);
    }

    private static String baseOf(String url) {
        try {
            URL parsed = new URL(url);
            return parsed.getProtocol() + "://" + parsed.getHost() + (parsed.getPort() > 0 ? ":" + parsed.getPort() : "");
        } catch (Exception error) {
            return "";
        }
    }

    /** 从网关地址里取回会话 token，用于播完回收。 */
    private static String tokenOf(String url) {
        if (url == null || !url.startsWith("http://127.0.0.1:")) return null;
        try {
            String path = new URL(url).getPath();
            String[] parts = path.replaceAll("^/+", "").split("/");
            return parts.length >= 1 && !parts[0].isEmpty() ? parts[0] : null;
        } catch (Exception error) {
            return null;
        }
    }
}
