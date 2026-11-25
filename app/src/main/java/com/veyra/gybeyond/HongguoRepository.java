package com.veyra.gybeyond;

import android.util.Base64;
import com.hongguotv.core.CatalogPage;
import com.hongguotv.core.ContentRepository;
import com.hongguotv.core.ContentType;
import com.hongguotv.core.Detail;
import com.hongguotv.core.RankPosition;
import com.hongguotv.core.Series;
import com.hongguotv.core.StreamInfo;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONObject;
import android.util.LruCache;

final class HongguoRepository {
    private final ContentRepository upstream = new ContentRepository(new OkHttpClient(), System::currentTimeMillis);
    /*
     * 详情/播放地址缓存必须是「进程级」的。
     *
     * 之前挂在实例上：MainActivity 里一个 HongguoRepository，PlayerActivity 每次又 new 一个，
     * 于是详情页辛苦预热好的播放地址，进播放页后新实例的缓存是空的，又去重新签名取流 ——
     * 拿到的是带新签名参数的新 URL，HongguoPlayback 池里按旧 URL 预热好的实例直接作废。
     * 表现就是「刚看过这一集，退出去再点进来还是要等」。
     */
    private static final LruCache<String, Detail> details = new LruCache<>(32);
    private final HongguoGenres genres = new HongguoGenres(upstream.getHttp());
    private final HongguoSearch search = new HongguoSearch(upstream.getHttp());
    private final HongguoRandomFeed randomFeed = new HongguoRandomFeed(upstream.getHttp());
    /** 网页详情 404 时的兜底接口（不走网页，直接用 App 协议拿分集）。 */
    private final HongguoAppApi appApi = new HongguoAppApi();

    JSONObject tags() throws Exception { return genres.tags(); }
    JSONObject tagListing(String slug, int page) throws Exception { return genres.listing(slug, page); }

    private static JSONObject card(Series item, String category) throws Exception {
        JSONArray tags = new JSONArray();
        for (String tag : item.getTags().split(" · ")) if (!tag.isEmpty()) tags.put(tag);
        return new JSONObject().put("id", item.getId()).put("title", item.getTitle())
                .put("cover", item.getCover()).put("description", item.getDescription()).put("score", "")
                .put("episodeLabel", item.getBadge()).put("category", category).put("tags", tags);
    }
    private static final java.util.List<String> BOARDS =
            java.util.Arrays.asList("hot-drama", "hot-real-drama", "hot-comic-drama", "hot-ai-drama");

    private static JSONObject listing(CatalogPage page, int number, String category) throws Exception {
        JSONArray items = new JSONArray();
        // 只有榜单页带 positions（名次 + 热度）；普通分类这里是 null
        java.util.Map<String, RankPosition> positions =
                page.getRanking() == null ? null : page.getRanking().getPositions();
        for (Series item : page.getItems()) {
            JSONObject card = card(item, category);
            RankPosition position = positions == null ? null : positions.get(item.getId());
            if (position != null) {
                if (position.getRank() != null) card.put("rank", position.getRank());
                if (!position.getHeat().isEmpty()) card.put("heat", position.getHeat());
            }
            items.put(card);
        }
        return new JSONObject().put("items", items).put("nextPage", page.getHasMore() ? number + 1 : JSONObject.NULL);
    }
    /*
     * 榜单的翻页现实：官网每个榜固定 5 页 × 20 部 = 100 部，第 6 页直接 404。
     * 用户滑到第 100 部时如果显示「已经到底了」，这条流就断了；所以第 5 页先装作
     * 还有下一页，第 6 页起改接同形态的分类流（官网分类页最多 100 页），
     * 前端按 id 去重后续排，视觉上就是一直往下有内容。
     */
    private static final int RANK_PAGES_FALLBACK = 5;
    private static final java.util.Map<String, Integer> rankPages = new java.util.concurrent.ConcurrentHashMap<>();

    private static boolean comicBoard(String id) {
        return "hot-comic-drama".equals(id) || "hot-ai-drama".equals(id);
    }

