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
        return call("episode?id=" + URLEncoder.encode(id, "UTF-8") + "&episode=" + Math.max(1, number));
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
