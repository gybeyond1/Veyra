package com.veyra.gybeyond;

import org.json.JSONObject;

import java.io.Closeable;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.List;

/**
 * 远程服务器写入的抽象：SMB / WebDAV / FTP 三套实现都只做三件事 ——
 * 建目录、传文件、验连接。上层（RemoteTransfer）不关心协议差异。
 *
 * 目录结构约定：basePath/<剧名>/<文件名>，剧名目录由调用方传入，客户端只负责逐级创建。
 */
abstract class RemoteClient implements Closeable {
    /** 传输进度回调：只回增量字节，由上层自己累计。 */
    interface Progress {
        void add(long bytes);
    }

    /** 连接 + 定位到 basePath（不存在则创建）。 */
    abstract void open() throws Exception;

    /** 相对 basePath 建目录（可多级）。 */
    abstract void ensureDir(String relative) throws Exception;

    /** 把本地文件写成「相对 basePath 的 dir 目录 + name」（同名覆盖）。 */
    abstract void upload(File file, String dir, String name, Progress progress) throws Exception;

    /** 远端文件大小（字节）。传完拿它跟本地比一次，对得上才敢删本地；返回 -1 = 协议/服务器不给。 */
    abstract long size(String dir, String name) throws Exception;

    /** 连通性 + 写权限自检（测试连接用）。 */
    abstract void verify() throws Exception;

    /** 目标地址（日志/错误提示用）。 */
    abstract String target();

    static RemoteClient create(JSONObject server) throws Exception {
        String type = server.optString("type", "");
        if (RemoteStore.TYPE_SMB.equals(type)) return new SmbRemoteClient(server);
        if (RemoteStore.TYPE_FTP.equals(type)) return new FtpRemoteClient(server);
        if (RemoteStore.TYPE_WEBDAV.equals(type)) return new WebDavRemoteClient(server);
        throw new IllegalArgumentException("不支持的服务器类型：" + type);
    }

    // ---- 公共工具 ----

    /** 剧名/文件名里不能出现的字符按文件系统惯例换掉，空白也压掉，避免远端出现奇怪目录。 */
    static String sanitize(String raw, String fallback) {
        String name = raw == null ? "" : raw.trim();
        name = name.replaceAll("[\\\\/:*?\"<>|\\r\\n\\t]", "_").replaceAll("\\s+", " ").trim();
        while (name.startsWith(".")) name = name.substring(1);
        if (name.isEmpty()) name = fallback;
        if (name.length() > 80) name = name.substring(0, 80);
        return name;
    }

    /** "/a/b" → ["a","b"]；空串 = 根目录。 */
    static List<String> segments(String path) {
        List<String> out = new ArrayList<>();
        if (path == null) return out;
        for (String seg : path.split("/")) {
            String s = seg.trim();
            if (!s.isEmpty()) out.add(s);
        }
        return out;
    }

    static void copy(InputStream in, java.io.OutputStream out, Progress progress) throws IOException {
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            if (progress != null) progress.add(n);
        }
        out.flush();
    }

    /** 协议异常 → 用户能看懂的中文（保留原始信息尾巴，方便排查）。 */
    static String describeError(Throwable error) {
        Throwable root = error;
        while (root.getCause() != null && root.getCause() != root) root = root.getCause();
        String raw = root.getMessage() == null ? root.getClass().getSimpleName() : root.getMessage();
        String lower = raw.toLowerCase();
        if (root instanceof UnknownHostException) return "找不到这台服务器，请检查地址：" + raw;
        if (root instanceof ConnectException) return "连不上服务器（端口不通或被防火墙拦了）";
        if (root instanceof SocketTimeoutException) return "连接超时，请检查地址/端口/网络";
        if (lower.contains("certificate") || lower.contains("ssl") || lower.contains("trust")) {
            return "HTTPS 证书校验失败，可在服务器配置里勾选「忽略证书校验」";
        }
        if (lower.contains("logon failure") || lower.contains("status_logon_failure")
                || lower.contains("access is denied") || lower.contains("status_access_denied")) {
            return "用户名或密码错误，或该账号没有写入权限";
        }
        return raw;
    }

    /** 从文件读并推进度（SMB 用）。 */
    static void copyFile(File file, java.io.OutputStream out, Progress progress) throws IOException {
        try (InputStream in = new FileInputStream(file)) {
            copy(in, out, progress);
        }
    }
}
