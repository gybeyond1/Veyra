package com.veyra.gybeyond;

import android.content.Context;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Comparator;

/**
 * 私密模式「接口型源」的客户端：剧果、野果、禁果短剧、黄果 AI、黄果旧版。
 *
 * 抓取、解密、选线路、签名、播放地址全部在后端 /api/sources/{site}/* 完成，
 * 这里只做三件事：拼请求、封面落盘缓存、把结构补齐成 SiteRepository 的样子。
 *
 * 播放地址由后端签发（带签名 cookie 的源只能后端代取），客户端拿到的是
 * 一个 10 分钟有效的 stream 地址，直接交给播放器即可。
 */
final class BackendSiteRepository {
    private final Context context;
    private final AccountService account;
    private final String site;
    private final File coverDir;

    BackendSiteRepository(Context context, String site) {
        this.context = context.getApplicationContext();
        this.site = site;
        this.account = new AccountService(this.context, new AppStore(this.context));
        File dir = new File(this.context.getCacheDir(), "covers");
        if (!dir.exists()) dir.mkdirs();
        this.coverDir = dir;
    }

    private String endpoint(String path) {
        return "api/sources/" + site + "/" + path;
    }

    private JSONObject call(String path) throws Exception {
        return account.getJson(endpoint(path));
    }

    JSONObject home() throws Exception {
        return call("home");
    }

    JSONObject category(String id, int page) throws Exception {
        String slug = id == null ? "" : id.trim();
        return call("category?slug=" + URLEncoder.encode(slug, "UTF-8") + "&page=" + Math.max(1, page));
    }

    /** 推荐/最新在接口型源里就是分类页的两种排序 */
    JSONObject recommend(int page, boolean newest) throws Exception {
        if (newest) return category("new", page);
        return call("category?page=" + Math.max(1, page));
    }

    JSONObject search(String term, boolean suggest) throws Exception {
        String query = term == null ? "" : term.trim();
        if (query.isEmpty()) return new JSONObject().put("items", new JSONArray()).put("nextPage", JSONObject.NULL);
        return call("search?q=" + URLEncoder.encode(query, "UTF-8"));
    }

    JSONObject detail(String id) throws Exception {
        JSONObject data = call("detail?id=" + URLEncoder.encode(id, "UTF-8"));
        // tags 接口和详情里的标签都要是数组，老前端拿 tags 直接渲染
        if (data.optJSONArray("tags") == null) data.put("tags", new JSONArray());
        return data;
    }

    JSONObject episode(String id, int number) throws Exception {
        StringBuilder path = new StringBuilder("episode?id=").append(URLEncoder.encode(id, "UTF-8"))
                .append("&episode=").append(Math.max(1, number));
        /*
         * 网络模式是私密模式的全局设置，接口型源只有取播放地址这一段受它影响：
         *   仅直连 → 后端只下发源站真实地址，播放器直连，后端不代取；
         *   仅代理 → 后端经代理取流（优先用下面这个地址，没填就用管理台配的后端代理）；
         *   走后端转发 → 后端直连取流（默认）。
         * 列表/详情恒由后端解析，不受模式影响。
         */
        int mode = ProxySettings.mode(context);
        path.append("&net=").append(mode);
        // 原生播放器能把 Referer / Cookie 原样贴到清单、分片、密钥上，
        // 带这个标记后「仅直连」才会真的下发源站地址，而不是被后端自动降级
        path.append("&carry=1");
        if (mode == ProxySettings.MODE_PROXY) {
            String address = ProxySettings.address(context);
            if (!address.isEmpty()) {
                // 设置里允许只填 host:port，后端的代理校验要求完整 URL
                if (!address.matches("(?i)^[a-z0-9]+://.*")) address = "http://" + address;
                path.append("&proxy=").append(URLEncoder.encode(address, "UTF-8"));
            }
        }
        JSONObject data = call(path.toString());
        /*
         * 「仅直连」拿到的是源站真实地址 + 一套凭据。播放器自己贴头只能在
         * 清单这一层生效，分片和 AES 密钥一旦换域名就掉（而且 ExoPlayer 不肯
         * 替你去求密钥）。所以这里转一手：把地址交给本机网关，播放器只跟
         * 127.0.0.1 说话，由网关带着凭据去取清单、分片、密钥。
         *
         * 这一层是 guoapp 的做法，也是「开 VPN 就能播」的关键——取流请求
         * 从手机发出，走 VPN 的 TUN，后端完全不承载媒体流量。
         */
        if (data.optBoolean("direct")) {
            String origin = data.optString("source", "");
            if (origin.startsWith("http://") || origin.startsWith("https://")) {
                LocalPlaybackGateway gateway = LocalPlaybackGateway.get(context);
                if (gateway != null) {
                    try {
                        JSONObject raw = data.optJSONObject("headers");
                        java.util.Map<String, String> headers = new java.util.LinkedHashMap<>();
                        if (raw != null) {
                            for (java.util.Iterator<String> keys = raw.keys(); keys.hasNext(); ) {
                                String key = keys.next();
                                String value = raw.optString(key, "");
                                if (!key.isEmpty() && !value.isEmpty()) headers.put(key, value);
                            }
                        }
                        String local = gateway.open(origin, headers);
                        data.put("source", local);
                        data.put("localGateway", true);
                        data.put("origin", origin);
                        // 凭据已经交给网关，别再让播放器贴一遍到 127.0.0.1 上
                        data.remove("headers");
                    } catch (Exception error) {
                        // 网关没起来就退回原来的直连方式，至少还有一半能播
                        android.util.Log.w("VeyraLocalGateway", "接管失败，回退直连: " + error.getMessage());
                    }
                }
            }
        }
        return data;
    }

