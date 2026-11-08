package com.veyra.gybeyond.localsrc;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

/**
 * 黄豆短剧（server/sources/huangdou.js 的端侧版）。
 *
 * 这套接口是自研二进制协议，普通抓取一律 403：
 *   请求体 = 16 字节 IV + AES-256-CBC(gzip(JSON))，
 *   密钥 = HMAC-SHA256(platformKey, requestId 的 16 字节原文)；
 *   外加 version / deviceType / requestId / sessionId / time / sign 六个头。
 *
 * 备份线 xqjurgek.top 的证书早过期了，只取公开剧集数据，所以放开校验。
 */
public final class Huangdou implements LocalSource {

    private static final String PLATFORM_KEY = "7961beb44246e3012ce228d6b5ced05a";
    private static final String VERSION = "2.0.0";
    private static final String[] HOSTS = {"https://xqjurgek.top", "https://tideember.cc"};
    private static final String UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    private final String sessionId = Crypt.randomHex(16);
    private volatile String host = HOSTS[0];

    @Override public String id() { return "huangdou"; }
    @Override public String name() { return "黄豆短剧"; }

    /* ---------------- 传输 ---------------- */

    private JSONObject decode(byte[] blob, byte[] key) throws Exception {
        String text = new String(blob, StandardCharsets.UTF_8).trim();
        if (text.startsWith("{") || text.startsWith("[")) {
            try {
                Object parsed = text.startsWith("[") ? new JSONArray(text) : new JSONObject(text);
                return parsed instanceof JSONObject ? (JSONObject) parsed : new JSONObject().put("items", parsed);
            } catch (Exception ignored) { }
        }
        if (blob.length < 32) throw new IllegalStateException("黄豆返回内容过短");
        byte[] iv = java.util.Arrays.copyOfRange(blob, 0, 16);
        byte[] body = java.util.Arrays.copyOfRange(blob, 16, blob.length);
        byte[] plain = Crypt.gunzip(Crypt.aesDecrypt(key, iv, body, true));
        return new JSONObject(new String(plain, StandardCharsets.UTF_8));
    }

    private JSONObject callOnce(String base, String path, JSONObject data) throws Exception {
        String rid = uuid();
        byte[] key = Crypt.hmacSha256(PLATFORM_KEY.getBytes(StandardCharsets.UTF_8),
                Crypt.unb64Hex(rid.replace("-", "")));
        byte[] iv = new byte[16];
        new java.security.SecureRandom().nextBytes(iv);
        JSONObject payload = new JSONObject().put("token", "").put("deviceId", sessionId).put("data", data);
        byte[] plain = Crypt.gzip(payload.toString().getBytes(StandardCharsets.UTF_8));
        byte[] cipher = Crypt.aesEncrypt(key, iv, plain, true);
        byte[] body = new byte[iv.length + cipher.length];
        System.arraycopy(iv, 0, body, 0, 16);
        System.arraycopy(cipher, 0, body, 16, cipher.length);

        String stamp = String.valueOf(System.currentTimeMillis() / 1000);
        String sign = Crypt.hex(Crypt.sha256(("Dart|" + sessionId + "|" + rid + "|" + stamp + "|" + path)
                .getBytes(StandardCharsets.UTF_8))) + "-" + stamp;

        Map<String, String> headers = Net.headers(
                "User-Agent", UA,
                "Accept", "*/*",
                "Origin", base,
                "Referer", base + "/home",
                "Content-Type", "application/octet-stream",
                "version", VERSION,
                "deviceType", "web",
                "requestId", rid,
                "sessionId", sessionId,
                "time", stamp,
                "sign", sign);
        Net.Res res = Net.postBytes(base + "/api" + path, headers, body, 20000, 6L << 20);
        if (res.status < 200 || res.status >= 300) throw new IllegalStateException("黄豆接口返回 " + res.status);
        JSONObject envelope = decode(res.body, key);
        JSONObject inner = envelope.optJSONObject("data");
        JSONObject wrapper = inner == null ? envelope : inner;
        String status = wrapper.optString("status", "");
        if (!status.isEmpty() && !"y".equals(status)) {
            throw new IllegalStateException("黄豆接口拒绝：" + wrapper.optString("msg", status));
        }
        Object out = wrapper.has("data") ? wrapper.opt("data") : wrapper;
        if (out instanceof JSONObject) return (JSONObject) out;
        if (out instanceof JSONArray) return new JSONObject().put("list", out);
        return wrapper;
    }

