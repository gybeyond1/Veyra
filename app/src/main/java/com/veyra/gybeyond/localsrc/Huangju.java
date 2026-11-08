package com.veyra.gybeyond.localsrc;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/**
 * 剧果（server/sources/huangju.js 的端侧版）。
 *
 * 接口很干净，麻烦在播放：/play 会下发三个 CloudFront 签名 Cookie，
 * 分片缺了直接 403。端上拿到 Cookie 后交给本机回环网关逐条贴上，
 * 和 guoapp 的做法一致 —— 一条 cookie 都不经过后端。
 */
public final class Huangju implements LocalSource {

    private static final String API = "https://api.huangju.net";
    private static final String SITE = "https://huangju.net";
    private static final String UA = "Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36";

    private static final ExecutorService POOL = Executors.newFixedThreadPool(2);

    @Override public String id() { return "huangju"; }
    @Override public String name() { return "剧果"; }

    private static Map<String, String> headers() {
        return Net.headers(
                "User-Agent", UA,
                "Referer", SITE + "/",
                "Origin", SITE,
                "Accept-Language", "zh-CN,zh;q=0.9");
    }

    private JSONObject api(String path) throws Exception {
        Net.Res res = Net.get(API + path, headers(), 15000, 6L << 20);
        if (res.status < 200 || res.status >= 300) throw new IllegalStateException("剧果返回 " + res.status);
        String text = res.text().trim();
        if (text.startsWith("[")) return new JSONObject().put("rows", new JSONArray(text));
        return new JSONObject(text);
    }

    /* ---------------- 映射 ---------------- */

    private static JSONObject card(JSONObject row) {
        JSONArray tags = new JSONArray();
        List<String> names = new ArrayList<>();
        JSONObject category = row.optJSONObject("category");
        if (category != null && !category.optString("name").isEmpty()) names.add(category.optString("name"));
        JSONArray categories = row.optJSONArray("categories");
        for (int i = 0; categories != null && i < categories.length(); i++) {
            Object entry = categories.opt(i);
            String name = entry instanceof JSONObject ? ((JSONObject) entry).optString("name", "") : String.valueOf(entry);
            if (!name.isEmpty() && !names.contains(name)) names.add(name);
        }
        for (String name : names) if (tags.length() < 5) tags.put(name);
        String region = row.optString("region", "");
        if (!region.isEmpty() && tags.length() < 5) tags.put(region);
        int year = row.optInt("year", 0);
        if (year > 0 && tags.length() < 5) tags.put(year + "年");
        double score = row.optDouble("score", 0);
        if (score > 0 && score <= 10 && tags.length() < 5) tags.put("评分 " + trimZero(score));

        int episodes = row.optInt("totalEpisodes", 0);
        String status = row.optString("status", "");
        boolean finished = "completed".equals(status);
        String label = finished ? "全 " + episodes + " 集" : (episodes > 0 ? "更新至 " + episodes + " 集" : "");
        try {
            return new JSONObject()
                    .put("id", row.optString("slug", "") + "-" + row.optInt("id", 0))
                    .put("title", cut(row.optString("title", ""), 200))
                    .put("cover", row.optString("coverUrl", row.optString("coverHUrl", "")))
                    .put("description", cut(row.optString("description", ""), 4000))
                    .put("score", score > 0 && score <= 10 ? trimZero(score) : "")
                    .put("episodeLabel", label)
                    .put("category", names.isEmpty() ? "短剧" : names.get(0))
                    .put("tags", tags)
                    .put("status", finished ? "finished" : ("ongoing".equals(status) ? "ongoing" : ""));
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }

    private static String trimZero(double value) {
        String text = String.format(java.util.Locale.ROOT, "%.1f", value);
        return text.endsWith(".0") ? text.substring(0, text.length() - 2) : text;
    }

    private static String cut(String value, int max) {
        String text = value == null ? "" : value.trim();
        return text.length() <= max ? text : text.substring(0, max);
    }

    /* ---------------- 列表 ---------------- */

    private volatile JSONArray categoriesCache;
    private volatile long categoriesAt;

    @Override public JSONArray categories() throws Exception {
        long now = System.currentTimeMillis();
        if (categoriesCache != null && now - categoriesAt < 6L * 3600 * 1000) return categoriesCache;
        JSONObject data = api("/categories");
        JSONArray rows = data.optJSONArray("rows");
        if (rows == null) rows = data.optJSONArray("items");
        JSONArray list = new JSONArray();
        list.put(new JSONObject().put("id", "").put("name", "全部"));
        list.put(new JSONObject().put("id", "new").put("name", "最新"));
        Set<String> seen = new LinkedHashSet<>();
        seen.add("");
        seen.add("new");
        for (int i = 0; rows != null && i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) continue;
            String id = row.optString("slug", "");
            if (id.isEmpty() || "hot".equals(id) || seen.contains(id)) continue;
            seen.add(id);
            list.put(new JSONObject().put("id", id).put("name", row.optString("name", id)));
            if (list.length() >= 40) break;
        }
        categoriesCache = list;
        categoriesAt = now;
        return list;
    }