    JSONObject category(String id, int page) throws Exception {
        if (BOARDS.contains(id)) {
            int last = rankPages.getOrDefault(id, RANK_PAGES_FALLBACK);
            if (page <= last) {
                try {
                    CatalogPage ranked = upstream.ranking(id, page);
                    if (ranked.getRanking() != null && ranked.getRanking().getTotalPages() > 0)
                        rankPages.put(id, ranked.getRanking().getTotalPages());
                    JSONObject result = listing(ranked, page, id);
                    if (page >= rankPages.getOrDefault(id, last)) result.put("nextPage", page + 1);
                    return result;
                } catch (Exception error) {
                    /* 榜单实际页数比记录少：最后一页别再抛「加载失败」，直接接分类流 */
                    if (page < last) throw error;
                }
            }
            int feedPage = Math.max(1, page - last);
            if (feedPage > 100)
                return new JSONObject().put("items", new JSONArray()).put("nextPage", JSONObject.NULL);
            /* 漫剧的分类流和短剧不是一个接口：home(COMIC) 其实是漫剧榜（同样只有 5 页），
               所以这里按题材接（comic:xxx），一个题材翻完换下一个。 */
            if (comicBoard(id)) return comicFeedPage(feedPage, page);
            return listing(upstream.home(feedPage, ContentType.SHORT), page, id);
        }
        if (!"short".equals(id) && !"comic".equals(id)) throw new IllegalArgumentException("无效分类");
        return listing(upstream.home(page, "comic".equals(id) ? ContentType.COMIC : ContentType.SHORT), page, id);
    }

    /* 漫剧题材缓存：题材列表要抓两个分类页，翻页时不该每次都拉。 */
    private static volatile JSONArray comicSlugs;
    private static volatile long comicSlugsAt;

    private JSONObject comicFeedPage(int feedPage, int page) throws Exception {
        JSONArray slugs = comicSlugs;
        if (slugs == null || slugs.length() == 0 || System.currentTimeMillis() - comicSlugsAt > 10 * 60 * 1000L) {
            JSONArray all = genres.tags().getJSONArray("items");
            JSONArray picked = new JSONArray();
            for (int i = 0; i < all.length(); i++) {
                JSONObject tag = all.getJSONObject(i);
                if ("comic".equals(tag.optString("group"))) picked.put(tag.optString("slug"));
            }
            comicSlugs = picked;
            comicSlugsAt = System.currentTimeMillis();
            slugs = picked;
        }
        JSONArray items = new JSONArray();
        if (slugs.length() > 0) {
            /* 一个题材约 34 页；翻满就换下一个题材，避免同一批海报无限重复 */
            final int perTopic = 30;
            int topic = ((feedPage - 1) / perTopic) % slugs.length();
            int topicPage = (feedPage - 1) % perTopic + 1;
            items = genres.listing(slugs.getString(topic), topicPage).getJSONArray("items");
        }
        return new JSONObject().put("items", items)
                .put("nextPage", items.length() > 0 ? page + 1 : JSONObject.NULL);
    }
    JSONObject home() throws Exception {
        JSONObject shorts = category("short", 1), comics = category("comic", 1);
        JSONArray featured = boardFeatured(shorts.getJSONArray("items"));
        return new JSONObject().put("featured", featured).put("items", shorts.getJSONArray("items"))
                .put("recommend", shorts).put("newest", comics);
    }
    /**
     * 首页轮播：四个榜各取前 2 部。
     *
     * 以前只取短剧首页前 5，结果永远在放同一批真人剧，翻来覆去就是那几张海报。
     * 四个榜（热播 / 真人 / 漫剧 / AI）并行拉第一页，各挑 2 部，轮播才看得出类型差异。
     * 任意一个榜挂了就跳过，四个全挂再退回短剧前 5。
     */
    private JSONArray boardFeatured(JSONArray fallback) {
        final String[] boards = {"hot-drama", "hot-real-drama", "hot-comic-drama", "hot-ai-drama"};
        java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newFixedThreadPool(boards.length);
        java.util.List<java.util.concurrent.Future<JSONArray>> jobs = new java.util.ArrayList<>();
        for (final String board : boards) {
            jobs.add(pool.submit(() -> {
                JSONArray picked = new JSONArray();
                try {
                    CatalogPage page = upstream.ranking(board, 1);
                    for (int i = 0; i < Math.min(2, page.getItems().size()); i++)
                        picked.put(card(page.getItems().get(i), board));
                } catch (Exception ignore) { /* 单个榜失败不影响其余三个 */ }
                return picked;
            }));
        }
        JSONArray merged = new JSONArray();
        for (java.util.concurrent.Future<JSONArray> job : jobs) {
            try {
                JSONArray part = job.get(8, java.util.concurrent.TimeUnit.SECONDS);
                for (int i = 0; i < part.length(); i++) merged.put(part.get(i));
            } catch (Exception ignore) { job.cancel(true); }
        }
        pool.shutdownNow();
        if (merged.length() == 0) {
            for (int i = 0; i < Math.min(5, fallback.length()); i++)
                try { merged.put(fallback.get(i)); } catch (Exception ignore) { }
        }
        return merged;
    }
    JSONObject recommend(int page, boolean comics) throws Exception { return category(comics ? "comic" : "short", page); }
    /** 刷剧随机池：全库按题材随机取样，和首页榜单没有关系。 */
    JSONObject bingeRandom(int want) throws Exception { return randomFeed.sample(want); }
    JSONObject search(String keyword) throws Exception {
        return search.search(keyword);
    }
    JSONObject searchSequels(String keyword) throws Exception { return search.search(keyword, true); }
    JSONObject detail(String id) throws Exception {
        Detail detail = loadDetail(id);
        JSONObject result = card(detail.getSeries(), "");
        JSONArray episodes = new JSONArray();
        for (int i = 0; i < detail.getEpisodes().size(); i++)
            episodes.put(new JSONObject().put("number", i + 1).put("videoId", detail.getEpisodes().get(i)));
        result.put("episodes", episodes);
        if (episodes.length() == 0) {
            /* 一部剧一集都没有：站方还没上线（video_detail 回 episode_cnt=0），
               或者片源全下线。带上 unavailable，前端据此显示说明而不是空选集。 */
            String label = detail.getSeries().getBadge();
            result.put("episodeLabel", label == null || label.isEmpty() ? "暂无剧集" : label)
                    .put("unavailable", true);
        } else {
            result.put("episodeLabel", "共 " + episodes.length() + " 集");
        }
        return result;
    }

