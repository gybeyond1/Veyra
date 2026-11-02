package com.veyra.gybeyond;

import org.apache.commons.net.ftp.FTP;
import org.apache.commons.net.ftp.FTPClient;
import org.apache.commons.net.ftp.FTPReply;
import org.apache.commons.net.ftp.FTPSClient;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.cert.X509Certificate;
import java.time.Duration;

import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * FTP / FTPS 上传（Apache Commons Net）。
 *
 * 默认走被动模式 + 二进制 + UTF-8（中文剧名必需），FTPS 是显式 AUTH TLS（端口通常还是 21，
 * 只有选「隐式 TLS」的服务器才用 990 —— 这里按用户在端口里填的来，不猜）。
 */
final class FtpRemoteClient extends RemoteClient {
    private final String host;
    private final int port;
    private final String user;
    private final String pass;
    private final String basePath;
    private final boolean secure;
    private final boolean insecure;

    private FTPClient ftp;
    /** open() 之后停在的 basePath（每次上传完都回到这里，避免连续上传时目录漂移） */
    private String baseHome = "";

    FtpRemoteClient(JSONObject server) {
        this.host = server.optString("host", "");
        this.port = server.optInt("port", 21);
        this.user = server.optString("user", "");
        this.pass = server.optString("pass", "");
        this.basePath = server.optString("path", "");
        this.secure = server.optBoolean("secure", false);
        this.insecure = server.optBoolean("insecure", true);
    }

    @Override
    void open() throws Exception {
        FTPClient client;
        if (secure) {
            FTPSClient tls = new FTPSClient(false);
            if (insecure) tls.setTrustManager(trustAll());
            client = tls;
        } else {
            client = new FTPClient();
        }
        client.setConnectTimeout(15000);
        client.setDefaultTimeout(20000);
        client.setDataTimeout(Duration.ofSeconds(120));
        client.setControlKeepAliveTimeout(Duration.ofSeconds(20));
        client.setControlEncoding("UTF-8");
        client.setAutodetectUTF8(true);
        client.connect(host, port);
        if (!FTPReply.isPositiveCompletion(client.getReplyCode())) {
            String reply = firstLine(client.getReplyString());
            try { client.disconnect(); } catch (Exception ignored) { }
            throw new IOException("服务器拒绝连接：" + reply);
        }
        boolean logged = user.isEmpty() ? client.login("anonymous", "anonymous@") : client.login(user, pass);
        if (!logged) {
            String reply = firstLine(client.getReplyString());
            try { client.disconnect(); } catch (Exception ignored) { }
            throw new IOException("登录失败：" + reply);
        }
        if (secure) {
            FTPSClient tls = (FTPSClient) client;
            tls.execPBSZ(0);
            tls.execPROT("P");
        }
        client.setFileType(FTP.BINARY_FILE_TYPE);
        client.enterLocalPassiveMode();
        ftp = client;
        if (!segments(basePath).isEmpty()) enterPath(basePath, true);
        // 记住 basePath 的绝对位置：上传时进剧目目录，传完再回来
        String home = client.printWorkingDirectory();
        baseHome = home == null ? "" : home;
    }

    @Override
    void ensureDir(String relative) throws Exception {
        if (relative == null || relative.isEmpty()) return;
        // 始终从 basePath 出发：否则连着建两级目录会越嵌越深（之前在打开的那级里再建同名目录）
        home();
        enterPath(relative, true);
        home();
    }

    @Override
    void upload(File file, String dir, String name, Progress progress) throws Exception {
        home();
        if (dir != null && !dir.isEmpty()) enterPath(dir, true);
        try (InputStream in = new FileInputStream(file);
             InputStream counted = progress == null ? in : new CountingStream(in, progress)) {
            boolean ok = ftp.storeFile(name, counted);   // 内部已 completePendingCommand
            if (!ok) throw new IOException("上传失败：" + firstLine(ftp.getReplyString()));
        } finally {
            // 无论成败都回到 basePath，否则下一集会被写进上一集的目录
            home();
        }
    }

    @Override
    void verify() throws Exception {
        if (!ftp.sendNoOp()) throw new IOException("服务器无响应");
        if (ftp.printWorkingDirectory() == null) throw new IOException("无法进入目标目录：" + target());
    }

    @Override
    long size(String dir, String name) throws Exception {
        home();
        if (dir != null && !dir.isEmpty()) enterPath(dir, true);
        try {
            // 二进制模式下 SIZE 给的就是字节数；服务器不支持/文件不存在时返回 null
            String raw = ftp.getSize(name);
            if (raw == null) return -1;
            try { return Long.parseLong(raw.trim()); } catch (Exception error) { return -1; }
        } finally {
            home();
        }
    }

    @Override
    public void close() {
        if (ftp != null) {
            try { if (ftp.isConnected()) ftp.logout(); } catch (Exception ignored) { }
            try { if (ftp.isConnected()) ftp.disconnect(); } catch (Exception ignored) { }
            ftp = null;
        }
    }

    @Override
    String target() {
        return (secure ? "ftps://" : "ftp://") + host + ":" + port + basePath;
    }

    /** 回到 basePath；没设置（根目录）就什么都不做。 */
    private void home() {
        if (baseHome.isEmpty()) return;
        try { ftp.changeWorkingDirectory(baseHome); } catch (Exception ignored) { }
    }

    /** 逐级 cd，缺哪级就建哪级。 */
    private void enterPath(String path, boolean create) throws IOException {
        for (String seg : segments(path)) {
            if (ftp.changeWorkingDirectory(seg)) continue;
            if (!create) throw new IOException("远程目录不存在：" + path);
            if (!ftp.makeDirectory(seg)) {
                // 并发/权限导致的「已经存在」也算成功，再试一次进入
                if (!ftp.changeWorkingDirectory(seg)) {
                    throw new IOException("无法创建远程目录 " + seg + "：" + firstLine(ftp.getReplyString()));
                }
                continue;
            }
            if (!ftp.changeWorkingDirectory(seg)) {
                throw new IOException("无法进入远程目录 " + seg + "：" + firstLine(ftp.getReplyString()));
            }
        }
    }

    private static String firstLine(String reply) {
        if (reply == null) return "";
        String text = reply.trim();
        int cut = text.indexOf('\n');
        return cut > 0 ? text.substring(0, cut).trim() : text;
    }

    private static TrustManager trustAll() {
        return new X509TrustManager() {
            @Override public void checkClientTrusted(X509Certificate[] chain, String authType) { }
            @Override public void checkServerTrusted(X509Certificate[] chain, String authType) { }
            @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        };
    }

    private static final class CountingStream extends FilterInputStream {
        private final Progress progress;
        CountingStream(InputStream in, Progress progress) { super(in); this.progress = progress; }

        @Override public int read() throws IOException {
            int b = super.read();
            if (b >= 0) progress.add(1);
            return b;
        }

        @Override public int read(byte[] b, int off, int len) throws IOException {
            int n = super.read(b, off, len);
            if (n > 0) progress.add(n);
            return n;
        }
    }
}
