package com.veyra.gybeyond.localsrc;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

import okhttp3.Headers;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.ResponseBody;

/**
 * 私密源的本机取数底座。
 *
 * 这一层存在的唯一理由：这些源站把「机房 IP」和「被墙」当成两种拒绝理由，
 * 用户的后端在国内机房时，剧果 / 黄果旧版 / 黄豆 / 帝果会成片 ECONNRESET 或超时，
 * 而同一台手机上装着 VPN 却能通。所以取数必须发生在手机上 —— 后端不参与，
 * 出去的包走用户自己的网络（或者 VPN 的 TUN）。
 *
 * 只依赖 OkHttp + JDK 标准库，不碰 Android API：同一份代码可以在桌面上用
 * javac 直接跑，协议改一次就能先在本机验证再去打 APK。
 */
public final class Net {

    /** 一次请求的结果：状态码、响应头、原始字节。 */
    public static final class Res {
        public final int status;
        public final byte[] body;
        public final Headers headers;
        public final String url;

        Res(int status, byte[] body, Headers headers, String url) {
            this.status = status;
            this.body = body;
            this.headers = headers;
            this.url = url;
        }

        public String text() {
            return new String(body, java.nio.charset.StandardCharsets.UTF_8);
        }

        /** 取某个响应头的全部值（Set-Cookie 会有多条）。 */
        public List<String> all(String name) {
            return headers.values(name);
        }

        public String header(String name) {
            String value = headers.get(name);
            return value == null ? "" : value;
        }
    }

    private static volatile OkHttpClient plain;
    private static volatile OkHttpClient relaxed;

    private Net() { }

    /** 常规客户端：校验证书。 */
    public static OkHttpClient client() {
        if (plain == null) {
            synchronized (Net.class) {
                if (plain == null) plain = baseBuilder().build();
            }
        }
        return plain;
    }

    /**
     * 统一走 HTTP/1.1。
     *
     * 不是为了兼容老服务器，而是 HTTP/2 下 OkHttp 会按 RFC 7540 §8.1.2.5 把一条
     * Cookie 头拆成多个 cookie 帧，CloudFront 只认其中的第一个 —— 剧果的
     * CloudFront-Policy / Signature / Key-Pair-Id 三个签名 cookie 拆开后，
     * 清单能过、子清单直接 403 AccessDenied。同样的 cookie 用 HTTP/1.1 发就正常。
     */
    private static OkHttpClient.Builder baseBuilder() {
        return new OkHttpClient.Builder()
                .protocols(java.util.Collections.singletonList(okhttp3.Protocol.HTTP_1_1))
                .connectTimeout(12, java.util.concurrent.TimeUnit.SECONDS)
                .readTimeout(20, java.util.concurrent.TimeUnit.SECONDS)
                .writeTimeout(20, java.util.concurrent.TimeUnit.SECONDS);
    }

    /**
     * 不校验证书的客户端。
     *
     * 黄豆的备份线 xqjurgek.top 证书早已过期，黄果旧版的前端站也会偶发证书链不全。
     * 这里只取公开剧集数据、不带任何账号凭证，所以放行 —— 和 guoapp 的做法一致。
     */
    public static OkHttpClient relaxed() {
        if (relaxed == null) {
            synchronized (Net.class) {
                if (relaxed == null) {
                    try {
                        TrustManager[] trustAll = new TrustManager[]{new X509TrustManager() {
                            @Override public void checkClientTrusted(java.security.cert.X509Certificate[] chain, String authType) { }
                            @Override public void checkServerTrusted(java.security.cert.X509Certificate[] chain, String authType) { }
                            @Override public java.security.cert.X509Certificate[] getAcceptedIssuers() {
                                return new java.security.cert.X509Certificate[0];
                            }
                        }};
                        SSLContext context = SSLContext.getInstance("TLS");
                        context.init(null, trustAll, new java.security.SecureRandom());
                        relaxed = client().newBuilder()
                                .sslSocketFactory(context.getSocketFactory(), (X509TrustManager) trustAll[0])
                                .hostnameVerifier((host, session) -> true)
                                .build();
                    } catch (Exception error) {
                        relaxed = client();
                    }
                }
            }
        }
        return relaxed;
    }

    public static Res get(String url, Map<String, String> headers, int timeoutMs, long maxBytes) throws IOException {
        return execute(new Request.Builder().url(url).headers(build(headers)).get().build(), timeoutMs, maxBytes, false);
    }

    public static Res getRelaxed(String url, Map<String, String> headers, int timeoutMs, long maxBytes) throws IOException {
        return execute(new Request.Builder().url(url).headers(build(headers)).get().build(), timeoutMs, maxBytes, true);
    }

