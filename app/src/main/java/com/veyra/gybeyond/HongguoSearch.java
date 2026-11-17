package com.veyra.gybeyond;

import com.hongguotv.core.ContentRepository;
import com.hongguotv.core.Signer;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Future;

/** Public website search covers both supported content kinds in one request. */
final class HongguoSearch {
    private static final int SITE_MAX_PAGES = 10;
    private static final int APP_MAX_PAGES = 4;
    private static final java.util.concurrent.ExecutorService POOL = java.util.concurrent.Executors.newFixedThreadPool(6);
    private final OkHttpClient http;
    private final HongguoAppApi appApi;
    HongguoSearch(OkHttpClient http) { this.http = http; this.appApi = new HongguoAppApi(http); }
    private static final java.util.regex.Pattern SEASON_SUFFIX = java.util.regex.Pattern
            .compile("第\\s*([0-9零〇一二两兩三四五六七八九十百]+)\\s*([季部])[\\p{P}\\s]*$");

    /** 剥离"第N季/部"后缀得到剧名主体："持械入宋第二季"→"持械入宋"。无后缀原样返回。 */
    private static String seasonBase(String query) {
        java.util.regex.Matcher match = SEASON_SUFFIX.matcher(query);
        if (!match.find()) return query;
        String base = query.substring(0, match.start()).trim();
        while (!base.isEmpty()) {
            char c = base.charAt(base.length() - 1);
            if (!Character.isWhitespace(c) && Character.getType(c) != Character.START_PUNCTUATION
                    && Character.getType(c) != Character.END_PUNCTUATION
                    && Character.getType(c) != Character.OTHER_PUNCTUATION
                    && Character.getType(c) != Character.CONNECTOR_PUNCTUATION) break;
            base = base.substring(0, base.length() - 1).trim();
        }
        return base.isEmpty() ? query : base;
    }

    JSONObject search(String keyword) throws Exception { return search(keyword, false); }

    /**
     * 搜索主路径：站点接口翻页 + App 接口补充，合并去重。
     *
     * 只用 App 接口（tab_type=11 短剧）搜「聚宝仙盆」只有 5 部：那一格只放短剧，
     * 而同名的漫剧（genre 205）全在别的 tab 里，界面上一部都看不到。
     * 站点接口一次给短剧和漫剧，还有 totalPages 可以老实翻页，所以以它为主。
     */
    JSONObject search(String keyword, boolean sequelLookup) throws Exception {
        keyword = keyword.trim();
        if (keyword.isEmpty()) return new JSONObject().put("items", new JSONArray()).put("nextPage", JSONObject.NULL);
        if (keyword.length() > 80) throw new IllegalArgumentException("搜索词过长");
        JSONArray merged = new JSONArray();
        Set<String> seen = new HashSet<>();
        Exception failure = null;
        /* 站点接口按页给 10 条、有 totalPages，而且短剧（203）和漫剧（205）在同一个结果里；
           App 接口只吃 tab_type=11 的短剧 tab，搜「聚宝仙盆」只回 5 部就是这么来的。
           两个都跑，站点为主、App 补充，按 series_id 去重。 */
        try {
            collectSite(keyword, merged, seen);
        } catch (Exception error) {
            failure = error;
            android.util.Log.w("Veyra", "站点搜索失败：" + error);
        }
        try {
            collectApp(keyword, merged, seen);
        } catch (Exception error) {
            if (failure == null) failure = error;
            android.util.Log.w("Veyra", "App 搜索失败：" + error);
        }
        if (merged.length() == 0 && failure != null) throw failure;
        attachCredits(merged);
        expandByProducer(merged);
        return new JSONObject().put("items", merged).put("nextPage", JSONObject.NULL);
    }

