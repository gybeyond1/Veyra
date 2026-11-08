package com.veyra.gybeyond.localsrc;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/**
 * 黄果旧版（server/sources/cloudfront.js 的端侧版）。
 *
 * 接口域名走 CloudFront，国内机房出口会直接 ECONNRESET，手机出口正常。
 */
public final class HuangguoLegacy implements LocalSource {

    private static final String BASE = "https://dr6skssi3nxbk.cloudfront.net";
    private static final String FRONT = "https://d2pypzndaqisk.cloudfront.net";
    private static final String CDN = "https://sjljsla.lkkwip.cn";
    private static final String UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) "
            + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1";

    private static final ExecutorService POOL = Executors.newFixedThreadPool(3);

    private final LegacyCore core;

    public HuangguoLegacy(LegacyCore.Store store) {
        core = new LegacyCore(new LegacyCore.Config() {
            @Override public String key() { return "cloudfront"; }
            @Override public String label() { return "黄果旧版"; }
            @Override public String[] bases() { return new String[]{BASE}; }
            @Override public String front() { return FRONT; }
            @Override public String cdn() { return CDN; }
            @Override public String ua() { return UA; }
            @Override public String userAgent(String device) {
                return "BuildID=com.abc.Butterfly;SysType=ios;DevID=" + device
                        + ";Ver=1.0.0;DevType=iPhone;DeviceBrand=APPLE;DeviceModel=iPhone;"
                        + "SystemName=iOS;SystemVersion=18.7;Terminal=1;IsH5=1;"
                        + "Sid=00000000000000000000000000000000";
            }
            @Override public String newDevice() {
                return Crypt.randomHex(4).toUpperCase() + System.currentTimeMillis();
            }
        }, store);
    }

    @Override public String id() { return "cloudfront"; }
    @Override public String name() { return "黄果旧版"; }

    /* ---------------- 数据映射 ---------------- */

    private static String coverUrl(String value) {
        String raw = value == null ? "" : value.trim();
        if (raw.isEmpty()) return "";
        if (raw.startsWith("//")) return "https:" + raw;
        if (raw.matches("(?i)^https?://.*")) return raw;
        String path = raw.replaceAll("^/+", "");
        return (path.startsWith("upload") ? "https://pic.zdmhyg.cn/" : "https://zzzznnn.lkkwip.cn/") + path;
    }

    private static JSONObject card(JSONObject row, String tabName) throws Exception {
        int episodes = row.optInt("totalEpisode", row.optInt("updateEpisode", 0));
        JSONArray tags = new JSONArray();
        String anchor = row.optString("anchor", "");
        if (!anchor.isEmpty()) tags.put(cut(anchor, 12));
        JSONArray names = row.optJSONArray("tagNames");
        for (int i = 0; names != null && i < names.length() && tags.length() < 3; i++) {
            String tag = names.optString(i, "");
            if (!tag.isEmpty()) tags.put(cut(tag, 12));
        }
        boolean finished = row.optInt("continueStatus", 0) == 2;
        double score = row.optDouble("scoreExtra", 0);
        String label = episodes == 0 ? ""
                : (finished ? "全 " + episodes + " 集" : "更新至 " + episodes + " 集");
        String category = row.optString("categoryName", tabName == null ? "" : tabName);
        if (category.isEmpty()) category = "短剧";
        return new JSONObject()
                .put("id", row.optString("id", ""))
                .put("title", cut(row.optString("title", ""), 200))
                .put("cover", coverUrl(row.optString("cover", row.optString("horizontalCover", ""))))
                .put("description", cut(row.optString("summary", ""), 4000))
                .put("score", score > 0 ? String.format(java.util.Locale.ROOT, "%.1f", score) : "")
                .put("episodeLabel", label)
                .put("category", cut(category, 20))
                .put("tags", tags)
                .put("status", finished ? "finished" : "");
    }

    private static String cut(String value, int max) {
        String text = value == null ? "" : value.trim();
        return text.length() <= max ? text : text.substring(0, max);
    }

    /* ---------------- 列表 ---------------- */

    private volatile JSONArray tabsCache;
    private volatile long tabsAt;

    private JSONArray tabs() throws Exception {
        long now = System.currentTimeMillis();
        if (tabsCache != null && now - tabsAt < 30L * 60 * 1000) return tabsCache;
        JSONObject data = core.api("/api/app/playlet-tab/all", null);
        JSONArray rows = data.optJSONArray("list");
        if (rows == null) rows = new JSONArray();
        JSONArray items = new JSONArray();
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) continue;
            String id = row.optString("id", "");
            String name = row.optString("name", "");
            if (id.isEmpty() || name.isEmpty()) continue;
            items.put(new JSONObject().put("id", id).put("name", cut(name, 24)));
        }
        if (items.length() == 0) throw new IllegalStateException("黄果旧版没有返回可用分类");
        tabsCache = items;
        tabsAt = now;
        return items;
    }

    private JSONObject tabPage(String tabId, int page) throws Exception {
        JSONObject params = new JSONObject()
                .put("pageNumber", page)
                .put("pageSize", 20)
                .put("tabSortType", "1");
        JSONObject data = core.api("/api/app/playlet/home/tab/" + enc(tabId), params);
        JSONArray rows = data.optJSONArray("list");
        if (rows == null) rows = new JSONArray();
        String tabName = "";
        JSONArray tabs = tabs();
        for (int i = 0; i < tabs.length(); i++) {
            JSONObject item = tabs.optJSONObject(i);
            if (item != null && tabId.equals(item.optString("id"))) tabName = item.optString("name");
        }
        JSONArray items = new JSONArray();
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) continue;
            JSONObject card = card(row, tabName);
            if (card.optString("id").isEmpty() || card.optString("title").isEmpty()) continue;
            items.put(card);
        }
        return new JSONObject().put("items", items)
                .put("nextPage", rows.length() >= 20 ? page + 1 : JSONObject.NULL);
    }

    @Override public JSONArray categories() throws Exception { return tabs(); }

    @Override public JSONObject home() throws Exception {
        final JSONArray list = tabs();
        final String firstId = list.optJSONObject(0).optString("id");
        final String secondId = list.length() > 1 ? list.optJSONObject(1).optString("id") : "";

        Future<JSONObject> first = POOL.submit(() -> tabPage(firstId, 1));
        Future<JSONObject> second = secondId.isEmpty() ? null : POOL.submit((Callable<JSONObject>) () -> {
            try {
                return tabPage(secondId, 1);
            } catch (Exception error) {
                return new JSONObject().put("items", new JSONArray()).put("nextPage", JSONObject.NULL);
            }
        });

        JSONObject one = first.get();
        JSONObject two = second == null
                ? new JSONObject().put("items", new JSONArray()).put("nextPage", JSONObject.NULL)
                : second.get();
        JSONArray a = one.optJSONArray("items");
        JSONArray b = two.optJSONArray("items");
        return new JSONObject()
                .put("featured", slice(a, 0, 5, true))
                .put("items", a)
                .put("homepageRecommend", slice(a, 0, 6, false))
                .put("homepageNewest", slice(b, 0, 6, false))
                .put("recommend", new JSONObject().put("items", a).put("nextPage", one.opt("nextPage")))
                .put("newest", new JSONObject().put("items", b).put("nextPage", two.opt("nextPage")));
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
        if (!value.isEmpty() && !"new".equals(value) && !"latest".equals(value)) return tabPage(value, page);
        JSONArray list = tabs();
        return tabPage(list.optJSONObject(0).optString("id"), page);
    }

    @Override public JSONObject search(String keyword, int page) throws Exception {
        JSONObject params = new JSONObject()
                .put("keyword", keyword == null ? "" : keyword)
                .put("pageNumber", page)
                .put("pageSize", 20);
        JSONObject data = core.api("/api/app/playlet/keyword/search", params);
        JSONArray rows = data.optJSONArray("list");
        if (rows == null) rows = new JSONArray();
        JSONArray items = new JSONArray();
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) continue;
            JSONObject card = card(row, "");
            if (card.optString("id").isEmpty() || card.optString("title").isEmpty()) continue;
            items.put(card);
        }
        return new JSONObject().put("items", items)
                .put("nextPage", rows.length() >= 20 ? page + 1 : JSONObject.NULL);
    }

    /* ---------------- 详情 / 播放 ---------------- */

    private volatile String lastDetailId = "";
    private volatile String lastDetailTitle = "";
    private volatile String lastDetailCover = "";
    private volatile JSONArray lastDetailEpisodes;

    @Override public JSONObject detail(String id) throws Exception {
        String key = id == null ? "" : id.trim();
        if (!key.matches("(?i)^[0-9a-f]{16,32}$")) throw new IllegalArgumentException("无效剧集");
        JSONObject data = core.api("/api/app/playlet/detail/" + enc(key), null);
        JSONObject info = card(data, "");
        if (info.optString("title").isEmpty()) throw new IllegalStateException("黄果旧版没有返回这部剧");
        JSONArray rows = data.optJSONArray("chapters");
        if (rows == null || rows.length() == 0) {
            JSONObject extra = core.api("/api/app/playlet-chapter/list/" + enc(key), null);
            rows = extra.optJSONArray("list");
            if (rows == null) rows = new JSONArray();
        }
        List<JSONObject> episodes = new ArrayList<>();
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) continue;
            int number = row.optInt("currentEpisode", i + 1);
            episodes.add(new JSONObject()
                    .put("number", number)
                    .put("episodeId", row.optString("id", String.valueOf(number)))
                    .put("title", row.optString("title", "第 " + number + " 集"))
                    .put("videoUrl", row.optString("videoUrl", "")));
        }
        episodes.sort((a, b) -> a.optInt("number") - b.optInt("number"));
        if (episodes.isEmpty()) throw new IllegalStateException("这一部没有可播放的分集");

        JSONArray listed = new JSONArray();
        for (JSONObject item : episodes) {
            listed.put(new JSONObject()
                    .put("number", item.optInt("number"))
                    .put("url", FRONT + "/video/" + key + "/" + item.optInt("number")));
        }
        lastDetailId = key;
        lastDetailTitle = info.optString("title");
        lastDetailCover = info.optString("cover");
        lastDetailEpisodes = new JSONArray(episodes);

        return new JSONObject()
                .put("id", key)
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
        if (!key.equals(lastDetailId) || lastDetailEpisodes == null) detail(key);
        String videoUrl = "";
        for (int i = 0; i < lastDetailEpisodes.length(); i++) {
            JSONObject item = lastDetailEpisodes.optJSONObject(i);
            if (item != null && item.optInt("number") == number) videoUrl = item.optString("videoUrl");
        }
        if (videoUrl.isEmpty()) throw new IllegalStateException("这一集没有可用的播放地址");
        return new JSONObject()
                .put("url", core.playUrl(videoUrl))
                .put("referer", core.referer())
                .put("title", lastDetailTitle)
                .put("cover", lastDetailCover);
    }

    private static String enc(String value) {
        try {
            return java.net.URLEncoder.encode(value, "UTF-8");
        } catch (Exception error) {
            return value;
        }
    }
}
