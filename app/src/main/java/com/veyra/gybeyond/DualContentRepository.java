package com.veyra.gybeyond;

import android.content.Context;
import org.json.JSONObject;

final class DualContentRepository {
    private final String source;
    private final ContentMode mode;
    private final SiteRepository huangguo;
    private final HongguoRepository hongguo;

    DualContentRepository(Context context) {
        this(context, ContentMode.get(context).active(), HotUpdateManager.get(context).currentSite());
    }
    DualContentRepository(Context context, String source, SiteProfile profile) {
        this.source = source; mode = ContentMode.get(context);
        huangguo = new SiteRepository(context, profile);
        hongguo = new HongguoRepository();
        com.hongguotv.core.RelayPlayback.setProxyBaseUrl(ServerConfig.get(context));
    }
    private boolean privateMode() { mode.require(source); return ContentMode.PRIVATE.equals(source); }
    JSONObject home() throws Exception { return privateMode() ? huangguo.home() : hongguo.home(); }
    JSONObject category(String id, int page) throws Exception { return privateMode() ? huangguo.category(id, page) : hongguo.category(id, page); }
    JSONObject recommend(int page, boolean newest) throws Exception { return privateMode() ? huangguo.recommend(page, newest) : hongguo.recommend(page, newest); }
    JSONObject search(String term, boolean suggest) throws Exception { return privateMode() ? huangguo.search(term, suggest) : hongguo.search(term); }
    JSONObject detail(String id) throws Exception { return privateMode() ? huangguo.detail(id) : hongguo.detail(id); }
    JSONObject episode(String id, int number) throws Exception { return privateMode() ? huangguo.episode(id, number) : hongguo.episode(id, number); }
    String coverData(String url) throws Exception { return privateMode() ? huangguo.coverData(url) : hongguo.coverData(url); }
    /*
     * 相关作品 / 制作方 / 评论 / 弹幕只有红果源有。
     * 私密（黄果）模式返回空结构而不是抛错：前端照常渲染详情页，这几块显示「暂无」。
     */
    JSONObject related(String id) throws Exception {
        if (privateMode()) return new JSONObject().put("id", id).put("items", new org.json.JSONArray());
        return hongguo.related(id);
    }
    JSONObject producer(String id) throws Exception {
        if (privateMode()) return new JSONObject().put("name", "").put("mediaId", "");
        return hongguo.producer(id);
    }
    JSONObject producerWorks(String name, String mediaId, int page) throws Exception {
        if (privateMode()) return new JSONObject().put("items", new org.json.JSONArray()).put("hasMore", false);
        return hongguo.producerWorks(name, mediaId, page);
    }
    JSONObject comments(String id, String episodeId, String cursor) throws Exception {
        if (privateMode()) return new JSONObject().put("items", new org.json.JSONArray()).put("hasMore", false);
        return hongguo.comments(id, episodeId, cursor);
    }
    JSONObject danmaku(String id, String episodeId, long start, long duration) throws Exception {
        if (privateMode()) return new JSONObject().put("items", new org.json.JSONArray()).put("nextMS", duration);
        return hongguo.danmaku(id, episodeId, start, duration);
    }

    JSONObject tags() throws Exception {
        return privateMode() ? huangguo.tags() : hongguo.tags();
    }
    JSONObject tagListing(String slug, int page) throws Exception {
        return privateMode() ? huangguo.tagListing(slug, page) : hongguo.tagListing(slug, page);
    }
    org.json.JSONArray sequelCandidates(JSONObject item) throws Exception {
        org.json.JSONArray result = new org.json.JSONArray();
        if (privateMode()) return result;
        String title = item.optString("title"), query = SequelMatcher.query(title);
        if (query.isEmpty()) return result;
        org.json.JSONArray rows = hongguo.searchSequels(query).optJSONArray("items");
        if (rows == null) return result;
        for (int i=0; i<rows.length(); i++) {
            JSONObject row=rows.optJSONObject(i);
            if (row == null || row.optString("id").equals(item.optString("id"))) continue;
            String category=item.optString("category");
            if (("short".equals(category) || "comic".equals(category)) && !category.equals(row.optString("category"))) continue;
            if (SequelMatcher.matches(title,row.optString("title"))) result.put(row);
        }
        return result;
    }
    void clearCovers() { if (privateMode()) huangguo.clearCovers(); }
}
