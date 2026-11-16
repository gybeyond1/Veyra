package com.veyra.gybeyond;

import com.hongguotv.core.ContentRepository;
import com.hongguotv.core.Signer;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/** Public website search covers both supported content kinds in one request. */
final class HongguoSearch {
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
     * 搜索主路径：走 App 的 search/tab 接口，一次请求拿到全量结果（含第二三四季全集版）。
     *
     * 以前是「13 次联想 + 10 次第N季变体 + 每个结果补详情」，三轮串行等，慢在请求数上；
     * App 接口本身就把这些工作做完了。官网接口留作兜底，只在 App 接口空结果时发一次。
     */
    JSONObject search(String keyword, boolean sequelLookup) throws Exception {
        keyword = keyword.trim();
        if (keyword.isEmpty()) return new JSONObject().put("items", new JSONArray()).put("nextPage", JSONObject.NULL);
        if (keyword.length() > 80) throw new IllegalArgumentException("搜索词过长");
        try {
            JSONObject app = HongguoApi.search(keyword, 1);
            JSONArray items = app.optJSONArray("items");
            if (items != null && items.length() > 0) return app;
        } catch (Exception error) {
            android.util.Log.w("Veyra", "App 搜索失败，改用官网：" + error);
        }
        return apiSearch(keyword, sequelLookup);
    }

    /** 红果搜索 JSON API（hongguoduanju.com/api/search/result，网站搜索页实际接口，无签名要求）。 */
    private JSONObject apiSearch(String query, boolean sequelLookup) throws Exception {
        Request rq = new Request.Builder()
                .url("https://hongguoduanju.com/api/search/result?query=" + Signer.Companion.encode(query) + "&page=1&page_size=20")
                .header("User-Agent", "Mozilla/5.0")
                .header("Referer", "https://hongguoduanju.com/")
                .header("Accept", "application/json").build();
        try (Response resp = http.newCall(rq).execute()) {
            if (!resp.isSuccessful() || resp.body() == null) throw new IOException("搜索暂时无法连接，请重试");
            return parse(new JSONObject(resp.body().string()), query, sequelLookup);
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
                                        .put("cover", video == null ? "" : video.optString("series_cover"))
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
            items.put(new JSONObject().put("id", id).put("title", title).put("cover", video.optString("series_cover"))
                    .put("description", video.optString("series_intro")).put("episodeLabel", video.optString("episode_right_text"))
                    .put("category", type).put("score", "").put("tags", tags));
        }
        return new JSONObject().put("items", items).put("nextPage", JSONObject.NULL);
    }
}
