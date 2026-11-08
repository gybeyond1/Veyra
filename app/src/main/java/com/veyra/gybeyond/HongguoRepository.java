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
    private final LruCache<String, Detail> details = new LruCache<>(32);
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
    JSONObject episode(String id, int number) throws Exception {
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
        return result;
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