    /**
     * 用制作方把系列补全。
     *
     * 站内搜索只按标题匹配，「聚宝仙盆仙界篇」这种只剩第六、八、九、十季的情况很常见
     * —— 缺的那几季标题里没写编号，或者压根没被索引，搜索就是命不中。制作方是署名，
     * 拿到 media_id 就能把同一个人名下的作品拉回来，再挑「和已有系列同名」的补进去。
     *
     * 只补已有系列的缺季，不引入新族：一个制作方名下往往还有一堆无关的剧，
     * 全塞进搜索结果就成噪音了。所以只对「已命中 ≥2 部」的系列动手，最多 3 个制作方、
     * 每家一页，失败就算了，不影响已经取到的结果。
     */
    private void expandByProducer(JSONArray items) {
        if (items.length() == 0) return;
        Map<String, Integer> baseCount = new java.util.LinkedHashMap<>();
        Map<String, JSONObject> repByProducer = new java.util.LinkedHashMap<>();
        Map<String, Integer> weight = new java.util.LinkedHashMap<>();
        Set<String> known = new HashSet<>();
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            if (item == null) continue;
            known.add(item.optString("id"));
            String base = normalize(seasonBase(item.optString("title")));
            if (!base.isEmpty()) baseCount.merge(base, 1, Integer::sum);
            String media = item.optString("mediaId", "");
            String author = item.optString("author", "");
            if (media.isEmpty() || author.isEmpty()) continue;
            repByProducer.putIfAbsent(media, item);
            weight.merge(media, 1, Integer::sum);
        }
        Set<String> allowed = new HashSet<>();
        for (Map.Entry<String, Integer> entry : baseCount.entrySet()) {
            if (entry.getValue() >= 2) allowed.add(entry.getKey());
        }
        if (allowed.isEmpty() || repByProducer.isEmpty()) return;
        List<String> picked = new ArrayList<>(repByProducer.keySet());
        picked.sort((a, b) -> Integer.compare(weight.getOrDefault(b, 0), weight.getOrDefault(a, 0)));
        if (picked.size() > 3) picked = picked.subList(0, 3);

