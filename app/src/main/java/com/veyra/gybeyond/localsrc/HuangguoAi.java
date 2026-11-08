package com.veyra.gybeyond.localsrc;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/**
 * 黄果 AI（server/sources/huangguoai.js 的端侧版）。
 *
 * 站点把接口收敛到 POST /api/edge/request，body 里写要代理的 path，
 * 真正的请求由它自己发出 —— 所以这里不用处理签名，只要探活选镜像。
 */
public final class HuangguoAi implements LocalSource {

    private static final String[] MIRRORS = {
            "https://huangguoai.io",
            "https://0624.gitiecgad.cc",
    };

    private static final String[][] AI_CATEGORIES = {
            {"ai-duanju", "AI 短剧"},
            {"ai-manju", "AI 漫剧"},
            {"ai-huanlian", "AI 换脸"},
            {"ai-mogai", "AI 魔改"},
    };

    private static final ExecutorService POOL = Executors.newFixedThreadPool(3);

    private volatile String base = "";

    @Override public String id() { return "huangguoai"; }
    @Override public String name() { return "黄果 AI"; }

    /* ---------------- 传输 ---------------- */

    /**
     * 站点两套入口都在用：
     *   · 新版直接暴露 /api/xxx（返回 {data:{…}}）；
     *   · 老版只有 POST /api/edge/request，body 里写要转发的 path。
     * 先直连，拿不到再退回边缘入口 —— 2026-11 这两套同时可用，直连更快也更省一次往返。
     */
    private JSONObject edgeAt(String host, String path, int timeoutMs) throws Exception {
        java.util.Map<String, String> headers = Net.headers(
                "Accept", "application/json",
                "Accept-Language", "zh-CN,zh;q=0.9",
                "Origin", host,
                "Referer", host + "/",
                "User-Agent", "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 "
                        + "(KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36");
        Exception direct = null;
        try {
            Net.Res res = Net.get(host + path, headers, timeoutMs, 8L << 20);
            if (res.status >= 200 && res.status < 300) {
                JSONObject envelope = new JSONObject(res.text());
                JSONObject data = envelope.optJSONObject("data");
                if (data != null) return data;
                if ("1".equals(envelope.optString("status"))) {
                    Object payload = envelope.opt("data");
                    if (payload instanceof JSONObject) return (JSONObject) payload;
                    if (payload instanceof JSONArray) return new JSONObject().put("items", payload);
                }
                throw new IllegalStateException(envelope.optString("msg", "接口没有返回数据"));
            }
            throw new IllegalStateException("接口返回 " + res.status);
        } catch (Exception error) {
            direct = error;
        }

        JSONObject payload = new JSONObject()
                .put("method", "GET")
                .put("path", path)
                .put("body", "")
                .put("content_type", "");
        headers.put("Content-Type", "application/json");
        Net.Res res = Net.postJson(host + "/api/edge/request", headers, payload.toString(), timeoutMs, 8L << 20);
        if (res.status < 200 || res.status >= 300) {
            throw new IllegalStateException(direct != null ? direct.getMessage() : "镜像返回 " + res.status);
        }
        JSONObject envelope = new JSONObject(res.text());
        if (!"1".equals(envelope.optString("status"))) {
            String message = envelope.optString("msg", "接口没有返回数据");
            throw new IllegalStateException(message.length() > 120 ? message.substring(0, 120) : message);
        }
        Object data = envelope.opt("data");
        if (data instanceof JSONObject) return (JSONObject) data;
        if (data instanceof JSONArray) return new JSONObject().put("items", data);
        return new JSONObject();
    }

