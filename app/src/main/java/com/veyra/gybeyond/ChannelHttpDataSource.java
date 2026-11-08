package com.veyra.gybeyond;

import android.net.Uri;

import androidx.annotation.Nullable;
import androidx.media3.common.C;
import androidx.media3.datasource.BaseDataSource;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.HttpDataSource;

import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URL;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 黄果 HLS 播放数据源（仅黄果 m3u8 走本实现；红果 MP4 仍走 HongguoPlayback 直连）。
 *
 * - 代理模式（MODE_PROXY）时经配置的 HTTP 代理拉取 manifest 与分片；其余模式直连系统栈。
 * - 自动携带 UA 与 Referer（https://host/）以规避源站风控；5s 连接/读取超时。
 * - 自动跟随重定向；支持 Range（进度拖动时服务端按分片返回，位置跳过兜底）。
 */
final class ChannelHttpDataSource extends BaseDataSource implements HttpDataSource {
    static final int TIMEOUT_MS = 5_000;
    private static final String UA = "Mozilla/5.0 (Linux; Android) HuangGuo/0.1";

    private final String address;                  // "host:port"，null/空 = 直连
    private final Map<String, String> properties = new HashMap<>();
    /* 直连模式下的源站凭据（Referer / Cookie / UA），由后端 episode 接口下发，见 MediaRequestContext */
    private final Map<String, String> mediaHeaders;
    private final String mediaSite;
    private HttpURLConnection connection;
    private InputStream stream;
    private boolean opened;
    private int responseCode;
    private Map<String, List<String>> responseHeaders;
    private long bytesToSkip;
    private long bytesRemaining;
    private Uri uri;
    @Nullable private DataSpec lastSpec;

    ChannelHttpDataSource(String address) {
        this(address, null, "");
    }

    ChannelHttpDataSource(String address, @Nullable Map<String, String> mediaHeaders, @Nullable String mediaSite) {
        super(true);
        this.address = address;
        this.mediaHeaders = mediaHeaders == null ? java.util.Collections.emptyMap() : mediaHeaders;
        this.mediaSite = mediaSite == null ? "" : mediaSite;
    }

    static HttpDataSource.Factory factory(@Nullable String address) {
        return new Factory(address);
    }

    @Override
    public long open(DataSpec spec) throws HttpDataSourceException {
        transferInitializing(spec);
        this.uri = spec.uri;
        this.lastSpec = spec;
        this.responseCode = 0;
        this.responseHeaders = null;
        try {
            connection = openConnection(spec);
            int code = connection.getResponseCode();
            responseCode = code;
            responseHeaders = connection.getHeaderFields();
            if (code < 200 || code > 299) {
                // 服务端不支持 Range（416）时从头重试，保证 manifest/分片可读
                if (code == 416 && spec.position > 0) {
                    closeConnectionQuietly();
                    DataSpec retry = new DataSpec.Builder()
                            .setUri(spec.uri).setPosition(0).setLength(C.LENGTH_UNSET).build();
                    connection = openConnection(retry);
                    code = connection.getResponseCode();
                    responseCode = code;
                    responseHeaders = connection.getHeaderFields();
                }
                if (code < 200 || code > 299) {
                    throw new HttpDataSourceException("站点播放请求失败（HTTP " + code + "）", spec, HttpDataSourceException.TYPE_OPEN);
                }
            }
            stream = connection.getInputStream();
            opened = true;
            bytesToSkip = spec.position;
            long contentLength = -1;
            try { contentLength = Long.parseLong(connection.getHeaderField("Content-Length")); } catch (Exception ignored) { }
            if (spec.length != C.LENGTH_UNSET) {
                bytesRemaining = Math.max(0, spec.length - bytesToSkip);
            } else if (contentLength >= 0) {
                bytesRemaining = contentLength;
            } else {
                bytesRemaining = Long.MAX_VALUE;   // chunked 流读到 EOF
            }
            transferStarted(spec);
            return bytesRemaining == Long.MAX_VALUE ? C.LENGTH_UNSET : bytesRemaining;
        } catch (HttpDataSourceException error) {
            throw error;
        } catch (IOException error) {
            throw HttpDataSourceException.createForIOException(error, spec, HttpDataSourceException.TYPE_OPEN);
        }
    }