        List<Future<JSONObject>> futures = new ArrayList<>();
        for (String media : picked) {
            final String name = repByProducer.get(media).optString("author", "");
            futures.add(POOL.submit(new java.util.concurrent.Callable<JSONObject>() {
                @Override public JSONObject call() throws Exception { return HongguoApi.producerWorks(name, media, 1); }
            }));
        }
        for (int i = 0; i < futures.size(); i++) {
            JSONObject page;
            /* 制作方那条路现在一次覆盖 3 个站点页（署名命中稀疏，1 页常常只有个位数），
               超时跟着放宽；补不齐也没关系，已经搜到的照常返回。 */
            try { page = futures.get(i).get(7, java.util.concurrent.TimeUnit.SECONDS); }
            catch (Exception ignored) { continue; }
            if (page == null) continue;
            JSONObject sample = repByProducer.get(picked.get(i));
            JSONArray rows = page.optJSONArray("items");
            for (int j = 0; rows != null && j < rows.length(); j++) {
                JSONObject row = rows.optJSONObject(j);
                String id = row == null ? "" : row.optString("id");
                if (id.isEmpty() || !id.matches("[0-9]{1,30}") || !known.add(id)) continue;
                String title = row.optString("title", "");
                if (title.isEmpty()) continue;
                if (!allowed.contains(normalize(seasonBase(title)))) continue;
                try {
                    items.put(new JSONObject()
                            .put("id", id)
                            .put("title", title)
                            .put("cover", row.optString("cover", ""))
                            .put("description", "")
                            .put("episodeLabel", row.optString("episodeLabel", ""))
                            .put("category", sample == null ? "" : sample.optString("category", ""))
                            .put("mediaId", picked.get(i))
                            .put("author", sample == null ? "" : sample.optString("author", ""))
                            .put("tags", new JSONArray()));
                } catch (Exception ignored) { }
            }
        }
    }

    /**
     * 给结果补上制作方（author / media_id）。
     *
     * 光靠标题没法判断两条结果是不是同一部剧：搜「聚宝仙盆」时「聚宝仙盆」是真人短剧
     * （genre 203）、「聚宝仙盆之杂灵根才是真BOSS」是漫剧（205），名字是包含关系，
     * 实际是两部作品 —— 按标题前缀合并就会把真人剧塞进漫剧系列里当第 1 季。
     * 制作方是署名，同一系列必然同一个 media_id，拿它当「能不能合并」的许可条件才靠谱。
     *
     * 详情接口一次吃 20 个 book_id，35 条结果两批并行就够；失败只是少了这个字段，
     * 前端会退回按标题判断，不影响搜索本身。
     */
    private void attachCredits(JSONArray items) {
        List<String> ids = new ArrayList<>();
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            String id = item == null ? "" : item.optString("id");
            if (id.matches("[0-9]{1,30}")) ids.add(id);
        }
        if (ids.isEmpty()) return;
        List<Future<Map<String, JSONObject>>> futures = new ArrayList<>();
        for (int from = 0; from < ids.size(); from += 20) {
            final List<String> batch = new ArrayList<>(ids.subList(from, Math.min(ids.size(), from + 20)));
            futures.add(POOL.submit(new java.util.concurrent.Callable<Map<String, JSONObject>>() {
                @Override public Map<String, JSONObject> call() throws Exception { return HongguoApi.credits(batch); }
            }));
        }
        Map<String, JSONObject> credits = new java.util.LinkedHashMap<>();
        for (Future<Map<String, JSONObject>> future : futures) {
            try { credits.putAll(future.get(3, java.util.concurrent.TimeUnit.SECONDS)); }
            catch (Exception ignored) { }
        }
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            JSONObject credit = item == null ? null : credits.get(item.optString("id"));
            if (credit == null) continue;
            String media = credit.optString("mediaId", "");
            String author = credit.optString("name", "").trim();
            try {
                if (media.matches("[1-9][0-9]{0,29}")) item.put("mediaId", media);
                if (!author.isEmpty()) item.put("author", author);
            } catch (Exception ignored) { }
        }
    }

    /** 站点搜索一页；totalPages / hasMore 都在响应里，可以老实翻页。 */
    private JSONObject sitePage(String query, int page) throws Exception {
        Request request = new Request.Builder()
                .url("https://hongguoduanju.com/api/search/result?query=" + Signer.Companion.encode(query)
                        + "&page=" + page + "&page_size=20")
                .header("User-Agent", "Mozilla/5.0")
                .header("Referer", "https://hongguoduanju.com/")
                .header("Accept", "application/json").build();
        try (Response response = http.newCall(request).execute()) {
            if (!response.isSuccessful() || response.body() == null) throw new IOException("搜索暂时无法连接，请重试");
            return new JSONObject(response.body().string());
        }
    }

    /**
     * 站点搜索：先拿第 1 页读出 totalPages，再把剩下几页并行拉回来。
     * 结果是模糊匹配（搜「聚宝仙盆」会掺进「持械入宋」这类），
     * 所以页数上限按「够把标题匹配的都翻出来」定，不追到第 21 页。
     */
    private void collectSite(String query, JSONArray out, Set<String> seen) throws Exception {
        JSONObject first = sitePage(query, 1);
        int pages = Math.min(Math.max(1, first.optInt("totalPages", 1)), SITE_MAX_PAGES);
        List<JSONObject> responses = new ArrayList<>();
        responses.add(first);
        if (pages > 1) {
            List<Future<JSONObject>> futures = new ArrayList<>();
            for (int page = 2; page <= pages; page++) {
                final int target = page;
                futures.add(POOL.submit(new java.util.concurrent.Callable<JSONObject>() {
                    @Override public JSONObject call() throws Exception { return sitePage(query, target); }
                }));
            }
            for (Future<JSONObject> future : futures) {
                try { responses.add(future.get()); } catch (Exception ignored) { }
            }
        }
        for (JSONObject response : responses) {
            try { merge(parse(response, query, false), out, seen); } catch (Exception ignored) { }
        }
    }

    /** App 接口：只吃短剧 tab，页数少，纯补充站点漏掉的条目。 */
    private void collectApp(String keyword, JSONArray out, Set<String> seen) throws Exception {
        for (int page = 1; page <= APP_MAX_PAGES; page++) {
            JSONObject one = HongguoApi.search(keyword, page);
            JSONArray rows = one.optJSONArray("items");
            int added = 0;
            for (int i = 0; rows != null && i < rows.length(); i++) {
                JSONObject item = rows.optJSONObject(i);
                String id = item == null ? "" : item.optString("id");
                if (id.isEmpty() || !seen.add(id)) continue;
                out.put(item);
                added++;
            }
            /* 接口忽略 offset 时会反复回同一批，added == 0 兜住，不会空转。 */
            if (one.optInt("rawCount", 0) <= 0 || added == 0) break;
        }
    }

    private static void merge(JSONObject page, JSONArray out, Set<String> seen) {
        JSONArray items = page.optJSONArray("items");
        for (int i = 0; items != null && i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            String id = item == null ? "" : item.optString("id");
            if (!id.isEmpty() && seen.add(id)) out.put(item);
        }
    }

    private static final String[] CN_NUM = { "一", "二", "三", "四", "五", "六", "七", "八", "九", "十" };

    /** 联想接口查询集：宽词 + 主体第 + 主体季 + 各"第N季" + 冒号"：第N季"（N=1..10）。
     *  实测单次返回不稳定、部分查询偶发 500，且"持械入宋第三季"只回 100 集版、341 集版需
     *  "持械入宋：第三季"带冒号变体才返回——穷举组合三轮实测全量覆盖（15 部，含 341 第三季）。 */
    private static java.util.LinkedHashSet<String> suggestionQueries(String base) {
        java.util.LinkedHashSet<String> queries = new java.util.LinkedHashSet<>();
        queries.add(base);
        if (base.length() <= 8) {
            queries.add(base + "第");
            queries.add(base + "季");
        }
        for (String n : CN_NUM) {
            if (base.length() + n.length() + 3 <= 12) {
                queries.add(base + "第" + n + "季");
                queries.add(base + "：" + n + "季");
            }
        }
        return queries;
    }

    /** 红果联想接口（hongguoduanju.com/api/search/suggestion，搜索框实时联想实际接口）：
     *  按 suggestionQueries 穷举并行合并，suggestionList 过滤短剧名类型。
     *  覆盖搜索接口漏掉的全集版（341 集版第三季、100 集版第二季）。 */
    private JSONArray suggestionItems(String base) throws Exception {
        java.util.LinkedHashSet<String> queries = suggestionQueries(base);
        final java.util.LinkedHashMap<String, JSONObject> seen = new java.util.LinkedHashMap<>();
        java.util.List<java.util.concurrent.Future<?>> futures = new java.util.ArrayList<>();
        for (final String q : queries) {
            futures.add(POOL.submit(new Runnable() {
                @Override public void run() {
                    Request request = new Request.Builder()
                            .url("https://hongguoduanju.com/api/search/suggestion?query="
                                    + Signer.Companion.encode(q) + "&count=50")
                            .header("User-Agent", "Mozilla/5.0")
                            .header("Referer", "https://hongguoduanju.com/")
                            .header("Accept", "application/json").build();
                    try (Response response = http.newCall(request).execute()) {
                        if (!response.isSuccessful() || response.body() == null) return;
                        JSONObject json = new JSONObject(response.body().string());
                        JSONArray list = json.optJSONArray("suggestionList");
                        synchronized (seen) {
                            for (int i = 0; list != null && i < list.length(); i++) {
                                JSONObject record = list.optJSONObject(i);
                                if (record == null || !"short_play_name".equals(record.optString("word_type"))) continue;
                                JSONObject video = record.optJSONObject("video_data");
                                String id = video == null ? "" : video.optString("series_id");
                                if (id.isEmpty() || !id.matches("[0-9]{1,30}")) continue;
                                String title = record.optString("name");
                                if (title.isEmpty() && video != null) title = video.optString("series_title");
                                JSONArray tags = new JSONArray();
                                if (video != null) {
                                    JSONArray cats = video.optJSONArray("category_list");
                                    for (int j = 0; cats != null && j < cats.length() && tags.length() < 5; j++) {
                                        String n = cats.optJSONObject(j).optString("name");
                                        if (!n.isEmpty()) tags.put(n);
                                    }
                                }
                                seen.putIfAbsent(id, new JSONObject().put("id", id).put("title", title)
                                        .put("cover", HongguoApi.coverOf(video))
                                        .put("description", video == null ? "" : video.optString("series_intro"))
                                        .put("episodeLabel", video == null ? "" : video.optString("episode_right_text"))
                                        .put("category", "").put("score", "").put("tags", tags));
                            }
                        }
                    } catch (Exception ignored) { }
                }
            }));
        }
        for (java.util.concurrent.Future<?> f : futures) { try { f.get(); } catch (Exception ignored) { } }
        JSONArray items = new JSONArray();
        for (JSONObject it : seen.values()) items.put(it);
        return items;
    }
    private static String normalize(String text) { return text.replaceAll("\\s+", "").toLowerCase(Locale.ROOT); }

    /** 并行补齐红果官方系列键（albumId/seasonIndex）：同一 related_album_id 即官方同系列，
     *  season_index 为官方季序号。App 接口失败时该项不带字段，前端按 albumId 存在才分组。 */
    private JSONObject decorate(JSONObject result) {
        JSONArray items = result.optJSONArray("items");
        if (items == null || items.length() == 0) return result;
        java.util.List<java.util.concurrent.Future<?>> futures = new java.util.ArrayList<>();
        for (int i = 0; i < items.length(); i++) {
            final int index = i;
            futures.add(POOL.submit(new Runnable() {
                @Override public void run() {
                    try {
                        JSONObject it = items.optJSONObject(index);
                        if (it == null) return;
                        JSONObject info = appApi.fetch(it.optString("id"));
                        if (info == null) return;
                        it.put("albumId", info.optString("album_id"));
                        it.put("seasonIndex", info.optInt("season_index", 0));
                    } catch (Exception ignored) { }
                }
            }));
        }
        for (java.util.concurrent.Future<?> f : futures) { try { f.get(); } catch (Exception ignored) { } }
        return result;
    }
    static JSONObject parse(JSONObject section, String keyword) throws Exception { return parse(section, keyword, false); }
    private static String normalized(String value, boolean sequelLookup) {
        return sequelLookup ? normalize(value).replaceAll("[\\p{P}\\p{Z}]", "") : normalize(value);
    }
    private static JSONObject parse(JSONObject section, String keyword, boolean sequelLookup) throws Exception {
        if (!section.optBoolean("isSuccess", true)) throw new IOException("搜索服务暂不可用，请重试");
        JSONArray rows = section.getJSONArray("searchList"), items = new JSONArray();
        Set<String> ids = new HashSet<>();
        String query = normalized(keyword, sequelLookup);
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i), video = row == null ? null : row.optJSONObject("video_data");
            if (video == null) continue;
            String id = video.optString("series_id"), title = video.optString("series_title", row.optString("name"));
            String genre = video.optString("genre");
            String type = "203".equals(genre) ? "short" : "205".equals(genre) ? "comic" : "";
            // The website may append unrelated recommendations; never present them as matches.
            if (type.isEmpty() || !id.matches("[0-9]{1,30}") || !normalized(title, sequelLookup).contains(query) || !ids.add(id)) continue;
            JSONArray tags = new JSONArray(), categories = video.optJSONArray("category_list");
            if (categories != null) for (int j = 0; j < categories.length(); j++) {
                JSONObject category = categories.optJSONObject(j);
                if (category != null && !category.optString("name").isEmpty()) tags.put(category.optString("name"));
            }
            items.put(new JSONObject().put("id", id).put("title", title).put("cover", HongguoApi.coverOf(video))
                    .put("description", video.optString("series_intro")).put("episodeLabel", video.optString("episode_right_text"))
                    .put("category", type).put("score", "").put("tags", tags));
        }
        return new JSONObject().put("items", items).put("nextPage", JSONObject.NULL);
    }
}