    /** 并行探活，最快回话的那条钉住。主域常年打不通，串行会让首屏卡十几秒。 */
    private synchronized String ensureBase() throws Exception {
        if (!base.isEmpty()) return base;
        List<Future<String>> probes = new ArrayList<>();
        for (String host : MIRRORS) {
            probes.add(POOL.submit(() -> {
                edgeAt(host, "/api/videos?page=1&size=1", 6000);
                return host;
            }));
        }
        Exception lastError = null;
        long deadline = System.currentTimeMillis() + 7000;
        while (!probes.isEmpty()) {
            for (java.util.Iterator<Future<String>> it = probes.iterator(); it.hasNext(); ) {
                Future<String> probe = it.next();
                try {
                    if (probe.isDone()) {
                        base = probe.get();
                        it.remove();
                        return base;
                    }
                } catch (Exception error) {
                    lastError = error;
                    it.remove();
                }
            }
            if (System.currentTimeMillis() > deadline) break;
            Thread.sleep(60);
        }
        throw new IllegalStateException("黄果 AI 全部镜像无响应"
                + (lastError == null ? "" : "（" + lastError.getMessage() + "）"));
    }

    private JSONObject edge(String path) throws Exception {
        Exception lastError = null;
        for (int round = 0; round < 2; round++) {
            String host = ensureBase();
            try {
                return edgeAt(host, path, 15000);
            } catch (Exception error) {
                lastError = error;
                base = "";
            }
        }
        throw new IllegalStateException("黄果 AI 线路暂不可用"
                + (lastError == null ? "" : "（" + lastError.getMessage() + "）"));
    }

    /* ---------------- 映射 ---------------- */

    private String absolute(String value) {
        String raw = value == null ? "" : value.trim();
        if (raw.isEmpty()) return "";
        if (raw.matches("(?i)^https?://.*")) return raw;
        String host = base;
        if (host.isEmpty()) return raw;
        return host + (raw.startsWith("/") ? "" : "/") + raw;
    }

    private static JSONArray rowsOf(JSONObject data) {
        JSONArray items = data.optJSONArray("items");
        if (items != null) return items;
        JSONArray list = data.optJSONArray("list");
        return list == null ? new JSONArray() : list;
    }

    private JSONObject card(JSONObject row, String category) throws Exception {
        int episodes = row.optInt("total_episodes", row.optInt("episode_count", 0));
        JSONArray tags = new JSONArray();
        JSONArray raw = row.optJSONArray("tags");
        for (int i = 0; raw != null && i < raw.length() && tags.length() < 4; i++) {
            String tag = raw.optString(i, "").trim();
            if (!tag.isEmpty()) tags.put(tag);
        }
        double hot = row.optDouble("hot", 0);
        if (hot >= 10000) tags.put(String.format(java.util.Locale.ROOT, "%.1f万热度", hot / 10000));
        String finishedRaw = row.optString("is_finished", "");
        boolean finished = row.optBoolean("is_finished", false) || "true".equals(finishedRaw) || "1".equals(finishedRaw);
        double score = row.optDouble("score", 0);
        String label = episodes == 0 ? ""
                : (finished ? "全 " + episodes + " 集" : "更新至 " + episodes + " 集");
        String name = category == null || category.isEmpty() ? "AI 短剧" : category;
        return new JSONObject()
                .put("id", row.optString("id", ""))
                .put("title", cut(row.optString("title", ""), 200))
                .put("cover", absolute(row.optString("cover", "")))
                .put("description", cut(row.optString("description", ""), 4000))
                .put("score", score > 0 ? String.format(java.util.Locale.ROOT, "%.1f", score) : "")
                .put("episodeLabel", label)
                .put("category", cut(name, 20))
                .put("tags", tags)
                .put("status", finished ? "finished" : "ongoing");
    }

    private static String cut(String value, int max) {
        String text = value == null ? "" : value.trim();
        return text.length() <= max ? text : text.substring(0, max);
    }

