package com.veyra.gybeyond;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 远程服务器配置（SMB / WebDAV / FTP）。
 *
 * 只存在本机 SharedPreferences（app 私有目录），跟账号无关：这是「这台手机往哪儿传」的本地设置。
 * 密码不通过 list 回传给页面（只给 hasPass 标记），编辑时密码留空 = 保持原密码，
 * 避免 WebView 里任何脚本能直接读到明文口令。
 */
final class RemoteStore {
    static final String TYPE_SMB = "smb";
    static final String TYPE_WEBDAV = "webdav";
    static final String TYPE_FTP = "ftp";

    private static final String PREFS = "veyra-remote";
    private static final String KEY = "servers";
    /** 上限：下拉/列表是给手指点的，不是配置中心，12 个足够 */
    private static final int MAX_SERVERS = 12;

    private RemoteStore() { }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** 给页面看的列表：不含明文密码。 */
    static JSONArray list(Context context) {
        JSONArray out = new JSONArray();
        JSONArray servers = load(context);
        for (int i = 0; i < servers.length(); i++) {
            JSONObject server = servers.optJSONObject(i);
            if (server != null) out.put(publicView(server));
        }
        return out;
    }

    /** 内部用的完整列表（含密码）。 */
    static JSONArray load(Context context) {
        JSONArray out = new JSONArray();
        String raw = prefs(context).getString(KEY, "");
        if (raw == null || raw.trim().isEmpty()) return out;
        try {
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject item = arr.optJSONObject(i);
                if (item == null) continue;
                if (item.optString("id", "").isEmpty()) item.put("id", newId());
                out.put(normalize(item));
            }
        } catch (Exception ignored) { }
        return out;
    }

    static JSONObject find(Context context, String id) {
        if (id == null || id.isEmpty()) return null;
        JSONArray servers = load(context);
        for (int i = 0; i < servers.length(); i++) {
            JSONObject server = servers.optJSONObject(i);
            if (server != null && id.equals(server.optString("id", ""))) return server;
        }
        return null;
    }

    /** 新增或更新。id 为空 = 新建；密码留空且是同一条记录 = 保持原密码。 */
    static JSONObject save(Context context, JSONObject in) throws Exception {
        if (in == null) throw new IllegalArgumentException("参数无效");
        String type = in.optString("type", "").trim().toLowerCase();
        if (!TYPE_SMB.equals(type) && !TYPE_WEBDAV.equals(type) && !TYPE_FTP.equals(type))
            throw new IllegalArgumentException("不支持的服务器类型");
        String host = cleanHost(in.optString("host", ""));
        if (host.isEmpty()) throw new IllegalArgumentException("请填写服务器地址");
        JSONObject server = new JSONObject();
        String id = in.optString("id", "").trim();
        if (id.isEmpty()) id = newId();
        server.put("id", id);
        server.put("type", type);
        server.put("host", host);
        server.put("secure", in.optBoolean("secure", false));
        server.put("insecure", in.optBoolean("insecure", true));
        server.put("user", in.optString("user", "").trim());
        server.put("path", cleanPath(in.optString("path", "")));
        server.put("share", TYPE_SMB.equals(type) ? cleanShare(in.optString("share", "")) : "");
        if (TYPE_SMB.equals(type) && server.optString("share").isEmpty())
            throw new IllegalArgumentException("请填写共享文件夹名（如 video）");
        int port = in.optInt("port", 0);
        if (port <= 0 || port > 65535) port = portFromHost(in.optString("host", ""));
        if (port <= 0 || port > 65535) port = defaultPort(type, server.optBoolean("secure", false));
        server.put("port", port);
        JSONObject old = find(context, id);
        String pass = in.optString("pass", "");
        server.put("pass", (pass.isEmpty() && old != null) ? old.optString("pass", "") : pass);
        String name = in.optString("name", "").trim();
        if (name.isEmpty()) name = defaultName(server);
        server.put("name", name.length() > 40 ? name.substring(0, 40) : name);

        JSONArray servers = load(context);
        boolean replaced = false;
        for (int i = 0; i < servers.length(); i++) {
            JSONObject item = servers.optJSONObject(i);
            if (item != null && id.equals(item.optString("id", ""))) {
                servers.put(i, server);
                replaced = true;
                break;
            }
        }
        if (!replaced) {
            if (servers.length() >= MAX_SERVERS) throw new IllegalStateException("最多保存 " + MAX_SERVERS + " 个服务器");
            servers.put(server);
        }
        prefs(context).edit().putString(KEY, servers.toString()).apply();
        return publicView(server);
    }

    static void remove(Context context, String id) {
        if (id == null || id.isEmpty()) return;
        JSONArray servers = load(context);
        JSONArray next = new JSONArray();
        for (int i = 0; i < servers.length(); i++) {
            JSONObject item = servers.optJSONObject(i);
            if (item == null) continue;
            if (id.equals(item.optString("id", ""))) continue;
            next.put(item);
        }
        prefs(context).edit().putString(KEY, next.toString()).apply();
    }

    /** 页面提交的是「可能没保存过的草稿」：密码空但有 id 时，用存下来的密码补上（测试连接用）。 */
    static JSONObject withSecret(Context context, JSONObject draft) throws Exception {
        JSONObject server = new JSONObject(draft == null ? "{}" : draft.toString());
        if (server.optString("pass", "").isEmpty()) {
            JSONObject old = find(context, server.optString("id", ""));
            if (old != null) server.put("pass", old.optString("pass", ""));
        }
        server.put("type", server.optString("type", "").trim().toLowerCase());
        server.put("host", cleanHost(server.optString("host", "")));
        server.put("path", cleanPath(server.optString("path", "")));
        if (TYPE_SMB.equals(server.optString("type"))) server.put("share", cleanShare(server.optString("share", "")));
        int port = server.optInt("port", 0);
        if (port <= 0 || port > 65535) port = portFromHost(server.optString("host", ""));
        if (port <= 0 || port > 65535) port = defaultPort(server.optString("type"), server.optBoolean("secure", false));
        server.put("port", port);
        if (server.optString("name", "").trim().isEmpty()) server.put("name", defaultName(server));
        return server;
    }

    static int defaultPort(String type, boolean secure) {
        if (TYPE_SMB.equals(type)) return 445;
        if (TYPE_FTP.equals(type)) return secure ? 990 : 21;
        return secure ? 443 : 80;
    }

    static String typeName(String type) {
        if (TYPE_SMB.equals(type)) return "SMB";
        if (TYPE_FTP.equals(type)) return "FTP";
        return "WebDAV";
    }

    static String defaultName(JSONObject server) {
        String host = server.optString("host", "");
        String share = server.optString("share", "");
        return share.isEmpty() ? host : host + "/" + share;
    }

    /** 完整地址（给「测试连接」结果显示用）。 */
    static String describe(JSONObject server) {
        String type = server.optString("type", "");
        String host = server.optString("host", "");
        int port = server.optInt("port", defaultPort(type, server.optBoolean("secure", false)));
        String path = server.optString("path", "");
        if (TYPE_SMB.equals(type)) {
            return "smb://" + host + "/" + server.optString("share", "") + (path.isEmpty() ? "" : path);
        }
        String scheme = TYPE_FTP.equals(type) ? (server.optBoolean("secure", false) ? "ftps" : "ftp")
                : (server.optBoolean("secure", false) ? "https" : "http");
        boolean defaultPort = port == defaultPort(type, server.optBoolean("secure", false));
        return scheme + "://" + host + (defaultPort ? "" : ":" + port) + path;
    }

    // ---- 规范化 ----

    private static JSONObject normalize(JSONObject item) {
        try {
            if (item.optString("type", "").isEmpty()) item.put("type", TYPE_WEBDAV);
            item.put("host", cleanHost(item.optString("host", "")));
            item.put("path", cleanPath(item.optString("path", "")));
            if (TYPE_SMB.equals(item.optString("type"))) item.put("share", cleanShare(item.optString("share", "")));
            int port = item.optInt("port", 0);
            if (port <= 0 || port > 65535) {
                item.put("port", defaultPort(item.optString("type"), item.optBoolean("secure", false)));
            }
            if (item.optString("name", "").trim().isEmpty()) item.put("name", defaultName(item));
        } catch (Exception ignored) { }
        return item;
    }

    /** 地址里粘了 "http://" 或结尾斜杠的，用户很常见：这里统一剥掉，只留 host。 */
    static String cleanHost(String raw) {
        String host = raw == null ? "" : raw.trim();
        int scheme = host.indexOf("://");
        if (scheme >= 0) host = host.substring(scheme + 3);
        while (host.endsWith("/")) host = host.substring(0, host.length() - 1);
        // 用户可能把 "host:port" 一起粘进来：端口单独拆出来
        int colon = host.lastIndexOf(':');
        if (colon > 0 && host.indexOf(':') == colon && host.substring(colon + 1).matches("\\d{1,5}")) {
            host = host.substring(0, colon);
        }
        return host.trim();
    }

    /** 从 "host:port/path" 里拆端口（用户把端口写在地址里的场景）。 */
    static int portFromHost(String raw) {
        String host = raw == null ? "" : raw.trim();
        int scheme = host.indexOf("://");
        if (scheme >= 0) host = host.substring(scheme + 3);
        int slash = host.indexOf('/');
        if (slash >= 0) host = host.substring(0, slash);
        int colon = host.lastIndexOf(':');
        if (colon <= 0) return 0;
        try { return Integer.parseInt(host.substring(colon + 1)); } catch (Exception e) { return 0; }
    }

    /** 远程目录：统一成 "/a/b" 形式（根 = 空串），并去掉结尾斜杠。 */
    static String cleanPath(String raw) {
        String path = raw == null ? "" : raw.trim().replace('\\', '/');
        int scheme = path.indexOf("://");
        if (scheme >= 0) path = path.substring(scheme + 3);
        StringBuilder out = new StringBuilder();
        for (String seg : path.split("/")) {
            String s = seg.trim();
            if (s.isEmpty() || s.equals(".")) continue;
            out.append('/').append(s);
        }
        return out.toString();
    }

    static String cleanShare(String raw) {
        String share = raw == null ? "" : raw.trim().replace('\\', '/');
        while (share.startsWith("/")) share = share.substring(1);
        int slash = share.indexOf('/');
        if (slash >= 0) share = share.substring(0, slash);
        return share.trim();
    }

    private static String newId() {
        return java.util.UUID.randomUUID().toString().replace("-", "").substring(0, 12);
    }

    /** 页面视图：密码只留「有没有」这一位信息。 */
    static JSONObject publicView(JSONObject server) {
        JSONObject out = new JSONObject();
        try {
            out.put("id", server.optString("id", ""));
            out.put("name", server.optString("name", ""));
            out.put("type", server.optString("type", TYPE_WEBDAV));
            out.put("host", server.optString("host", ""));
            out.put("port", server.optInt("port", 0));
            out.put("share", server.optString("share", ""));
            out.put("path", server.optString("path", ""));
            out.put("user", server.optString("user", ""));
            out.put("secure", server.optBoolean("secure", false));
            out.put("insecure", server.optBoolean("insecure", true));
            out.put("hasPass", !server.optString("pass", "").isEmpty());
            out.put("address", describe(server));
            out.put("typeName", typeName(server.optString("type", "")));
        } catch (Exception ignored) { }
        return out;
    }
}
