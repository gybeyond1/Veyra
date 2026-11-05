package com.veyra.gybeyond;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 局域网媒体服务：把手机自己下好的成品开放给同一 Wi-Fi 下的电视 / 电脑 / 其它手机。
 *
 * 协议与桌面端媒体服务保持一致，另外两端拿同一套代码就能播：
 *   GET /api/ping                         探活
 *   GET /api/tasks?t=<token>              任务摘要（带可播地址）
 *   GET /file/&lt;任务id&gt;/&lt;index&gt;?t=&lt;token&gt;  index=0 是合并成品，>0 是第 N 集，支持 Range
 *
 * 只用 ServerSocket，不引第三方框架；端口 8790 起顺延，最多试 20 个。
 * token 每次进程启动重新生成，随设备心跳上报给后端，别人拿到地址也播不了。
 */
final class LanMediaServer {
    private static final String TAG = "VeyraLanMedia";
    private static final int FIRST_PORT = 8790;
    private static final int LAST_PORT = 8809;
    private static final int MAX_TASKS = 30;

    private static volatile LanMediaServer instance;

    private final Context context;
    private final String token;
    private final ExecutorService pool = Executors.newFixedThreadPool(6, runnable -> {
        Thread thread = new Thread(runnable, "veyra-media");
        thread.setDaemon(true);
        return thread;
    });

    private volatile ServerSocket server;
    private volatile int port;

    private LanMediaServer(Context context) {
        this.context = context.getApplicationContext();
        byte[] bytes = new byte[16];
        new SecureRandom().nextBytes(bytes);
        StringBuilder builder = new StringBuilder();
        for (byte value : bytes) builder.append(String.format("%02x", value));
        this.token = builder.toString();
    }

    /** 懒启动：设备注册前调用一次即可，失败也不抛（只是别人播不了这台机器）。 */
    static synchronized LanMediaServer ensure(Context context) {
        if (instance != null && instance.port > 0) return instance;
        if (instance == null) instance = new LanMediaServer(context);
        instance.start();
        return instance;
    }

    JSONObject info() {
        JSONObject out = new JSONObject();
        try {
            String ip = LanTextRelay.resolveLanAddress();
            out.put("url", port > 0 && !ip.isEmpty() ? "http://" + ip + ":" + port : "");
            out.put("token", token);
            out.put("port", port);
        } catch (Exception ignored) { }
        return out;
    }

    private void start() {
        if (server != null || port > 0) return;
        for (int candidate = FIRST_PORT; candidate <= LAST_PORT; candidate++) {
            try {
                ServerSocket socket = new ServerSocket();
                socket.setReuseAddress(true);
                socket.bind(new InetSocketAddress(candidate), 50);
                server = socket;
                port = candidate;
                break;
            } catch (Exception ignored) {
                /* 端口被占：试下一个 */
            }
        }
        if (server == null) {
            Log.w(TAG, "没有可用端口，局域网播放不可用");
            return;
        }
        Log.i(TAG, "局域网媒体服务已启动，端口 " + port);
        Thread accept = new Thread(() -> {
            while (server != null && !server.isClosed()) {
                try {
                    final Socket socket = server.accept();
                    pool.execute(() -> handle(socket));
                } catch (Exception error) {
                    if (server != null && !server.isClosed()) Log.w(TAG, "accept 失败:" + error.getMessage());
                }
            }
        }, "veyra-media-accept");
        accept.setDaemon(true);
        accept.start();
    }

    void stop() {
        try {
            if (server != null) server.close();
        } catch (Exception ignored) { }
        server = null;
        port = 0;
    }

    // ---- 请求处理 ----

    private void handle(Socket socket) {
        try (Socket client = socket) {
            client.setSoTimeout(15000);
            InputStream in = new BufferedInputStream(client.getInputStream());
            OutputStream out = new BufferedOutputStream(client.getOutputStream());

            String requestLine = readLine(in);
            if (requestLine == null || requestLine.isEmpty()) return;
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) return;
            String method = parts[0];
            String target = parts[1];

            Map<String, String> headers = new LinkedHashMap<>();
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int colon = line.indexOf(':');
                if (colon > 0) {
                    headers.put(line.substring(0, colon).trim().toLowerCase(Locale.ROOT), line.substring(colon + 1).trim());
                }
            }

