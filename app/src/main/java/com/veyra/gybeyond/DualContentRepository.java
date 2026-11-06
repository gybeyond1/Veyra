package com.veyra.gybeyond;

import android.content.Context;
import org.json.JSONObject;

final class DualContentRepository {
    private final String source;
    private final ContentMode mode;
    private final SiteRepository huangguo;
    // 私密模式选了接口型源（剧果/野果/帝果…）时不为 null：解析全在后端，端侧只转发
    private final BackendSiteRepository remote;
    private final HongguoRepository hongguo;

    DualContentRepository(Context context) {
        this(context, ContentMode.get(context).active(), HotUpdateManager.get(context).currentSite());
    }
    DualContentRepository(Context context, String source, SiteProfile profile) {
        this.source = source; mode = ContentMode.get(context);
        huangguo = new SiteRepository(context, profile);
        String site = PrivateSite.get(context);
        remote = PrivateSite.HUANGGUO.equals(site) ? null : new BackendSiteRepository(context, site);
        hongguo = new HongguoRepository();
        com.hongguotv.core.RelayPlayback.setProxyBaseUrl(ServerConfig.get(context));
    }
    private boolean privateMode() { mode.require(source); return ContentMode.PRIVATE.equals(source); }
    JSONObject home() throws Exception { return privateMode() ? (remote != null ? remote.home() : huangguo.home()) : hongguo.home(); }
    JSONObject category(String id, int page) throws Exception { return privateMode() ? (remote != null ? remote.category(id, page) : huangguo.category(id, page)) : hongguo.category(id, page); }
    JSONObject recommend(int page, boolean newest) throws Exception { return privateMode() ? (remote != null ? remote.recommend(page, newest) : huangguo.recommend(page, newest)) : hongguo.recommend(page, newest); }
    JSONObject search(String term, boolean suggest) throws Exception { return privateMode() ? (remote != null ? remote.search(term, suggest) : huangguo.search(term, suggest)) : hongguo.search(term); }
    JSONObject detail(String id) throws Exception { return privateMode() ? (remote != null ? remote.detail(id) : huangguo.detail(id)) : hongguo.detail(id); }
    JSONObject episode(String id, int number) throws Exception { return privateMode() ? (remote != null ? remote.episode(id, number) : huangguo.episode(id, number)) : hongguo.episode(id, number); }
    String coverData(String url) throws Exception { return privateMode() ? (remote != null ? remote.coverData(url) : huangguo.coverData(url)) : hongguo.coverData(url); }
    JSONObject tags() throws Exception {
        return privateMode() ? (remote != null ? remote.tags() : huangguo.tags()) : hongguo.tags();
    }
    JSONObject tagListing(String slug, int page) throws Exception {
        return privateMode() ? (remote != null ? remote.tagListing(slug, page) : huangguo.tagListing(slug, page)) : hongguo.tagListing(slug, page);
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
    void clearCovers() { if (!privateMode()) return; if (remote != null) remote.clearCovers(); else huangguo.clearCovers(); }
}