    /**
     * 网页详情拿不到时（HTTP 404）改用 App 详情接口凑一份。
     *
     * 2026-11 起站方网页版只收录了一部分片源：App 搜索能搜到、能播，但
     * https://hongguoduanju.com/detail?series_id=… 直接 404，表现就是「搜到点不进详情页」。
     * App 详情接口（video_detail）不走网页，返回同样的分集列表，用它兜底至少能进页面、能播。
     * 代价是封面/简介/相关推荐这些只有网页版才有的东西会缺，所以只作为兜底。
     */
    private Detail loadDetail(String id) throws Exception {
        Detail cached = details.get(id);
        if (cached != null) return cached;
        Detail detail;
        try {
            detail = upstream.detail(id);
        } catch (Exception error) {
            detail = detailFromApp(id);
            if (detail == null) {
                /* 两条路都不给分集：网页 404 + App 详情说「更新至 0 集」。
                   这种多半是「已备案、还没上线」的待播剧（video_detail 里
                   episode_cnt=0、show_player_entrance=false、allow_share=false），
                   换成谁、用哪套签名都取不到片源——官方 App 里点开也是 0 集。
                   以前这里直接把 404 抛给前端，整页变成「找不到这个剧集（…）：
                   内容请求失败（HTTP 404）」，用户根本分不清是剧没上线还是软件坏了。
                   现在返回一部空分集：详情页照常打开（标题/封面用列表卡片上的），
                   只在选集区显示一句「暂时没有可播放的剧集」。 */
                return pendingDetail(id);
            }
        }
        details.put(id, detail);
        return detail;
    }

    /** 一集都没有的占位详情；标题/封面留空，前端用点进来时那张卡片补。 */
    private static Detail pendingDetail(String id) {
        return new Detail(new Series(id, "", "", "", "", ""), new java.util.ArrayList<String>(0));
    }