            boolean head = "HEAD".equalsIgnoreCase(method);
            if (!head && !"GET".equalsIgnoreCase(method)) {
                writeJson(out, 405, "{\"error\":\"method not allowed\"}", head);
                return;
            }

            URI uri = URI.create(target);
            String path = uri.getPath() == null ? "/" : uri.getPath();
            Map<String, String> query = parseQuery(uri.getRawQuery());

            if ("/api/ping".equals(path)) {
                writeJson(out, 200, "{\"ok\":true,\"name\":\"veyra-android\"}", head);
                return;
            }
            if (!token.equals(query.get("t"))) {
                writeJson(out, 401, "{\"error\":\"token 无效\"}", head);
                return;
            }
            if ("/api/tasks".equals(path)) {
                writeJson(out, 200, tasksJson().toString(), head);
                return;
            }
            if (path.startsWith("/file/")) {
                serveFile(out, path, headers, head);
                return;
            }
            writeJson(out, 404, "{\"error\":\"not found\"}", head);
        } catch (Exception error) {
            Log.w(TAG, "请求失败:" + error.getMessage());
        }
    }

    private JSONObject tasksJson() {
        JSONObject out = new JSONObject();
        JSONArray tasks = new JSONArray();
        String base = info().optString("url", "");
        try {
            JSONArray all = DownloadManager.get(context).listAll();
            for (int i = 0; i < all.length() && i < MAX_TASKS; i++) {
                JSONObject task = all.optJSONObject(i);
                if (task == null) continue;
                String id = task.optString("id");
                if (id.isEmpty()) continue;
                boolean merged = hasMerged(id);
                tasks.put(new JSONObject()
                        .put("id", id)
                        .put("title", task.optString("title"))
                        .put("cover", task.optString("cover"))
                        .put("status", task.optString("status"))
                        .put("percent", task.optInt("percent"))
                        .put("doneCount", task.optInt("doneCount"))
                        .put("totalCount", task.optInt("totalCount"))
                        .put("episodeCount", task.optInt("totalCount"))
                        .put("merged", merged)
                        .put("url", base.isEmpty() || !merged ? "" : base + "/file/" + id + "/0?t=" + token));
            }
            out.put("device", base).put("tasks", tasks);
        } catch (Exception error) {
            Log.w(TAG, "任务摘要失败:" + error.getMessage());
        }
        return out;
    }

    private boolean hasMerged(String id) {
        try {
            String merged = DownloadManager.get(context).localFilesAny(id).optString("merged", "");
            return !merged.isEmpty() && new File(merged).exists();
        } catch (Exception ignored) {
            return false;
        }
    }

    private void serveFile(OutputStream out, String path, Map<String, String> headers, boolean head) throws Exception {
        String[] segments = path.split("/");
        // ["", "file", id, index]
        if (segments.length < 4) {
            writeJson(out, 400, "{\"error\":\"地址无效\"}", head);
            return;
        }
        String id = URLDecoder.decode(segments[2], "UTF-8");
        int index;
        try {
            index = Integer.parseInt(segments[3]);
        } catch (Exception error) {
            writeJson(out, 400, "{\"error\":\"集数无效\"}", head);
            return;
        }
        File file = resolve(id, index);
        if (file == null || !file.exists() || file.length() <= 0) {
            writeJson(out, 404, "{\"error\":\"文件还没下载好\"}", head);
            return;
        }

        long size = file.length();
        long start = 0;
        long end = size - 1;
        boolean partial = false;
        String range = headers.get("range");
        if (range != null && range.startsWith("bytes=")) {
            String spec = range.substring(6);
            int dash = spec.indexOf('-');
            if (dash >= 0) {
                String from = spec.substring(0, dash).trim();
                String to = spec.substring(dash + 1).trim();
                try {
                    start = from.isEmpty() ? 0 : Long.parseLong(from);
                    end = to.isEmpty() ? size - 1 : Math.min(Long.parseLong(to), size - 1);
                    partial = true;
                } catch (NumberFormatException ignored) {
                    start = 0;
                    end = size - 1;
                    partial = false;
                }
            }
        }
        if (start >= size || start > end) {
            write(out, "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */" + size + "\r\nConnection: close\r\n\r\n", head);
            return;
        }

        StringBuilder head2 = new StringBuilder();
        head2.append(partial ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n");
        head2.append("Content-Type: video/mp4\r\n");
        head2.append("Accept-Ranges: bytes\r\n");
        head2.append("Content-Length: ").append(end - start + 1).append("\r\n");
        if (partial) head2.append("Content-Range: bytes ").append(start).append('-').append(end).append('/').append(size).append("\r\n");
        head2.append("Access-Control-Allow-Origin: *\r\n");
        head2.append("Connection: close\r\n\r\n");
        out.write(head2.toString().getBytes(StandardCharsets.UTF_8));
        if (head) {
            out.flush();
            return;
        }

        try (RandomAccessFile raf = new RandomAccessFile(file, "r")) {
            raf.seek(start);
            byte[] buffer = new byte[64 * 1024];
            long remaining = end - start + 1;
            while (remaining > 0) {
                int want = (int) Math.min(buffer.length, remaining);
                int read = raf.read(buffer, 0, want);
                if (read < 0) break;
                out.write(buffer, 0, read);
                remaining -= read;
            }
        }
        out.flush();
    }

    private File resolve(String id, int index) {
        try {
            JSONObject files = DownloadManager.get(context).localFilesAny(id);
            if (index <= 0) {
                String merged = files.optString("merged", "");
                return merged.isEmpty() ? null : new File(merged);
            }
            JSONArray episodes = files.optJSONArray("episodes");
            for (int i = 0; episodes != null && i < episodes.length(); i++) {
                JSONObject episode = episodes.optJSONObject(i);
                if (episode != null && episode.optInt("index") == index) {
                    return new File(episode.optString("path", ""));
                }
            }
        } catch (Exception ignored) { }
        return null;
    }

    // ---- 极简 HTTP 工具 ----

    private static String readLine(InputStream in) {
        StringBuilder builder = new StringBuilder();
        int value;
        try {
            while ((value = in.read()) != -1) {
                if (value == '\n') break;
                if (value != '\r') builder.append((char) value);
                if (builder.length() > 8192) break;
            }
        } catch (Exception error) {
            return null;
        }
        if (value == -1 && builder.length() == 0) return null;
        return builder.toString();
    }

    private static Map<String, String> parseQuery(String raw) {
        Map<String, String> out = new LinkedHashMap<>();
        if (raw == null || raw.isEmpty()) return out;
        for (String pair : raw.split("&")) {
            int eq = pair.indexOf('=');
            try {
                if (eq < 0) out.put(URLDecoder.decode(pair, "UTF-8"), "");
                else out.put(URLDecoder.decode(pair.substring(0, eq), "UTF-8"), URLDecoder.decode(pair.substring(eq + 1), "UTF-8"));
            } catch (Exception ignored) { }
        }
        return out;
    }

    private static void writeJson(OutputStream out, int status, String body, boolean head) throws Exception {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        String reason = status == 200 ? "OK" : status == 401 ? "Unauthorized" : status == 404 ? "Not Found"
                : status == 400 ? "Bad Request" : status == 405 ? "Method Not Allowed" : "Error";
        String header = "HTTP/1.1 " + status + " " + reason + "\r\n"
                + "Content-Type: application/json; charset=utf-8\r\n"
                + "Content-Length: " + bytes.length + "\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Connection: close\r\n\r\n";
        out.write(header.getBytes(StandardCharsets.UTF_8));
        if (!head) out.write(bytes);
        out.flush();
    }

    private static void write(OutputStream out, String text, boolean head) throws Exception {
        out.write(text.getBytes(StandardCharsets.UTF_8));
        out.flush();
    }
}
