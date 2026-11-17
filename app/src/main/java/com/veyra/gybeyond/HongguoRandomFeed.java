package com.veyra.gybeyond;

import okhttp3.OkHttpClient;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/**
 * 刷剧随机池。
 *
 * 以前的剧单只从首页拿：推荐位一栏 + 最新一栏，加起来几十部，洗牌只是换顺序，
 * 刷两天全是熟脸 —— 那两栏本来就是榜单排序的结果。红果全库有上万部，
 * 但榜单只暴露最热的几百部，所以「随机」不可能在榜单里做出来。
 *
 * 这里改成从官网分类页取样：题材几十个，每个题材能翻到第 100 页，一页 20 部。
 * 随机挑题材、随机挑页，每次进刷剧都是一批完全不同的剧，跟榜单无关。
 *
 * 成本：6 个题材 × 3 页 = 18 次页面请求，并发 6 跑两轮，约 1~2 秒；
 * 题材列表缓存 10 分钟，总页数缓存更久，所以只有冷启动那一次慢。
 */
final class HongguoRandomFeed {
    private static final ExecutorService POOL = Executors.newFixedThreadPool(6);
    private static final long TAGS_TTL = 10 * 60_000L;
    /** 每个题材取几页。1 页 20 部，6 个题材 × 3 页约 360 部，去重后 300 上下。 */
    private static final int PAGES_PER_TAG = 3;
    /** 短剧、漫剧各挑几个题材，别让人一路刷下去全是同一类。 */
    private static final int TAGS_PER_KIND = 3;

    private static JSONArray tagCache;
    private static long tagAt;
    /** 题材 → 总页数。跳页前必须知道边界，否则会请求到不存在的页。 */
    private static final Map<String, Integer> PAGE_COUNT = new ConcurrentHashMap<>();

    private final HongguoGenres genres;
    private final Random random = new Random();

    HongguoRandomFeed(OkHttpClient http) { this.genres = new HongguoGenres(http); }

    /**
     * 抽一批随机剧。
     *
     * @param want 最多返回多少部；实际数量取决于各题材当页有多少条
     */
    JSONObject sample(int want) throws Exception {
        List<String> shorts = new ArrayList<>(), comics = new ArrayList<>(), picked = new ArrayList<>();
        JSONArray tags = tags();
        for (int i = 0; i < tags.length(); i++) {
            JSONObject tag = tags.optJSONObject(i);
            String slug = tag == null ? "" : tag.optString("slug", "");
            if (slug.startsWith("short:")) shorts.add(slug);
            else if (slug.startsWith("comic:")) comics.add(slug);
        }
        picked.addAll(pick(shorts, TAGS_PER_KIND));
        picked.addAll(pick(comics, TAGS_PER_KIND));
        if (picked.isEmpty()) throw new IOException("暂无可用的分类");

        Map<String, JSONObject> pages = new LinkedHashMap<>();
        /* 第一轮：每个题材先读第 1 页。它同时用于「学总页数」和「凑内容」，
           没这一轮就没法安全地随机跳页。 */
        List<Future<JSONObject>> firsts = new ArrayList<>();
        for (String slug : picked) firsts.add(POOL.submit(fetch(slug, 1)));
        for (int i = 0; i < firsts.size(); i++) {
            JSONObject page = await(firsts.get(i));
            if (page == null) continue;
            PAGE_COUNT.put(picked.get(i), Math.max(1, page.optInt("totalPages", 1)));
            pages.put(picked.get(i) + "#1", page);
        }

        /* 第二轮：每个题材再随机跳 PAGES_PER_TAG-1 页。只有 1 页的题材跳过，
           硬跳就是白白等一次失败。 */
        List<Future<JSONObject>> rest = new ArrayList<>();
        List<String> keys = new ArrayList<>();
        for (String slug : picked) {
            int total = PAGE_COUNT.getOrDefault(slug, 1);
            for (int k = 1; k < PAGES_PER_TAG && total > 1; k++) {
                int page = 2 + random.nextInt(total - 1);
                keys.add(slug + "#" + page);
                rest.add(POOL.submit(fetch(slug, page)));
            }
        }
        for (int i = 0; i < rest.size(); i++) {
            JSONObject page = await(rest.get(i));
            if (page != null) pages.put(keys.get(i), page);
        }

        Map<String, JSONObject> merged = new LinkedHashMap<>();
        for (JSONObject page : pages.values()) {
            JSONArray items = page.optJSONArray("items");
            for (int i = 0; items != null && i < items.length(); i++) {
                JSONObject item = items.optJSONObject(i);
                String id = item == null ? "" : item.optString("id", "");
                if (id.isEmpty() || merged.containsKey(id)) continue;
                merged.put(id, item);
            }
        }
        List<JSONObject> list = new ArrayList<>(merged.values());
        Collections.shuffle(list, random);
        JSONArray out = new JSONArray();
        for (int i = 0; i < list.size() && i < want; i++) out.put(list.get(i));
        return new JSONObject().put("items", out).put("tags", picked);
    }

    /** 随机取 n 个（不足就全给）。 */
    private List<String> pick(List<String> source, int n) {
        List<String> copy = new ArrayList<>(source);
        Collections.shuffle(copy, random);
        return copy.subList(0, Math.min(n, copy.size()));
    }

    private Callable<JSONObject> fetch(final String slug, final int page) {
        return new Callable<JSONObject>() {
            @Override public JSONObject call() {
                try {
                    return genres.listing(slug, page);
                } catch (Exception error) {
                    return null;
                }
            }
        };
    }

    private JSONObject await(Future<JSONObject> future) {
        try {
            return future.get(8, TimeUnit.SECONDS);
        } catch (Exception error) {
            return null;
        }
    }

    private JSONArray tags() throws Exception {
        synchronized (HongguoRandomFeed.class) {
            long now = System.currentTimeMillis();
            if (tagCache != null && now - tagAt < TAGS_TTL) return tagCache;
            JSONArray items = genres.tags().optJSONArray("items");
            tagCache = items == null ? new JSONArray() : items;
            tagAt = now;
            return tagCache;
        }
    }
}