    private JSONObject call(String path, JSONObject data) throws Exception {
        Exception lastError = null;
        String first = host;
        java.util.List<String> order = new java.util.ArrayList<>();
        order.add(first);
        for (String item : HOSTS) if (!item.equals(first)) order.add(item);
        for (String base : order) {
            try {
                JSONObject result = callOnce(base, path, data);
                host = base;
                return result;
            } catch (Exception error) {
                lastError = error;
            }
        }
        throw lastError == null ? new IllegalStateException("黄豆没有响应") : lastError;
    }

    private static String uuid() {
        byte[] raw = new byte[16];
        new java.security.SecureRandom().nextBytes(raw);
        String hex = Crypt.hex(raw);
        return hex.substring(0, 8) + "-" + hex.substring(8, 12) + "-" + hex.substring(12, 16)
                + "-" + hex.substring(16, 20) + "-" + hex.substring(20);
    }

    /* ---------------- 映射 ---------------- */

    private static String coverOf(JSONObject row) {
        String raw = firstNonEmpty(row, "img_y", "img_x", "img", "cover", "pic");
        if (raw.isEmpty()) return "";
        if (raw.startsWith("//")) return "https:" + raw;
        return raw;
    }

    private static String firstNonEmpty(JSONObject row, String... keys) {
        for (String key : keys) {
            String value = row.optString(key, "").trim();
            if (!value.isEmpty()) return value;
        }
        return "";
    }

    private static JSONObject card(JSONObject row) {
        String id = row.optString("id", row.optString("drama_id", "")).replaceAll("^rp_", "");
        int episodes = row.optInt("episode_count", 0);
        String label = firstNonEmpty(row, "update_label", "corner");
        JSONArray tags = new JSONArray();
        String category = firstNonEmpty(row, "category", "category_name");
        if (!category.isEmpty()) tags.put(category);
        JSONArray raw = row.optJSONArray("tags");
        for (int i = 0; raw != null && i < raw.length() && tags.length() < 4; i++) {
            String tag = raw.optString(i, "").trim();
            if (!tag.isEmpty()) tags.put(tag.length() > 12 ? tag.substring(0, 12) : tag);
        }
        boolean finished = label.contains("全") || label.contains("完结");
        String title = firstNonEmpty(row, "name", "title");
        if (title.isEmpty()) title = id;
        String episodeLabel = !label.isEmpty() ? label : (episodes > 0 ? "全 " + episodes + " 集" : "");
        return new JSONObject()
                .put("id", id)
                .put("title", cut(title, 200))
                .put("cover", coverOf(row))
                .put("description", cut(firstNonEmpty(row, "description", "summary"), 4000))
                .put("score", "")
                .put("episodeLabel", episodeLabel)
                .put("category", category.isEmpty() ? "短剧" : cut(category, 20))
                .put("tags", tags)
                .put("status", (finished || (episodes > 0 && !label.contains("更新"))) ? "finished" : "");
    }

    private static String cut(String value, int max) {
        String text = value == null ? "" : value.trim();
        return text.length() <= max ? text : text.substring(0, max);
    }

    private static JSONArray rowsOf(Object value) {
        if (value instanceof JSONArray) return (JSONArray) value;
        if (!(value instanceof JSONObject)) return new JSONArray();
        JSONObject object = (JSONObject) value;
        for (String key : new String[]{"list", "items", "data"}) {
            JSONArray rows = rowsOf(object.opt(key));
            if (rows.length() > 0) return rows;
        }
        return new JSONArray();
    }

