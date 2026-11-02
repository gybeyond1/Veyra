package com.veyra.gybeyond;

import org.json.JSONObject;

import java.io.File;
import java.io.OutputStream;
import java.util.List;
import java.util.Properties;

import jcifs.CIFSContext;
import jcifs.config.PropertyConfiguration;
import jcifs.context.BaseContext;
import jcifs.smb.NtlmPasswordAuthenticator;
import jcifs.smb.SmbFile;

/**
 * SMB（Windows 共享 / NAS 的 SMB 服务）上传，走 jcifs-ng：SMB1 到 SMB3 自动协商，
 * NTLMv2 认证，匿名共享（不填账号）也能进。
 *
 * 路径一律用 SmbFile.resolve(parent, name) 逐级下探，**不要自己拼 URL**：
 * 手拼 URL 会把中文按 %E7%9F%AD 原样写进远端 —— 在 Samba 上真的会建出一个叫
 * "%E7%9F%AD%E5%89%A7" 的目录（实测踩过）。
 */
final class SmbRemoteClient extends RemoteClient {
    private final String host;
    private final int port;
    private final String share;
    private final String basePath;
    private final String user;
    private final String pass;

    private CIFSContext context;
    private SmbFile base;

    SmbRemoteClient(JSONObject server) {
        this.host = server.optString("host", "");
        this.port = server.optInt("port", 445);
        this.share = server.optString("share", "");
        this.basePath = server.optString("path", "");
        this.user = server.optString("user", "");
        this.pass = server.optString("pass", "");
    }

    @Override
    void open() throws Exception {
        Properties props = new Properties();
        // 家用 NAS 的 SMB 经常在第一个包上磨蹭：给足超时，别 10 秒就判死
        props.setProperty("jcifs.smb.client.connTimeout", "15000");
        props.setProperty("jcifs.smb.client.responseTimeout", "30000");
        props.setProperty("jcifs.smb.client.soTimeout", "60000");
        props.setProperty("jcifs.smb.client.sessionTimeout", "120000");
        context = new BaseContext(new PropertyConfiguration(props));
        if (!user.isEmpty() || !pass.isEmpty()) {
            context = context.withCredentials(new NtlmPasswordAuthenticator(user, pass));
        }
        // 共享根：端口不是 445 时必须写进 URL，否则 jcifs 只会连默认端口
        String root = "smb://" + host + (port > 0 && port != 445 ? ":" + port : "") + "/" + share + "/";
        SmbFile current = new SmbFile(root, context);
        for (String seg : segments(basePath)) {
            SmbFile next = child(current, seg, true);
            if (!next.exists()) next.mkdir();
            current = next;
        }
        base = current;
        if (!base.exists()) base.mkdirs();
        if (!base.isDirectory()) throw new java.io.IOException("远程路径不是文件夹：" + target());
    }

    @Override
    void ensureDir(String relative) throws Exception {
        descend(relative);
    }

    @Override
    void upload(File file, String dir, String name, Progress progress) throws Exception {
        SmbFile folder = descend(dir);
        SmbFile target = child(folder, name, false);
        try (OutputStream out = target.getOutputStream()) {
            copyFile(file, out, progress);
        }
    }

    @Override
    void verify() throws Exception {
        if (!base.exists()) throw new java.io.IOException("共享目录不存在：" + target());
        if (!base.canWrite()) throw new java.io.IOException("这个共享目录没有写入权限");
    }

    @Override
    long size(String dir, String name) throws Exception {
        SmbFile folder = descend(dir);
        SmbFile target = child(folder, name, false);
        return target.exists() ? target.length() : -1;
    }

    @Override
    public void close() {
        try { if (context != null) context.close(); } catch (Exception ignored) { }
        context = null;
        base = null;
    }

    @Override
    String target() {
        return "smb://" + host + (port > 0 && port != 445 ? ":" + port : "") + "/" + share + basePath;
    }

    /** 从 basePath 出发逐级下探，缺哪级建哪级，返回最深那级。 */
    private SmbFile descend(String relative) throws Exception {
        SmbFile current = base;
        for (String seg : segments(relative)) {
            SmbFile next = child(current, seg, true);
            if (!next.exists()) next.mkdir();
            current = next;
        }
        return current;
    }

    private SmbFile child(SmbFile parent, String name, boolean dir) throws Exception {
        return (SmbFile) parent.resolve(name + (dir ? "/" : ""));
    }
}