    /** App 详情接口兜底；连元信息都拿不到返回 null，由调用方退回占位详情。 */
    private Detail detailFromApp(String id) {
        JSONObject app = appApi.fetch(id);
        if (app == null) return null;
        JSONArray vids = app.optJSONArray("vids");
        java.util.List<String> episodes = new java.util.ArrayList<>(vids == null ? 0 : vids.length());
        for (int i = 0; vids != null && i < vids.length(); i++) {
            String vid = vids.optString(i, "");
            if (vid.isEmpty()) return null;
            episodes.add(vid);
        }
        /* 分集为空但元信息在：这也是「还没上线」，照样返回一部空分集，
           让详情页有标题/封面可显示，比一屏「找不到这个剧集」有用。 */
        String title = app.optString("series_title", "");
        if (title.isEmpty() && episodes.isEmpty()) return null;
        if (title.isEmpty()) title = "剧集 " + id;
        String label = app.optString("episode_label", "");
        if (label.isEmpty()) label = episodes.isEmpty() ? "暂无剧集" : "共 " + episodes.size() + " 集";
        Series series = new Series(id, title, app.optString("series_cover", ""), app.optString("series_intro", ""), label, "");
        return new Detail(series, episodes);
    }
    /*
     * 播放地址缓存。
     *
     * 同一集反复点开（退出再进、切回上一集）不该每次都重新签名取流：
     * 一次 resolve 就是一次 device 参数拼装 + 签名 + 一次 HTTPS 往返，
     * 慢的时候一两秒。红果地址带时效，所以只留 8 分钟，过期就重新解析。
     */
    private static final long EPISODE_TTL_MS = 8 * 60 * 1000L;
    private static final LruCache<String, JSONObject> episodes = new LruCache<>(32);
    private static final java.util.Map<String, Long> episodeAt = new java.util.concurrent.ConcurrentHashMap<>();

    JSONObject episode(String id, int number) throws Exception {
        return episode(id, number, false);
    }

    /** @param background 详情页预热：取址失败不占冷却、不重试，少给上游添无效请求。 */
    JSONObject episode(String id, int number, boolean background) throws Exception {
        final String cacheKey = id + "#" + number;
        JSONObject cached = episodes.get(cacheKey);
        Long at = episodeAt.get(cacheKey);
        if (cached != null && at != null && System.currentTimeMillis() - at < EPISODE_TTL_MS) return cached;
        Detail detail = loadDetail(id);
        if (detail.getEpisodes().isEmpty()) throw new IllegalArgumentException("这部剧暂时没有可播放的剧集");
        if (number < 1 || number > detail.getEpisodes().size()) throw new IllegalArgumentException("无效集数");
        StreamInfo info = resolveStream(id, detail.getEpisodes().get(number - 1), background);
        HongguoPlayback.register(info);
        JSONObject result = new JSONObject().put("id", id).put("episode", number)
                .put("source", info.getUrl())
                .put("mimeType", "video/mp4").put("quality", info.getQuality())
                .put("title", detail.getSeries().getTitle()).put("cover", detail.getSeries().getCover());
        byte[] key = info.getKey();
        if (key != null && key.length == 16) {
            StringBuilder hex = new StringBuilder();
            for (byte b : key) hex.append(String.format("%02x", b));
            result.put("key", hex.toString());
        }
        episodes.put(cacheKey, result);
        episodeAt.put(cacheKey, System.currentTimeMillis());
        return result;
    }

    /*
     * 预热点播。
     *
     * 用户从「看到详情页」到「点播放」之间通常有好几秒，这段时间足够把播放地址解析好、
     * 把 RemoteVideo prepare 好、首 4MB 铺进内存。点下去时播放器 open() 直接命中，
     * 首帧只剩解码器启动的时间 —— guoapp「一点就播」就是这么来的。
     */
    private static final java.util.concurrent.ExecutorService PREWARM_POOL =
            java.util.concurrent.Executors.newFixedThreadPool(2, runnable -> {
                Thread thread = new Thread(runnable, "hongguo-prewarm");
                thread.setDaemon(true);
                return thread;
            });
    private static final java.util.Set<String> PREWARMING =
            java.util.Collections.newSetFromMap(new java.util.concurrent.ConcurrentHashMap<String, Boolean>());

    void prewarm(String id, int number) {
        if (id == null || id.isEmpty() || number < 1) return;
        final String key = id + "#" + number;
        if (!PREWARMING.add(key)) return;
        try {
            PREWARM_POOL.execute(() -> {
                try {
                    JSONObject data = episode(id, number, true);
                    HongguoPlayback.warm(data.optString("source"));
                } catch (Exception ignored) {
                    // 预热失败无所谓：真点播时还会走一次完整流程
                } finally {
                    PREWARMING.remove(key);
                }
            });
        } catch (Throwable error) {
            PREWARMING.remove(key);
        }
    }

    /*
     * 取流只走一条路：匿名注册 + Android v5 签名（HongguoDirect）。
     *
     * 2026-10-27 站方关掉了 551 Argus/Ladon（固定 HTTP 200 + 空正文），
     * 2026-11 又要求 v5 Medusa/Helios；中转后端是永久 HTTP 502。
     * 之前把三条串起来等，最坏要十几秒才报「没找到地址」，而且网页兜底只给
     * 前几集的 360p 试看片 —— 既慢又不对。现在单路 9 秒硬预算，失败立刻报原因。
     */
    private static final java.util.concurrent.ExecutorService RESOLVE_POOL =
            java.util.concurrent.Executors.newFixedThreadPool(3, runnable -> {
                Thread thread = new Thread(runnable, "hongguo-resolve");
                thread.setDaemon(true);
                return thread;
            });
    private static final long FRESH_TIMEOUT_MS = 9000L;

