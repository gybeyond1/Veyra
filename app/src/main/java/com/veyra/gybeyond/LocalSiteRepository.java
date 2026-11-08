package com.veyra.gybeyond;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

import com.veyra.gybeyond.localsrc.LocalSource;
import com.veyra.gybeyond.localsrc.LocalSources;
import com.veyra.gybeyond.localsrc.LegacyCore;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 私密源的端侧实现：解析、解密、取播放地址全在手机上完成，后端一个字节都不参与。
 *
 * 起因：这些源站把「国内机房出口」当拒绝理由 —— 剧果 / 黄果旧版 / 黄豆在用户后端上
 * 成片 ECONNRESET，帝果直接超时，而手机开着 VPN 就通。guoapp 之所以「一点问题都没有」，
 * 就是因为它压根没有后端，取数全从手机发出去。
 *
 * 这里只做适配：把 LocalSource 的 JSON 补齐成 SiteRepository 的形状，
 * 播放地址交给本机回环网关（分片带 Referer / Cookie / 密钥）。
 */
final class LocalSiteRepository {
    private final Context context;
    private final LocalSource site;
    private final File coverDir;

    LocalSiteRepository(Context context, String siteId) {
        this.context = context.getApplicationContext();
        this.site = LocalSources.create(siteId, new Store(this.context));
        if (site == null) throw new IllegalArgumentException("没有端侧实现：" + siteId);
        File dir = new File(this.context.getCacheDir(), "covers");
        if (!dir.exists()) dir.mkdirs();
        this.coverDir = dir;
    }

    static boolean supports(String siteId) {
        return LocalSources.supports(siteId);
    }

    /* ---------------- 目录 ---------------- */

    JSONObject home() throws Exception {
        return site.home();
    }

    JSONObject category(String id, int page) throws Exception {
        return site.category(id == null ? "" : id.trim(), Math.max(1, page));
    }

    JSONObject recommend(int page, boolean newest) throws Exception {
        if (newest) return site.category("new", page);
        return site.category("", page);
    }

    JSONObject search(String term, boolean suggest) throws Exception {
        String query = term == null ? "" : term.trim();
        if (query.isEmpty()) {
            return new JSONObject().put("items", new JSONArray()).put("nextPage", JSONObject.NULL);
        }
        return site.search(query, 1);
    }

    JSONObject detail(String id) throws Exception {
        JSONObject data = site.detail(id);
        if (data.optJSONArray("tags") == null) data.put("tags", new JSONArray());
        return data;
    }

    JSONObject tags() throws Exception {
        JSONArray rows = site.categories();
        JSONArray items = new JSONArray();
        for (int i = 0; rows != null && i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) continue;
            String slug = row.optString("id", "");
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

    /* ---------------- 播放 ---------------- */

    JSONObject episode(String id, int number) throws Exception {
        JSONObject data = site.episode(id, Math.max(1, number));
        String origin = data.optString("url", "");
        if (!origin.startsWith("http://") && !origin.startsWith("https://")) {
            throw new IllegalStateException("这一集没有可用的播放地址");
        }

        Map<String, String> headers = new LinkedHashMap<>();
        String referer = data.optString("referer", "");
        if (!referer.isEmpty()) headers.put("Referer", referer);
        String cookie = data.optString("cookie", "");
        if (!cookie.isEmpty()) headers.put("Cookie", cookie);

        JSONObject result = new JSONObject()
                .put("id", id)
                .put("episode", number)
                .put("title", data.optString("title", ""))
                .put("cover", data.optString("cover", ""))
                .put("source", origin)
                .put("net", 1)
                .put("direct", true)
                .put("localGateway", false)
                .put("mimeType", origin.matches("(?i).*\\.mp4(\\?|$).*")
                        ? "video/mp4" : "application/vnd.apple.mpegurl")
                .put("nextUrl", "");

        byte[] key = null;
        String hexKey = data.optString("key", "");
        if (hexKey.matches("(?i)^[0-9a-f]{32}$")) {
            key = new byte[16];
            for (int i = 0; i < 16; i++) key[i] = (byte) Integer.parseInt(hexKey.substring(i * 2, i * 2 + 2), 16);
        }

        /*
         * 交给本机回环网关：播放器只跟 127.0.0.1 说话，清单、子清单、分片、AES 密钥
         * 四条请求都由网关带上 Referer / Cookie。剧果缺 CloudFront 签名 cookie 直接 403，
         * 黄豆的清单里若没有 EXT-X-KEY 用 hls_key 兜底 —— 这两件事播放器自己都做不了。
         */
        LocalPlaybackGateway gateway = LocalPlaybackGateway.get(context);
        if (gateway != null) {
            try {
                String local = key == null ? gateway.open(origin, headers) : gateway.open(origin, headers, key);
                result.put("source", local).put("localGateway", true).put("origin", origin);
            } catch (Exception error) {
                android.util.Log.w("VeyraLocalSite", "网关接管失败，回退直连: " + error.getMessage());
                JSONObject raw = new JSONObject();
                for (Map.Entry<String, String> entry : headers.entrySet()) raw.put(entry.getKey(), entry.getValue());
                result.put("headers", raw);
                result.put("requiresCredentials", !cookie.isEmpty());
            }
        } else {
            JSONObject raw = new JSONObject();
            for (Map.Entry<String, String> entry : headers.entrySet()) raw.put(entry.getKey(), entry.getValue());
            result.put("headers", raw);
            result.put("requiresCredentials", !cookie.isEmpty());
        }
        return result;
    }

    /* ---------------- 封面 ---------------- */

    String coverData(String value) throws Exception {
        String url = value == null ? "" : value.trim();
        if (!url.startsWith("https://") && !url.startsWith("http://")) throw new IllegalArgumentException("无效封面地址");
        File file = new File(coverDir, key(url) + ".img");
        byte[] bytes = null;
        if (file.isFile()) bytes = java.nio.file.Files.readAllBytes(file.toPath());
        if (bytes == null || bytes.length < 64) {
            // 封面直连：图床多半不校验 Referer，带上反而 403（黄果旧版那个 CDN 就是这样）
            bytes = com.veyra.gybeyond.localsrc.Net.peek(url, null, 15000, 8L << 20, true);
            if (bytes == null || bytes.length < 64) throw new IllegalStateException("封面下载失败");
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
        byte[] hash = digest.digest(("local:" + url).getBytes(StandardCharsets.UTF_8));
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

    /** 设备号 / 访客 token 落 SharedPreferences：黄果旧版换设备号会重置访客态。 */
    private static final class Store implements LegacyCore.Store {
        private final SharedPreferences prefs;

        Store(Context context) {
            prefs = context.getSharedPreferences("local-sites", Context.MODE_PRIVATE);
        }

        @Override public String get(String key) {
            return prefs.getString(key, null);
        }

        @Override public void put(String key, String value) {
            if (value == null) prefs.edit().remove(key).apply();
            else prefs.edit().putString(key, value).apply();
        }
    }
}