    private JSONObject list(String path, int page, int size, String category) throws Exception {
        JSONObject data = edge(path);
        JSONArray rows = rowsOf(data);
        JSONArray items = new JSONArray();
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) continue;
            JSONObject card = card(row, category);
            if (card.optString("id").isEmpty() || card.optString("title").isEmpty()) continue;
            items.put(card);
        }
        return new JSONObject().put("items", items).put("nextPage", nextPage(data, page, size));
    }

    private static Object nextPage(JSONObject data, int page, int size) {
        JSONObject pagination = data.optJSONObject("pagination");
        int pages = pagination == null ? 0 : pagination.optInt("pages", 0);
        if (pages > 0) return page < pages ? page + 1 : JSONObject.NULL;
        int total = pagination == null ? 0 : pagination.optInt("total", pagination.optInt("count", 0));
        int rows = rowsOf(data).length();
        if (pages == 0 && total > 0) return page * size < total ? page + 1 : JSONObject.NULL;
        return rows >= size ? page + 1 : JSONObject.NULL;
    }

    @Override public JSONArray categories() throws Exception {
        JSONArray out = new JSONArray();
        out.put(new JSONObject().put("id", "").put("name", "全部"));
        out.put(new JSONObject().put("id", "new").put("name", "最新"));
        out.put(new JSONObject().put("id", "hot").put("name", "热门榜"));
        for (String[] item : AI_CATEGORIES) {
            out.put(new JSONObject().put("id", item[0]).put("name", item[1]));
        }
        return out;
    }

    @Override public JSONObject home() throws Exception {
        Future<JSONObject> feedFuture = POOL.submit(() -> {
            try {
                return list("/api/videos?page=1&size=20", 1, 20, "AI 短剧");
            } catch (Exception error) {
                return new JSONObject().put("items", new JSONArray()).put("nextPage", JSONObject.NULL);
            }
        });
        Future<JSONObject> rankFuture = POOL.submit(() -> {
            try {
                return edge("/api/ranks/hot");
            } catch (Exception error) {
                return null;
            }
        });

        JSONObject feed = feedFuture.get();
        JSONArray hot = new JSONArray();
        JSONObject ranks = null;
        try {
            ranks = rankFuture.get(15, TimeUnit.SECONDS);
        } catch (Exception ignored) { }
        if (ranks != null) {
            JSONArray rows = rowsOf(ranks);
            for (int i = 0; i < rows.length(); i++) {
                JSONObject row = rows.optJSONObject(i);
                if (row == null) continue;
                JSONObject card = card(row, row.optString("cate_name", ""));
                if (card.optString("id").isEmpty() || card.optString("title").isEmpty()) continue;
                hot.put(card);
            }
        }
        JSONArray feedItems = feed.optJSONArray("items");
        JSONArray primary = hot.length() > 0 ? hot : feedItems;
        return new JSONObject()
                .put("featured", slice(primary, 0, 5, true))
                .put("items", feedItems)
                .put("homepageRecommend", slice(primary, 0, 6, false))
                .put("homepageNewest", slice(feedItems, 0, 6, false))
                .put("recommend", new JSONObject().put("items", primary).put("nextPage", JSONObject.NULL))
                .put("newest", new JSONObject().put("items", feedItems).put("nextPage", feed.opt("nextPage")));
    }

    private static JSONArray slice(JSONArray rows, int from, int to, boolean fillDescription) throws Exception {
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
        if (value.isEmpty() || "new".equals(value) || "latest".equals(value)) {
            return list("/api/videos?page=" + page + "&size=24", page, 24, "AI 短剧");
        }
        if ("hot".equals(value)) {
            JSONObject data;
            try {
                data = edge("/api/ranks/hot");
            } catch (Exception error) {
                return new JSONObject().put("items", new JSONArray()).put("nextPage", JSONObject.NULL);
            }
            JSONArray rows = rowsOf(data);
            JSONArray items = new JSONArray();
            for (int i = 0; i < rows.length(); i++) {
                JSONObject row = rows.optJSONObject(i);
                if (row == null) continue;
                JSONObject card = card(row, row.optString("cate_name", ""));
                if (card.optString("id").isEmpty() || card.optString("title").isEmpty()) continue;
                items.put(card);
            }
            return new JSONObject().put("items", items).put("nextPage", JSONObject.NULL);
        }
        String name = "";
        for (String[] item : AI_CATEGORIES) if (item[0].equals(value)) name = item[1];
        return list("/api/videos/category/" + enc(value) + "?sort=hot&page=" + page + "&size=24", page, 24, name);
    }

    @Override public JSONObject search(String keyword, int page) throws Exception {
        return list("/api/search?q=" + enc(keyword) + "&page=" + page + "&size=20", page, 20, "AI 短剧");
    }

    /* ---------------- 详情 / 播放 ---------------- */

    private volatile String detailId = "";
    private volatile String detailTitle = "";
    private volatile String detailCover = "";
    private volatile JSONArray detailEpisodes;

    @Override public JSONObject detail(String id) throws Exception {
        String key = id == null ? "" : id.trim();
        key = key.replaceAll("^/+|/+$", "").replaceAll("^detail/", "");
        if (!key.matches("^[A-Za-z0-9_-]{1,64}$")) throw new IllegalArgumentException("无效剧集");
        JSONObject data = edge("/api/videos/" + enc(key));
        String breadcrumb = "";
        JSONArray crumb = data.optJSONArray("breadcrumb");
        if (crumb != null && crumb.length() > 0) {
            JSONObject first = crumb.optJSONObject(0);
            if (first != null) breadcrumb = first.optString("name", "");
        }
        JSONObject info = card(data, breadcrumb);
        if (info.optString("id").isEmpty()) throw new IllegalStateException("黄果 AI 没有返回这部剧");

        List<JSONObject> episodes = new ArrayList<>();
        JSONArray rows = data.optJSONArray("episodes");
        for (int i = 0; rows != null && i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) continue;
            int number = row.optInt("ep_num", 0);
            if (number <= 0) continue;
            episodes.add(new JSONObject().put("number", number)
                    .put("title", row.optString("title", "第 " + number + " 集")));
        }
        if (episodes.isEmpty()) episodes.add(new JSONObject().put("number", 1).put("title", info.optString("title")));
        episodes.sort((a, b) -> a.optInt("number") - b.optInt("number"));

        JSONArray listed = new JSONArray();
        for (JSONObject item : episodes) {
            listed.put(new JSONObject().put("number", item.optInt("number"))
                    .put("url", base + "/video/" + info.optString("id") + "/ep-" + item.optInt("number") + "/"));
        }
        detailId = info.optString("id");
        detailTitle = info.optString("title");
        detailCover = info.optString("cover");
        detailEpisodes = new JSONArray(episodes);

        return new JSONObject()
                .put("id", info.optString("id"))
                .put("title", info.optString("title"))
                .put("cover", info.optString("cover"))
                .put("description", info.optString("description"))
                .put("score", info.optString("score"))
                .put("tags", info.optJSONArray("tags"))
                .put("episodeLabel", "共 " + episodes.size() + " 集")
                .put("episodes", listed);
    }

    @Override public JSONObject episode(String id, int number) throws Exception {
        String key = id == null ? "" : id.trim();
        if (!key.equals(detailId) || detailEpisodes == null) detail(key);
        boolean exists = false;
        for (int i = 0; i < detailEpisodes.length(); i++) {
            JSONObject item = detailEpisodes.optJSONObject(i);
            if (item != null && item.optInt("number") == number) exists = true;
        }
        if (!exists) throw new IllegalStateException("这一集不存在");
        JSONObject data = edge("/api/videos/" + enc(detailId) + "/play?ep=" + number + "&page_texts=0");
        String url = absolute(data.optString("video_url", data.optString("video_url_hevc", "")));
        if (!url.matches("(?i)^https?://.*")) throw new IllegalStateException("黄果 AI 没有给出播放地址");
        return new JSONObject()
                .put("url", url)
                .put("referer", base + "/video/" + detailId + "/")
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
