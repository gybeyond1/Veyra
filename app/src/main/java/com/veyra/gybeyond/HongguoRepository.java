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
    JSONObject category(String id, int page) throws Exception {
        if (BOARDS.contains(id)) return listing(upstream.ranking(id, page), page, id);
        if (!"short".equals(id) && !"comic".equals(id)) throw new IllegalArgumentException("无效分类");
        return listing(upstream.home(page, "comic".equals(id) ? ContentType.COMIC : ContentType.SHORT), page, id);
    }
    JSONObject home() throws Exception {
        JSONObject shorts = category("short", 1), comics = category("comic", 1);
        JSONArray featured = new JSONArray(), items = shorts.getJSONArray("items");
        for (int i = 0; i < Math.min(5, items.length()); i++) featured.put(items.getJSONObject(i));
        return new JSONObject().put("featured", featured).put("items", items)
                .put("recommend", shorts).put("newest", comics);
    }
    JSONObject recommend(int page, boolean comics) throws Exception { return category(comics ? "comic" : "short", page); }
    JSONObject search(String keyword) throws Exception {
        return search.search(keyword);
    }
    JSONObject searchSequels(String keyword) throws Exception { return search.search(keyword, true); }
    JSONObject detail(String id) throws Exception {
        Detail detail = upstream.detail(id);
        details.put(id, detail);
        JSONObject result = card(detail.getSeries(), "");
        JSONArray episodes = new JSONArray();
        for (int i = 0; i < detail.getEpisodes().size(); i++)
            episodes.put(new JSONObject().put("number", i + 1).put("videoId", detail.getEpisodes().get(i)));
        return result.put("episodes", episodes).put("episodeLabel", "共 " + episodes.length() + " 集");
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
        final String cacheKey = id + "#" + number;
        JSONObject cached = episodes.get(cacheKey);
        Long at = episodeAt.get(cacheKey);
        if (cached != null && at != null && System.currentTimeMillis() - at < EPISODE_TTL_MS) return cached;
        Detail detail = details.get(id);
        if (detail == null) { detail = upstream.detail(id); details.put(id, detail); }
        if (number < 1 || number > detail.getEpisodes().size()) throw new IllegalArgumentException("无效集数");
        StreamInfo info = resolveStream(id, detail.getEpisodes().get(number - 1));
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
                    JSONObject data = episode(id, number);
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
     * 取流顺序：本机签名直连优先。
     *
     * 直连（HongguoSigner）拿到的是 CENC 加密的原始 mp4，播放器边读边解密，Range 流式，
     * 地址到手就能出画 —— guoapp 就是这一条路，点开即播。
     * 后端 /api/web/hongguo/stream 走的是「ffmpeg 把整集转封装成明文 mp4 再 sendFile」，
     * 第一遍必须等整集下完转完才给响应，一集几十秒；同名文件存在时才快。
     * 之前把后端排在前面，等于每次新集都先等转封装，这才是「点开要等」的主因。
     *
     * 直连连续失败（红果空响应风控）就冷却 5 分钟，期间直接走后端，避免每次白等 8 秒。
     */
    private static final java.util.concurrent.ExecutorService RESOLVE_POOL =
            java.util.concurrent.Executors.newFixedThreadPool(3, runnable -> {
                Thread thread = new Thread(runnable, "hongguo-resolve");
                thread.setDaemon(true);
                return thread;
            });
    private static final java.util.concurrent.atomic.AtomicInteger DIRECT_MISSES =
            new java.util.concurrent.atomic.AtomicInteger();
    private static volatile long directHoldUntil = 0L;
    private static final long DIRECT_COOLDOWN_MS = 5 * 60 * 1000L;
    private static final long DIRECT_TIMEOUT_MS = 6000L;

    private StreamInfo resolveStream(String id, String vid) throws Exception {
        if (System.currentTimeMillis() >= directHoldUntil) {
            java.util.concurrent.Callable<StreamInfo> call =
                    () -> com.hongguotv.core.HongguoSigner.INSTANCE.resolve(vid);
            java.util.concurrent.Future<StreamInfo> task = RESOLVE_POOL.submit(call);
            try {
                StreamInfo direct = task.get(DIRECT_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS);
                if (direct != null && direct.getUrl() != null && direct.getUrl().startsWith("http")) {
                    DIRECT_MISSES.set(0);
                    return direct;
                }
            } catch (Exception error) {
                task.cancel(true);
                // 第一次失败不立刻判死：偶发空响应重试一次还是很快的
                if (DIRECT_MISSES.incrementAndGet() >= 2) {
                    directHoldUntil = System.currentTimeMillis() + DIRECT_COOLDOWN_MS;
                    DIRECT_MISSES.set(0);
                }
            }
        }
        return upstream.stream(id, vid, 1080);
    }
    String coverData(String url) throws Exception {
        if (!url.startsWith("https://")) throw new IllegalArgumentException("无效封面地址");
        Request request = new Request.Builder().url(url).header("User-Agent", "Mozilla/5.0").build();
        try (Response response = upstream.getHttp().newCall(request).execute()) {
            if (!response.isSuccessful() || response.body() == null) throw new IllegalStateException("封面加载失败");
            byte[] bytes = response.body().bytes();
            if (bytes.length > 5 * 1024 * 1024) throw new IllegalStateException("封面过大");
            String mime = response.header("Content-Type", "image/jpeg").split(";")[0];
            return "data:" + mime + ";base64," + Base64.encodeToString(bytes, Base64.NO_WRAP);
        }
    }
}
