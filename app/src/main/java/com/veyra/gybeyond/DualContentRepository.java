package com.veyra.gybeyond;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

/**
 * 私密模式的内容仓库：后端网关 + 端侧解析两条路，公开模式只有红果。
 *
 * 为什么要两条路，以及为什么是「列表端侧优先、播放后端优先」：
 *  · 列表/详情：端侧直连源站更快，而且数据结构和后端同构（后端本来就是照端侧实现抄的），
 *    手机网络能通时没必要绕一圈服务器；端侧解析失败（站点改版 / 手机出口也被拦）
 *    立刻改走后端，不让人对着一片空白等。
 *  · 播放：统一走后端网关，和 WebUI 完全同一条链路（同一份解析、同一个令牌流、
 *    同一个代理出口）。以前这里端侧优先，结果出现「WebUI 能播、APP 播不了」
 *    这种谁都解释不清的分叉 —— 播放这种最容易坏的环节，只能有一份实现。
 *    后端不可达时才退回端侧本机网关（127.0.0.1）直连。
 */
final class DualContentRepository {
    private static final String TAG = "VeyraContent";

    private final String source;
    private final ContentMode mode;
    // 后端网关：解析与播放的主通道，私密源清单里的五个源都走它
    private final BackendSiteRepository remote;
    // 端侧实现：黄果旧版 / 黄果 AI / 帝果 / 剧果 能在手机上自己解析
    private final LocalSiteRepository local;
    private final HongguoRepository hongguo;

    private interface Fetcher {
        JSONObject run() throws Exception;
    }

    DualContentRepository(Context context) {
        this(context, ContentMode.get(context).active(), HotUpdateManager.get(context).currentSite());
    }

    DualContentRepository(Context context, String source, SiteProfile profile) {
        this.source = source;
        mode = ContentMode.get(context);
        String site = PrivateSite.get(context);
        local = LocalSiteRepository.supports(site) ? new LocalSiteRepository(context, site) : null;
        remote = new BackendSiteRepository(context, site);
        hongguo = new HongguoRepository();
        com.hongguotv.core.RelayPlayback.setProxyBaseUrl(ServerConfig.get(context));
    }

    private boolean privateMode() {
        mode.require(source);
        return ContentMode.PRIVATE.equals(source);
    }

    /** 列表类：手机直连优先，端侧失败再走后端。 */
    private JSONObject preferLocal(Fetcher localCall, Fetcher remoteCall) throws Exception {
        if (local != null) {
            try {
                return localCall.run();
            } catch (Exception error) {
                Log.w(TAG, "端侧解析失败，改走后端：" + error.getMessage());
            }
        }
        return remoteCall.run();
    }

    /** 播放：后端网关优先（与 WebUI 同一条链路），后端不可达才退回端侧。 */
    private JSONObject preferBackend(Fetcher remoteCall, Fetcher localCall) throws Exception {
        try {
            return remoteCall.run();
        } catch (Exception error) {
            if (local == null) throw error;
            Log.w(TAG, "后端播放地址失败，改走本机直连：" + error.getMessage());
        }
        return localCall.run();
    }

    JSONObject home() throws Exception {
        if (!privateMode()) return hongguo.home();
        return preferLocal(() -> local.home(), () -> remote.home());
    }

    JSONObject category(String id, int page) throws Exception {
        if (!privateMode()) return hongguo.category(id, page);
        return preferLocal(() -> local.category(id, page), () -> remote.category(id, page));
    }

    JSONObject recommend(int page, boolean newest) throws Exception {
        if (!privateMode()) return hongguo.recommend(page, newest);
        return preferLocal(() -> local.recommend(page, newest), () -> remote.recommend(page, newest));
    }

    JSONObject search(String term, boolean suggest) throws Exception {
        if (!privateMode()) return hongguo.search(term);
        return preferLocal(() -> local.search(term, suggest), () -> remote.search(term, suggest));
    }

    JSONObject detail(String id) throws Exception {
        if (!privateMode()) return hongguo.detail(id);
        return preferLocal(() -> local.detail(id), () -> remote.detail(id));
    }

    JSONObject episode(String id, int number) throws Exception {
        if (!privateMode()) return hongguo.episode(id, number);
        return preferBackend(() -> remote.episode(id, number), () -> local.episode(id, number));
    }

    /** 红果专用：后台把某集解析好并预热首片；私密模式没有这条链路。 */
    void prewarmEpisode(String id, int number) {
        if (!privateMode()) hongguo.prewarm(id, number);
    }

    String coverData(String url) throws Exception {
        if (!privateMode()) return hongguo.coverData(url);
        // 封面走端侧：手机出口能取到的图，服务器反倒常被图床拦；端侧取不到再让后端试
        if (local != null) {
            try {
                return local.coverData(url);
            } catch (Exception error) {
                Log.w(TAG, "端侧封面失败，改走后端：" + error.getMessage());
            }
        }
        return remote.coverData(url);
    }

    /*
     * 相关作品 / 制作方 / 评论 / 弹幕只有红果源有。
     * 私密模式返回空结构而不是抛错：前端照常渲染详情页，这几块显示「暂无」。
     */
    JSONObject related(String id, String title) throws Exception {
        if (privateMode()) return new JSONObject().put("id", id).put("items", new org.json.JSONArray());
        return hongguo.related(id, title);
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

    /**
     * 刷剧随机池：只有红果源有（从官网分类页随机取样）。私密模式返回空结构，
     * 前端会退回首页那两栏。
     */
    JSONObject bingeRandom(int want) throws Exception {
        if (privateMode()) return new JSONObject().put("items", new org.json.JSONArray());
        return hongguo.bingeRandom(want);
    }

    JSONObject tags() throws Exception {
        if (!privateMode()) return hongguo.tags();
        return preferLocal(() -> local.tags(), () -> remote.tags());
    }

    JSONObject tagListing(String slug, int page) throws Exception {
        if (!privateMode()) return hongguo.tagListing(slug, page);
        return preferLocal(() -> local.tagListing(slug, page), () -> remote.tagListing(slug, page));
    }

    org.json.JSONArray sequelCandidates(JSONObject item) throws Exception {
        org.json.JSONArray result = new org.json.JSONArray();
        if (privateMode()) return result;
        String title = item.optString("title"), query = SequelMatcher.query(title);
        if (query.isEmpty()) return result;
        org.json.JSONArray rows = hongguo.searchSequels(query).optJSONArray("items");
        if (rows == null) return result;
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null || row.optString("id").equals(item.optString("id"))) continue;
            String category = item.optString("category");
            if (("short".equals(category) || "comic".equals(category)) && !category.equals(row.optString("category"))) continue;
            if (SequelMatcher.matches(title, row.optString("title"))) result.put(row);
        }
        return result;
    }

    void clearCovers() {
        if (!privateMode()) return;
        if (local != null) local.clearCovers();
        remote.clearCovers();
    }
}
