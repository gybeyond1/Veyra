package com.veyra.gybeyond;

import okhttp3.Credentials;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.BufferedSink;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * WebDAV 上传：MKCOL 建目录 + PUT 写文件，Basic 认证。
 * 家用 NAS 的 WebDAV（群晖/威联通/绿联/Alist）基本都是这套，够用。
 */
final class WebDavRemoteClient extends RemoteClient {
    private static final MediaType OCTET = MediaType.parse("application/octet-stream");

    private final String host;
    private final int port;
    private final String user;
    private final String pass;
    private final String basePath;
    private final boolean secure;
    private final boolean insecure;

    private OkHttpClient http;
    private HttpUrl root;
    private List<String> baseSegments = new ArrayList<>();

    WebDavRemoteClient(JSONObject server) {
        this.host = server.optString("host", "");
        this.port = server.optInt("port", 80);
        this.user = server.optString("user", "");
        this.pass = server.optString("pass", "");
        this.basePath = server.optString("path", "");
        this.secure = server.optBoolean("secure", false);
        this.insecure = server.optBoolean("insecure", true);
    }

    @Override
    void open() throws Exception {
        OkHttpClient.Builder builder = new OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .writeTimeout(180, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true);
        if (insecure) {
            final X509TrustManager trustAll = new X509TrustManager() {
                @Override public void checkClientTrusted(X509Certificate[] chain, String authType) { }
                @Override public void checkServerTrusted(X509Certificate[] chain, String authType) { }
                @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
            };
            SSLContext ssl = SSLContext.getInstance("TLS");
            ssl.init(null, new TrustManager[]{trustAll}, new SecureRandom());
            builder.sslSocketFactory(ssl.getSocketFactory(), trustAll);
            builder.hostnameVerifier((hostname, session) -> true);
        }
        http = builder.build();
        HttpUrl.Builder url = new HttpUrl.Builder().scheme(secure ? "https" : "http").host(host).port(port);
        root = url.build();
        baseSegments = segments(basePath);
    }

    @Override
    void ensureDir(String relative) throws Exception {
        List<String> all = new ArrayList<>(baseSegments);
        all.addAll(segments(relative));
        for (int i = 1; i <= all.size(); i++) {
            HttpUrl.Builder b = root.newBuilder();
            for (int k = 0; k < i; k++) b.addPathSegment(all.get(k));
            mkcol(b.build());
        }
    }

    @Override
    void upload(File file, String dir, String name, Progress progress) throws Exception {
        HttpUrl.Builder b = root.newBuilder();
        for (String seg : baseSegments) b.addPathSegment(seg);
        for (String seg : segments(dir)) b.addPathSegment(seg);
        b.addPathSegment(name);
        Request request = authorized(new Request.Builder().url(b.build()).put(stream(file, progress)));
        try (Response response = http.newCall(request).execute()) {
            if (!response.isSuccessful()) throw failure(response, "上传 " + name);
        }
    }

    @Override
    long size(String dir, String name) throws Exception {
        HttpUrl.Builder b = root.newBuilder();
        for (String seg : baseSegments) b.addPathSegment(seg);
        for (String seg : segments(dir)) b.addPathSegment(seg);
        b.addPathSegment(name);
        HttpUrl url = b.build();
        // 先 HEAD 拿 Content-Length；有的 WebDAV 实现不给 HEAD（405/501），退一步用 Range 取一个字节，
        // 从 Content-Range 的 "/总长" 里读总大小。
        Request head = authorized(new Request.Builder().url(url).head());
        try (Response response = http.newCall(head).execute()) {
            if (response.isSuccessful()) {
                String len = response.header("Content-Length");
                if (len != null) { try { return Long.parseLong(len.trim()); } catch (Exception ignored) { } }
            } else if (response.code() != 405 && response.code() != 501) {
                return -1;
            }
        }
        Request ranged = authorized(new Request.Builder().url(url).header("Range", "bytes=0-0").get());
        try (Response response = http.newCall(ranged).execute()) {
            String range = response.header("Content-Range");
            if (range == null) return -1;
            int slash = range.lastIndexOf('/');
            if (slash < 0) return -1;
            try { return Long.parseLong(range.substring(slash + 1).trim()); } catch (Exception ignored) { return -1; }
        }
    }

    @Override
    void verify() throws Exception {
        // 能 MKCOL 到目标目录 = 地址对、账号对、有写权限
        ensureDir("");
        HttpUrl.Builder b = root.newBuilder();
        for (String seg : baseSegments) b.addPathSegment(seg);
        Request request = authorized(new Request.Builder().url(b.build()).head());
        try (Response response = http.newCall(request).execute()) {
            int code = response.code();
            if (code == 401) throw new IOException("用户名或密码错误（401）");
            if (code == 403) throw new IOException("没有访问权限（403）");
            if (code == 404) throw new IOException("远程目录不存在（404）");
        }
    }

    @Override
    public void close() {
        if (http != null) {
            try { http.dispatcher().executorService().shutdown(); } catch (Exception ignored) { }
            try { http.connectionPool().evictAll(); } catch (Exception ignored) { }
            http = null;
        }
    }

    @Override
    String target() {
        String scheme = secure ? "https" : "http";
        boolean defaultPort = port == (secure ? 443 : 80);
        return scheme + "://" + host + (defaultPort ? "" : ":" + port) + basePath;
    }

    // ---- 内部 ----

    private void mkcol(HttpUrl url) throws IOException {
        Request request = authorized(new Request.Builder().url(url).method("MKCOL", RequestBody.create(null, new byte[0])));
        try (Response response = http.newCall(request).execute()) {
            int code = response.code();
            // 201 新建成功；405 = 已存在（WebDAV 规范里就是这样报的）；200/204 个别实现建好后回 2xx
            if (code == 201 || code == 200 || code == 204 || code == 405) return;
            throw failure(response, "创建目录");
        }
    }

    private Request authorized(Request.Builder builder) {
        if (!user.isEmpty() || !pass.isEmpty()) {
            builder.header("Authorization", Credentials.basic(user, pass, StandardCharsets.UTF_8));
        }
        return builder.header("User-Agent", "Veyra-Android").build();
    }

    /** 流式上传：边读边写边报进度，不把整部剧读进内存。 */
    private RequestBody stream(final File file, final Progress progress) {
        return new RequestBody() {
            @Override public MediaType contentType() { return OCTET; }
            @Override public long contentLength() { return file.length(); }
            @Override public void writeTo(BufferedSink sink) throws IOException {
                try (InputStream in = new FileInputStream(file)) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        sink.write(buf, 0, n);
                        if (progress != null) progress.add(n);
                    }
                }
            }
        };
    }

    private IOException failure(Response response, String what) {
        String body = "";
        try {
            ResponseBody error = response.body();
            if (error != null) body = error.string();
        } catch (Exception ignored) { }
        if (body.length() > 160) body = body.substring(0, 160) + "…";
        int code = response.code();
        String hint;
        switch (code) {
            case 401: hint = "用户名或密码错误（401）"; break;
            case 403: hint = "没有写入权限（403）"; break;
            case 404: hint = "远程目录不存在（404）"; break;
            case 409: hint = "上级目录不存在（409），请检查远程目录设置"; break;
            case 507: hint = "服务器空间不足（507）"; break;
            default: hint = "服务器返回 " + code + (body.isEmpty() ? "" : "：" + body); break;
        }
        return new IOException(what + "失败：" + hint);
    }
}