    private HttpURLConnection openConnection(DataSpec spec) throws IOException {
        URL url = new URL(uri.toString());
        Proxy proxy = null;
        if (address != null && !address.isEmpty()) {
            String[] parts = address.split(":");
            String host = parts.length > 0 && !parts[0].isEmpty() ? parts[0] : "127.0.0.1";
            int port = 80;
            if (parts.length > 1) {
                try { port = Integer.parseInt(parts[1]); } catch (NumberFormatException ignored) { }
            }
            proxy = new Proxy(Proxy.Type.HTTP, new InetSocketAddress(host, port));
        }
        HttpURLConnection conn = proxy == null
                ? (HttpURLConnection) url.openConnection()
                : (HttpURLConnection) url.openConnection(proxy);
        conn.setConnectTimeout(TIMEOUT_MS);
        conn.setReadTimeout(TIMEOUT_MS);
        conn.setUseCaches(false);
        conn.setInstanceFollowRedirects(true);
        String agent = mediaHeaders.get("User-Agent");
        conn.setRequestProperty("User-Agent", agent == null || agent.isEmpty() ? UA : agent);
        String host = url.getHost();
        // 本机播放网关自己会补 Referer，别在这儿塞一个 127.0.0.1 上去
        boolean local = host != null && (host.equals("127.0.0.1") || host.equalsIgnoreCase("localhost"));
        String referer = mediaHeaders.get("Referer");
        if (referer != null && !referer.isEmpty()) {
            conn.setRequestProperty("Referer", referer);
        } else if (!local && host != null && !host.isEmpty()) {
            conn.setRequestProperty("Referer", "https://" + host + "/");
        }
        // Cookie 只回源站：分片换到别的 CDN 时带过去反而会被判非法请求
        String cookie = mediaHeaders.get("Cookie");
        if (cookie != null && !cookie.isEmpty() && MediaRequestContext.sameSite(host, mediaSite)) {
            conn.setRequestProperty("Cookie", cookie);
        }
        conn.setRequestProperty("Accept", "*/*");
        if (spec.position > 0) conn.setRequestProperty("Range", "bytes=" + spec.position + "-");
        for (Map.Entry<String, String> entry : properties.entrySet()) {
            conn.setRequestProperty(entry.getKey(), entry.getValue());
        }
        if (spec.httpRequestHeaders != null) {
            for (Map.Entry<String, String> entry : spec.httpRequestHeaders.entrySet()) {
                conn.setRequestProperty(entry.getKey(), entry.getValue());
            }
        }
        return conn;
    }

    @Override
    public int read(byte[] buffer, int offset, int length) throws HttpDataSourceException {
        if (length == 0) return 0;
        if (bytesRemaining == 0) return C.RESULT_END_OF_INPUT;
        if (bytesToSkip > 0) {
            long skipped;
            try { skipped = stream.skip(bytesToSkip); } catch (IOException error) { skipped = 0; }
            bytesToSkip -= skipped;
            if (bytesToSkip > 0) {
                // 服务端忽略 Range 且无法跳过时按 EOF 处理
                bytesRemaining = 0;
                return C.RESULT_END_OF_INPUT;
            }
        }
        try {
            int count = stream.read(buffer, offset, length);
            if (count == -1) { bytesRemaining = 0; return C.RESULT_END_OF_INPUT; }
            if (bytesRemaining != Long.MAX_VALUE) bytesRemaining -= count;
            bytesTransferred(count);
            return count;
        } catch (IOException error) {
            throw HttpDataSourceException.createForIOException(error, lastSpec, HttpDataSourceException.TYPE_READ);
        }
    }

    @Override
    public Uri getUri() {
        return connection == null ? uri : Uri.parse(connection.getURL().toString());
    }

    @Override
    public void close() throws HttpDataSourceException {
        try {
            if (stream != null) stream.close();
        } catch (IOException error) {
            throw HttpDataSourceException.createForIOException(error, lastSpec, HttpDataSourceException.TYPE_CLOSE);
        } finally {
            stream = null;
            if (connection != null) connection.disconnect();
            connection = null;
            if (opened) { opened = false; transferEnded(); }
        }
    }

    private void closeConnectionQuietly() {
        if (stream != null) { try { stream.close(); } catch (IOException ignored) { } stream = null; }
        if (connection != null) { connection.disconnect(); connection = null; }
    }

    @Override public void setRequestProperty(String name, String value) { properties.put(name, value); }
    @Override public void clearRequestProperty(String name) { properties.remove(name); }
    @Override public void clearAllRequestProperties() { properties.clear(); }
    @Override public int getResponseCode() { return responseCode; }
    @Override public Map<String, List<String>> getResponseHeaders() { return responseHeaders; }

    static final class Factory implements HttpDataSource.Factory {
        private final String address;
        private final Map<String, String> defaultProperties = new HashMap<>();
        private Map<String, String> mediaHeaders = java.util.Collections.emptyMap();
        private String mediaSite = "";

        Factory(@Nullable String address) { this.address = address; }

        /** 直连源站时贴上去的凭据；每次开播前由 VideoPlaybackCache 重新取一次。 */
        Factory setMediaHeaders(@Nullable Map<String, String> headers, @Nullable String site) {
            mediaHeaders = headers == null ? java.util.Collections.emptyMap() : headers;
            mediaSite = site == null ? "" : site;
            return this;
        }

        @Override
        public HttpDataSource.Factory setDefaultRequestProperties(Map<String, String> properties) {
            defaultProperties.clear();
            if (properties != null) defaultProperties.putAll(properties);
            return this;
        }

        @Override
        public ChannelHttpDataSource createDataSource() {
            ChannelHttpDataSource source = new ChannelHttpDataSource(address, mediaHeaders, mediaSite);
            source.properties.putAll(defaultProperties);
            return source;
        }
    }
}