    private StreamInfo resolveStream(String id, String vid, boolean background) throws Exception {
        java.util.concurrent.Future<StreamInfo> task =
                RESOLVE_POOL.submit(() -> HongguoDirect.fetch(vid, background));
        StreamInfo info;
        try {
            info = task.get(FRESH_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS);
        } catch (java.util.concurrent.TimeoutException error) {
            task.cancel(true);
            throw new java.io.IOException("红果取址超时（"
                    + (FRESH_TIMEOUT_MS / 1000) + " 秒），可能是网络或风控");
        } catch (java.util.concurrent.ExecutionException error) {
            Throwable cause = error.getCause() == null ? error : error.getCause();
            android.util.Log.w("Veyra", "红果 v5 取址失败: " + cause);
            throw new java.io.IOException(shortMessage(cause));
        } catch (InterruptedException error) {
            task.cancel(true);
            Thread.currentThread().interrupt();
            throw new java.io.IOException("取址被取消");
        }
        if (info == null || info.getUrl() == null || !info.getUrl().startsWith("http")) {
            throw new java.io.IOException("红果没有返回可播放的地址");
        }
        return info;
    }

    private static String shortMessage(Throwable error) {
        String text = error.getMessage();
        if (text == null || text.isEmpty()) text = error.getClass().getSimpleName();
        return text.length() > 160 ? text.substring(0, 160) : text;
    }

    /*
     * 详情页的四块附加内容：相关作品（其他季）、制作方、分集评论、时间轴弹幕。
     * 全部只读，签名在 HongguoApi 里，失败由前端降级成「暂无」，不影响播放。
     */
    JSONObject related(String id, String title) throws Exception {
        return new JSONObject().put("id", id).put("items", HongguoApi.related(id, title));
    }

    JSONObject producer(String id) throws Exception {
        return HongguoApi.producer(id);
    }

    JSONObject producerWorks(String name, String mediaId, int page) throws Exception {
        return HongguoApi.producerWorks(name, mediaId, page);
    }

    JSONObject comments(String id, String episodeId, String cursor) throws Exception {
        return HongguoApi.comments(id, episodeId, cursor);
    }

    JSONObject danmaku(String id, String episodeId, long start, long duration) throws Exception {
        return HongguoApi.danmaku(id, episodeId, start, duration);
    }

    String coverData(String url) throws Exception {
        if (!url.startsWith("https://")) throw new IllegalArgumentException("无效封面地址");
        /* 红果图床（*.byteimg.com）对纯 UA 的裸请求偶尔回 403，带上站点 Referer 更稳；
           其它域名的图带 Referer 也不敏感。 */
        Request request = new Request.Builder().url(url)
                .header("User-Agent", "Mozilla/5.0")
                .header("Referer", "https://hongguoduanju.com/")
                .build();
        try (Response response = upstream.getHttp().newCall(request).execute()) {
            if (!response.isSuccessful() || response.body() == null) throw new IllegalStateException("封面加载失败");
            byte[] bytes = response.body().bytes();
            if (bytes.length > 5 * 1024 * 1024) throw new IllegalStateException("封面过大");
            String type = response.header("Content-Type", "");
            String mime = type.isEmpty() ? sniffImage(bytes) : type.split(";")[0];
            if (!mime.startsWith("image/")) throw new IllegalStateException("封面不是图片");
            return "data:" + mime + ";base64," + Base64.encodeToString(bytes, Base64.NO_WRAP);
        }
    }

    /** 有些图床把 Content-Type 写成 application/octet-stream，按文件头兜一层。 */
    private static String sniffImage(byte[] bytes) {
        if (bytes == null || bytes.length < 4) return "image/jpeg";
        if ((bytes[0] & 0xff) == 0xff) return "image/jpeg";
        if ((bytes[0] & 0xff) == 0x89 && bytes[1] == 'P') return "image/png";
        if (bytes[0] == 'G' && bytes[1] == 'I') return "image/gif";
        if (bytes[0] == 'R' && bytes[1] == 'I') return "image/webp";
        return "image/jpeg";
    }
}