    /* ---------------- 列表 ---------------- */

    private JSONObject list(int page, int size) throws Exception {
        JSONObject data = call("/drama/list",
                new JSONObject().put("page", String.valueOf(page)).put("page_size", String.valueOf(size)));
        JSONArray rows = rowsOf(data);
        JSONArray items = new JSONArray();
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) continue;
            JSONObject card = card(row);
            if (card.optString("id").isEmpty() || card.optString("title").isEmpty()
                    || card.optString("cover").isEmpty()) continue;
            items.put(card);
        }
        return new JSONObject().put("items", items)
                .put("nextPage", rows.length() >= size ? page + 1 : JSONObject.NULL);
    }

    @Override public JSONArray categories() {
        return new JSONArray()
                .put(new JSONObject().put("id", "").put("name", "全部"))
                .put(new JSONObject().put("id", "new").put("name", "最新"));
    }

    @Override public JSONObject home() throws Exception {
        JSONObject first = list(1, 30);
        JSONArray items = first.optJSONArray("items");
        return new JSONObject()
                .put("featured", slice(items, 0, 5, true))
                .put("items", items)
                .put("homepageRecommend", slice(items, 0, 6, false))
                .put("homepageNewest", slice(items, 6, 12, false))
                .put("recommend", new JSONObject().put("items", items).put("nextPage", first.opt("nextPage")))
                .put("newest", new JSONObject().put("items", slice(items, 6, 12, false))
                        .put("nextPage", first.opt("nextPage")));
    }

    private static JSONArray slice(JSONArray rows, int from, int to, boolean fillDescription) {
        JSONArray out = new JSONArray();
        for (int i = from; rows != null && i < rows.length() && i < to; i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) continue;
            if (fillDescription) {
                try {
                    if (row.optString("description").isEmpty()) row.put("description", row.optString("title"));
                } catch (Exception ignored) { }
            }
            out.put(row);
        }
        return out;
    }

    @Override public JSONObject category(String slug, int page) throws Exception {
        JSONObject result = list(page, 30);
        if ("new".equals(slug)) {
            JSONArray items = result.optJSONArray("items");
            java.util.List<JSONObject> sorted = new java.util.ArrayList<>();
            for (int i = 0; i < items.length(); i++) {
                JSONObject row = items.optJSONObject(i);
                if (row != null) sorted.add(row);
            }
            sorted.sort((a, b) -> Long.compare(hashPrefix(b.optString("id")), hashPrefix(a.optString("id"))));
            return new JSONObject().put("items", new JSONArray(sorted)).put("nextPage", result.opt("nextPage"));
        }
        return new JSONObject().put("items", result.optJSONArray("items")).put("nextPage", result.opt("nextPage"));
    }

    private static long hashPrefix(String id) {
        if (id == null || id.length() < 8) return 0;
        try {
            return Long.parseLong(id.substring(0, 8), 16);
        } catch (Exception error) {
            return 0;
        }
    }

    @Override public JSONObject search(String keyword, int page) throws Exception {
        String key = keyword == null ? "" : keyword.trim();
        if (key.isEmpty()) return new JSONObject().put("items", new JSONArray()).put("nextPage", JSONObject.NULL);
        JSONArray hits = new JSONArray();
        for (int index = 1; index <= Math.max(page, 1) + 2; index++) {
            JSONObject pageData = list(index, 30);
            JSONArray items = pageData.optJSONArray("items");
            for (int i = 0; i < items.length(); i++) {
                JSONObject item = items.optJSONObject(i);
                if (item != null && item.optString("title").contains(key) && hits.length() < 30) hits.put(item);
            }
            if (pageData.opt("nextPage") == JSONObject.NULL) break;
        }
        return new JSONObject().put("items", hits).put("nextPage", JSONObject.NULL);
    }

    /* ---------------- 详情 / 播放 ---------------- */

    private volatile String detailId = "";
    private volatile String detailTitle = "";
    private volatile String detailCover = "";

    @Override public JSONObject detail(String id) throws Exception {
        String key = id == null ? "" : id.trim().replaceAll("^rp_", "");
        if (key.isEmpty()) throw new IllegalArgumentException("无效剧集");
        JSONObject row = call("/drama/detail", new JSONObject().put("id", key));
        String realId = row.optString("id", row.optString("drama_id", key));
        JSONObject info = card(new JSONObject(row.toString()).put("id", realId));
        JSONArray episodes = rowsOf(row.opt("episodes"));
        int total = row.optInt("episode_count", episodes.length());
        if (total <= 0 || total > 5000) throw new IllegalStateException("黄豆返回了无效集数");

        Set<Integer> numbers = new LinkedHashSet<>();
        for (int i = 0; i < episodes.length(); i++) {
            JSONObject episode = episodes.optJSONObject(i);
            if (episode == null) continue;
            int seq = episode.optInt("seq", episode.optInt("episode", episode.optInt("ep", 0)));
            if (seq > 0) numbers.add(seq);
        }
        if (numbers.isEmpty()) for (int index = 1; index <= total; index++) numbers.add(index);

        java.util.List<Integer> sorted = new java.util.ArrayList<>(numbers);
        java.util.Collections.sort(sorted);
        JSONArray listed = new JSONArray();
        for (Integer number : sorted) {
            listed.put(new JSONObject().put("number", number)
                    .put("url", host + "/drama/" + key + "/" + number)
                    .put("title", "第 " + number + " 集"));
        }
        detailId = key;
        detailTitle = info.optString("title");
        detailCover = info.optString("cover");
        return new JSONObject()
                .put("id", key)
                .put("title", info.optString("title"))
                .put("cover", info.optString("cover"))
                .put("description", info.optString("description"))
                .put("score", "")
                .put("tags", info.optJSONArray("tags"))
                .put("episodeLabel", "共 " + listed.length() + " 集")
                .put("episodes", listed);
    }

    @Override public JSONObject episode(String id, int number) throws Exception {
        String key = id == null ? "" : id.trim().replaceAll("^rp_", "");
        if (!key.equals(detailId)) detail(key);
        JSONObject data = call("/drama/play",
                new JSONObject().put("id", key).put("seq", String.valueOf(number)));
        JSONArray lines = data.optJSONArray("lines");
        String url = data.optString("m3u8", data.optString("url",
                data.optString("play_url", data.optString("playUrl", ""))));
        if (url.isEmpty() && lines != null) {
            for (int i = 0; i < lines.length(); i++) {
                JSONObject line = lines.optJSONObject(i);
                if (line != null && !line.optString("url", "").isEmpty()) {
                    url = line.optString("url");
                    break;
                }
            }
        }
        if (url.isEmpty()) throw new IllegalStateException("黄豆没有给出这一集的播放地址");
        if (url.startsWith("//")) url = "https:" + url;
        else if (!url.matches("(?i)^https?://.*")) url = host + "/" + url.replaceAll("^/+", "");
        if (url.matches("(?i).*preview\\.(m3u8|mp4).*") || "true".equalsIgnoreCase(data.optString("is_preview"))) {
            throw new IllegalStateException("这一集黄豆只给试看片段，换一集或换源试试");
        }
        JSONObject out = new JSONObject()
                .put("url", url)
                .put("referer", host + "/home")
                .put("title", detailTitle)
                .put("cover", detailCover);
        String hlsKey = data.optString("hls_key", "");
        if (hlsKey.matches("(?i)^[0-9a-f]{32}$")) out.put("key", hlsKey.toLowerCase());
        return out;
    }

    /** 调试用：让外部知道当前钉在哪条线上。 */
    public String currentHost() {
        return host;
    }

    /** 遍历用（本类内部只用到 opt 系列，这个方法留给验证脚本）。 */
    static void each(JSONObject object, java.util.function.BiConsumer<String, Object> visitor) {
        for (Iterator<String> keys = object.keys(); keys.hasNext(); ) {
            String key = keys.next();
            visitor.accept(key, object.opt(key));
        }
    }
}
