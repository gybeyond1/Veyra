package com.veyra.gybeyond;

import com.hongguotv.core.ContentRepository;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.util.HashSet;
import java.util.Set;

/** Website major categories only; the slug includes content type to keep equal names distinct. */
final class HongguoGenres {
    private final OkHttpClient http;
    HongguoGenres(OkHttpClient http) { this.http = http; }
    private static String route(String type) {
        return "comic".equals(type) ? "comic-drama" : "real-drama";
    }
    private JSONObject fetch(String path) throws Exception {
        Request request = new Request.Builder().url("https://hongguoduanju.com/category/" + path)
                .header("User-Agent", "Mozilla/5.0").header("Accept-Language", "zh-CN,zh;q=0.9").build();
        try (Response response = http.newCall(request).execute()) {
            if (!response.isSuccessful() || response.body() == null) throw new IOException("类型列表加载失败");
            JSONObject loader = ContentRepository.Companion.extractRouter(response.body().string()).getJSONObject("loaderData");
            for (java.util.Iterator<String> keys = loader.keys(); keys.hasNext();) {
                JSONObject section = loader.optJSONObject(keys.next());
                if (section != null && section.has("recommendList") && section.has("selectorList")) return section;
            }
            throw new IOException("类型页面数据结构已变化");
        }
    }
    static JSONArray parseTags(JSONObject section, String type) throws Exception {
        JSONArray result = new JSONArray(), rows = section.getJSONArray("selectorList");
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.getJSONObject(i);
            if (row.optInt("row_id") != 1) continue;
            JSONArray items = row.optJSONArray("items");
            if (items == null) continue;
            for (int j = 0; j < items.length(); j++) {
                JSONObject item = items.getJSONObject(j);
                String slug = item.optString("selector_item_id"), name = item.optString("show_name");
                JSONArray ids = item.optJSONArray("category_json_ids");
                if (!slug.matches("[a-z0-9-]{1,80}") || name.isEmpty() || ids == null || ids.length() == 0 || !seen.add(slug)) continue;
                result.put(new JSONObject().put("slug", type + ":" + slug).put("name", name).put("group", type));
            }
        }
        return result;
    }
    JSONObject tags() throws Exception {
        JSONArray items = new JSONArray();
        for (String type : new String[]{"short", "comic"}) {
            JSONArray group = parseTags(fetch(route(type)), type);
            if (group.length() == 0) throw new IOException("暂无可用大类");
            for (int i = 0; i < group.length(); i++) items.put(group.getJSONObject(i));
        }
        return new JSONObject().put("items", items);
    }
    JSONObject listing(String slug, int page) throws Exception {
        if (slug == null || !slug.matches("(?:short|comic):[a-z0-9-]{1,80}") || page < 1 || page > 100)
            throw new IllegalArgumentException("无效类型或页码");
        String[] parts = slug.split(":", 2);
        JSONObject section = fetch(route(parts[0]) + "/" + parts[1] + (page > 1 ? "?page=" + page : ""));
        return parseListing(section, parts[0], page);
    }
    static JSONObject parseListing(JSONObject section, String type, int page) throws Exception {
        JSONArray rows = section.getJSONArray("recommendList"), items = new JSONArray();
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.getJSONObject(i);
            String id = row.optString("series_id"), title = row.optString("series_name", row.optString("series_title"));
            if (!id.matches("[0-9]{1,30}") || title.isEmpty() || !seen.add(id)) continue;
            String cover = row.optString("series_cover");
            if (cover.startsWith("//")) cover = "https:" + cover;
            JSONObject info = row.optJSONObject("series_episode_info");
            int count = row.optInt("episode_cnt", info == null ? 0 : info.optInt("episode_cnt"));
            String badge = row.optString("episode_right_text");
            if (badge.isEmpty() && count > 0) badge = "全 " + count + " 集";
            items.put(new JSONObject().put("id", id).put("title", title).put("cover", cover)
                    .put("description", row.optString("series_intro")).put("score", "")
                    .put("episodeLabel", badge).put("category", type).put("tags", row.optJSONArray("tags") == null ? new JSONArray() : row.getJSONArray("tags")));
        }
        JSONObject pagination = section.getJSONObject("pagination");
        if (pagination.optInt("pageNum", page) != page) throw new IOException("类型分页未正确返回");
        int last = Math.min(100, pagination.optInt("totalPages", page));
        /* totalPages 一起带出去：刷剧随机池要随机跳页，光有 nextPage 只能一页页往下走，
           跳到不存在的页会直接抛「分页未正确返回」。 */
        return new JSONObject().put("items", items).put("contentType", type).put("totalPages", last)
                .put("nextPage", items.length() > 0 && page < last ? page + 1 : JSONObject.NULL);
    }
}