    public static Res postJson(String url, Map<String, String> headers, String json, int timeoutMs, long maxBytes) throws IOException {
        RequestBody body = RequestBody.create(json == null ? "" : json,
                MediaType.parse("application/json; charset=utf-8"));
        return execute(new Request.Builder().url(url).headers(build(headers)).post(body).build(), timeoutMs, maxBytes, false);
    }

    public static Res postBytes(String url, Map<String, String> headers, byte[] payload, int timeoutMs, long maxBytes) throws IOException {
        RequestBody body = RequestBody.create(payload == null ? new byte[0] : payload,
                MediaType.parse("application/octet-stream"));
        return execute(new Request.Builder().url(url).headers(build(headers)).post(body).build(), timeoutMs, maxBytes, true);
    }

    /** 只取前 N 字节：封面 / 探测用，别把整张图读进内存。 */
    public static byte[] peek(String url, Map<String, String> headers, int timeoutMs, long maxBytes, boolean insecure) throws IOException {
        return execute(new Request.Builder().url(url).headers(build(headers)).get().build(), timeoutMs, maxBytes, insecure).body;
    }

    private static Headers build(Map<String, String> headers) {
        Headers.Builder builder = new Headers.Builder();
        if (headers != null) {
            for (Map.Entry<String, String> entry : headers.entrySet()) {
                if (entry.getKey() == null || entry.getValue() == null) continue;
                builder.add(entry.getKey(), entry.getValue());
            }
        }
        return builder.build();
    }

    private static Res execute(Request request, int timeoutMs, long maxBytes, boolean insecure) throws IOException {
        OkHttpClient base = insecure ? relaxed() : client();
        OkHttpClient client = base.newBuilder()
                .connectTimeout(timeoutMs > 0 ? timeoutMs : 12000, java.util.concurrent.TimeUnit.MILLISECONDS)
                .readTimeout(timeoutMs > 0 ? timeoutMs : 20000, java.util.concurrent.TimeUnit.MILLISECONDS)
                .callTimeout(timeoutMs > 0 ? timeoutMs : 20000, java.util.concurrent.TimeUnit.MILLISECONDS)
                .followRedirects(true)
                .build();
        try (okhttp3.Response response = client.newCall(request).execute()) {
            ResponseBody body = response.body();
            byte[] bytes = new byte[0];
            if (body != null) {
                if (maxBytes <= 0) maxBytes = 8L << 20;
                java.io.InputStream input = body.byteStream();
                java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
                byte[] chunk = new byte[16384];
                long total = 0;
                int read;
                while ((read = input.read(chunk)) > 0) {
                    output.write(chunk, 0, read);
                    total += read;
                    if (total >= maxBytes) break;
                }
                bytes = output.toByteArray();
            }
            return new Res(response.code(), bytes, response.headers(), request.url().toString());
        }
    }

    /* ---------------- 小工具 ---------------- */

    /** 有序 header 表（LinkedHashMap 在 Android 上是 API 1 就有的）。 */
    public static Map<String, String> headers(String... pairs) {
        Map<String, String> map = new LinkedHashMap<>();
        for (int i = 0; i + 1 < pairs.length; i += 2) {
            if (pairs[i] == null || pairs[i + 1] == null) continue;
            map.put(pairs[i], pairs[i + 1]);
        }
        return map;
    }

    /** 从 Set-Cookie 里挑出指定前缀的 cookie，拼成一条 Cookie 头。 */
    public static String cookieWithPrefix(Res res, String prefix) {
        StringBuilder out = new StringBuilder();
        for (String line : res.all("set-cookie")) {
            String pair = line.split(";")[0].trim();
            if (!pair.toLowerCase(Locale.ROOT).startsWith(prefix.toLowerCase(Locale.ROOT))) continue;
            if (out.length() > 0) out.append("; ");
            out.append(pair);
        }
        return out.toString();
    }

    /** 拼绝对地址：源站经常给相对路径。 */
    public static String absolute(String base, String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) return "";
        if (value.startsWith("//")) return "https:" + value;
        if (value.matches("(?i)^https?://.*")) return value;
        if (base == null || base.isEmpty()) return value;
        try {
            // 交给 URL 做相对解析：base 若是 .../master.m3u8，相对路径要落在同目录下。
            // 自己补斜杠会把 /hls/10362/master.m3u8/480/playlist.m3u8 拼出来，CloudFront 直接 403。
            return new java.net.URL(new java.net.URL(base), value).toString();
        } catch (Exception error) {
            return value;
        }
    }
}