    /** 分类页直接当"全部类型"用：接口型源没有黄果那种标签树 */
    JSONObject tags() throws Exception {
        JSONObject data = call("categories");
        JSONArray rows = data.optJSONArray("items");
        JSONArray items = new JSONArray();
        for (int i = 0; rows != null && i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) continue;
            String slug = row.optString("id");
            if (slug.isEmpty()) continue;
            items.put(new JSONObject()
                    .put("slug", slug)
                    .put("name", row.optString("name", slug))
                    .put("group", "other"));
        }
        return new JSONObject().put("items", items);
    }

    JSONObject tagListing(String slug, int page) throws Exception {
        return category(slug, page);
    }

    /**
     * 封面：前端统一按 data URI 渲染（黄果封面是加密的必须先解）。
     * 这些源的封面是普通图片，这里下载后转 base64 并落盘缓存，避免每次滚动都重新拉。
     */
    String coverData(String value) throws Exception {
        String url = value == null ? "" : value.trim();
        if (!url.startsWith("https://") && !url.startsWith("http://")) throw new IllegalArgumentException("无效封面地址");
        File file = new File(coverDir, key(url) + ".img");
        byte[] bytes = null;
        if (file.isFile()) bytes = java.nio.file.Files.readAllBytes(file.toPath());
        if (bytes == null || bytes.length < 64) {
            bytes = account.getBytes("api/sources/" + site + "/cover?url=" + URLEncoder.encode(url, "UTF-8"));
            try (FileOutputStream output = new FileOutputStream(file)) {
                output.write(bytes);
            }
            trim();
        }
        String mime = bytes[0] == (byte) 0xff ? "image/jpeg"
                : bytes[0] == (byte) 0x89 ? "image/png"
                : bytes[0] == 'G' ? "image/gif" : "image/webp";
        return "data:" + mime + ";base64," + Base64.encodeToString(bytes, Base64.NO_WRAP);
    }

    void clearCovers() {
        File[] files = coverDir.listFiles();
        if (files != null) for (File item : files) item.delete();
    }

    private static String key(String url) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] hash = digest.digest(("site:" + url).getBytes(StandardCharsets.UTF_8));
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < 16; i++) out.append(String.format("%02x", hash[i] & 0xff));
        return out.toString();
    }

    private void trim() {
        File[] files = coverDir.listFiles();
        if (files == null) return;
        long total = 0;
        for (File item : files) total += item.length();
        if (total <= 150L * 1024 * 1024) return;
        Arrays.sort(files, Comparator.comparingLong(File::lastModified));
        for (File item : files) {
            if (total <= 150L * 1024 * 1024) break;
            long size = item.length();
            if (item.delete()) total -= size;
        }
    }
}