    private JSONObject list(Map<String, String> query, int page) throws Exception {
        StringBuilder path = new StringBuilder("/dramas?page=").append(page);
        for (Map.Entry<String, String> entry : query.entrySet()) {
            if (entry.getValue() == null || entry.getValue().isEmpty()) continue;
            path.append("&").append(entry.getKey()).append("=").append(enc(entry.getValue()));
        }
        JSONObject data = api(path.toString());
        JSONArray rows = data.optJSONArray("items");
        if (rows == null) rows = new JSONArray();
        JSONArray items = new JSONArray();
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row != null) items.put(card(row));
        }
        int pageSize = data.optInt("pageSize", 20);
        int total = data.optInt("total", 0);
        Object next = total > 0
                ? (page < Math.ceil((double) total / Math.max(1, pageSize)) ? page + 1 : JSONObject.NULL)
                : (rows.length() >= pageSize ? page + 1 : JSONObject.NULL);
        return new JSONObject().put("items", items).put("nextPage", next);
    }

    @Override public JSONObject home() throws Exception {
        Future<JSONObject> hotFuture = POOL.submit(() -> list(java.util.Collections.singletonMap("sort", "hot"), 1));
        Future<JSONObject> newFuture = POOL.submit(() -> list(java.util.Collections.singletonMap("sort", "new"), 1));
        JSONObject hot = hotFuture.get();
        JSONObject newest = newFuture.get();
        JSONArray hotItems = hot.optJSONArray("items");
        JSONArray newItems = newest.optJSONArray("items");
        return new JSONObject()
                .put("featured", slice(hotItems, 0, 5, true))
                .put("items", hotItems)
                .put("homepageRecommend", slice(hotItems, 0, 6, false))
                .put("homepageNewest", slice(newItems, 0, 6, false))
                .put("recommend", new JSONObject().put("items", hotItems).put("nextPage", hot.opt("nextPage")))
                .put("newest", new JSONObject().put("items", newItems).put("nextPage", newest.opt("nextPage")));
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
        String value = slug == null ? "" : slug.trim();
        Map<String, String> query = new java.util.LinkedHashMap<>();
        if ("new".equals(value)) query.put("sort", "new");
        else if (!value.isEmpty()) query.put("category", value);
        JSONObject result = list(query, page);
        return new JSONObject().put("items", result.optJSONArray("items")).put("nextPage", result.opt("nextPage"));
    }

    @Override public JSONObject search(String keyword, int page) throws Exception {
        Map<String, String> query = new java.util.LinkedHashMap<>();
        query.put("q", keyword == null ? "" : keyword.trim());
        JSONObject result = list(query, page);
        return new JSONObject().put("items", result.optJSONArray("items")).put("nextPage", result.opt("nextPage"));
    }

    /* ---------------- 详情 / 播放 ---------------- */

    private volatile String detailId = "";
    private volatile String detailTitle = "";
    private volatile String detailCover = "";
    private volatile JSONArray detailEpisodes;

    @Override public JSONObject detail(String id) throws Exception {
        String key = id == null ? "" : id.trim();
        if (!key.matches("(?i)^[a-z0-9-]+-\\d+$")) throw new IllegalArgumentException("无效剧集");
        JSONObject row = api("/dramas/" + enc(key));
        JSONArray rows = row.optJSONArray("episodes");
        List<JSONObject> episodes = new ArrayList<>();
        for (int i = 0; rows != null && i < rows.length(); i++) {
            JSONObject episode = rows.optJSONObject(i);
            if (episode == null || episode.optBoolean("playable", true) == false) continue;
            int number = episode.optInt("epNo", i + 1);
            episodes.add(new JSONObject()
                    .put("number", number)
                    .put("episodeId", episode.optString("id", ""))
                    .put("title", episode.optString("title", "第 " + number + " 集")));
        }
        episodes.sort((a, b) -> a.optInt("number") - b.optInt("number"));
        if (episodes.isEmpty()) throw new IllegalStateException("这一部没有可播放的分集");

        JSONObject info = card(row);
        JSONArray listed = new JSONArray();
        for (JSONObject item : episodes) {
            listed.put(new JSONObject().put("number", item.optInt("number"))
                    .put("url", SITE + "/episode/" + item.optString("episodeId")));
        }
        detailId = key;
        detailTitle = info.optString("title");
        detailCover = info.optString("cover");
        detailEpisodes = new JSONArray(episodes);
        return new JSONObject()
                .put("id", key)
                .put("title", detailTitle)
                .put("cover", detailCover)
                .put("description", info.optString("description"))
                .put("score", info.optString("score"))
                .put("tags", info.optJSONArray("tags"))
                .put("episodeLabel", "共 " + episodes.size() + " 集")
                .put("episodes", listed);
    }

    @Override public JSONObject episode(String id, int number) throws Exception {
        String key = id == null ? "" : id.trim();
        if (!key.equals(detailId) || detailEpisodes == null) detail(key);
        String episodeId = "";
        for (int i = 0; i < detailEpisodes.length(); i++) {
            JSONObject item = detailEpisodes.optJSONObject(i);
            if (item != null && item.optInt("number") == number) episodeId = item.optString("episodeId");
        }
        if (episodeId.isEmpty()) throw new IllegalStateException("这一集不存在");
        Net.Res res = Net.get(API + "/play/" + enc(episodeId), headers(), 15000, 4L << 20);
        if (res.status < 200 || res.status >= 300) throw new IllegalStateException("源站返回 " + res.status);
        JSONObject payload = new JSONObject(res.text());
        String url = payload.optString("url", "");
        if (!url.matches("(?i)^https?://.*")) throw new IllegalStateException("源站没有给出播放地址");
        return new JSONObject()
                .put("url", url)
                .put("referer", SITE + "/")
                .put("cookie", Net.cookieWithPrefix(res, "CloudFront-"))
                .put("title", detailTitle)
                .put("cover", detailCover);
    }

    private static String enc(String value) {
        try {
            return java.net.URLEncoder.encode(value == null ? "" : value, "UTF-8").replace("+", "%20");
        } catch (Exception error) {
            return value;
        }
    }
}
