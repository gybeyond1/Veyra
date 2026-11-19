package com.veyra.gybeyond;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/**
 * 红果 App 侧的四个内容接口：搜索、相关作品、制作方、评论/弹幕。
 *
 * 和播放链路一样，这些接口都要 v5 签名；区别是它们用的是「全套头」（argus / ladon /
 * gorgon / medusa / helios），而播放只要 medusa 三个头。
 *
 * 一个关键约束：**身份必须现注册**。用固定的 device_id 调搜索，服务端一律回
 * HTTP 200 + 空正文（看起来像超时，其实是身份被拒）。所以这里缓存 10 分钟内的
 * 匿名身份，过期重新注册。
 */
final class HongguoApi {
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");

    private static final OkHttpClient HTTP = new OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(12, TimeUnit.SECONDS)
            .callTimeout(16, TimeUnit.SECONDS)
            .build();

    private static final String SEARCH =
            "https://api5-normal-sinfonlinea.fqnovel.com/reading/bookapi/search/tab/v";
    private static final String DETAIL =
            "https://api5-normal-sinfonlinec.fqnovel.com/reading/bookapi/multi-detail/v1/";
    private static final String[] RELATED_HOSTS = {
            "https://api5-normal-sinfonlinec.fqnovel.com/reading/bookapi/plan/v:version/",
            "https://api5-normal-hl.fqnovel.com/reading/bookapi/plan/v:version/",
            "https://api5-normal-lf.fqnovel.com/reading/bookapi/plan/v:version/",
    };
    private static final String COMMENT =
            "https://api5-normal-sinfonlineb.fqnovel.com/novel/commentapi/comment/list/";
    private static final String SITE = "https://hongguoduanju.com";

    private static final String[] VERSION_KEYS = {
            "version_code", "manifest_version_code", "update_version_code", "pv_player"};

    private static String deviceId = "";
    private static String installId = "";
    private static String clientId = "";
    private static long identityAt = 0L;

    private HongguoApi() { }

    /** 匿名身份：10 分钟内复用，过期重注册（注册一次约 200~400ms）。 */
    static synchronized String[] identity() throws Exception {
        long now = System.currentTimeMillis();
        if (!deviceId.isEmpty() && now - identityAt < 600_000L) {
            return new String[]{deviceId, installId, clientId};
        }
        HongguoDirect.Device device = HongguoDirect.register();
        deviceId = device.deviceId;
        installId = device.iid;
        clientId = device.cdid;
        identityAt = now;
        return new String[]{deviceId, installId, clientId};
    }

    // ---------------- 搜索 ----------------

    /**
     * App 内搜索（tab_type 11 = 短剧）。一次请求拿全，比官网接口全，因为官网会混推荐、
     * 还会漏掉全集版（同一部剧第二季有 100 集版和 341 集版，官网只回一个）。
     */
    static JSONObject search(String keyword, int page) throws Exception {
        String[] who = identity();
        LinkedHashMap<String, String> values = versioned("72232", "7.2.2.32");
        values.put("iid", who[1]);
        values.put("device_id", who[0]);
        values.put("query", keyword);
        values.put("count", "20");
        values.put("offset", String.valueOf(Math.max(0, page - 1) * 20));
        values.put("tab_type", "11");
        values.put("bookshelf_search_plan", "4");
        values.put("use_correct", "true");
        values.put("user_is_login", "0");

        long now = System.currentTimeMillis();
        String text = execute(HongguoV5.sign(SEARCH, values, null, now), null);
        JSONObject root = parse(text, "搜索");
        if (root.optInt("code", -1) != 0) {
            throw new IOException("搜索接口暂不可用（" + root.optInt("code") + "）");
        }
        JSONArray tabs = root.optJSONArray("search_tabs");
        if (tabs == null) {
            JSONObject data = root.optJSONObject("data");
            tabs = data == null ? null : data.optJSONArray("search_tabs");
        }
        if (tabs == null) throw new IOException("搜索数据格式已变化");

        JSONObject tab = null;
        for (int i = 0; i < tabs.length(); i++) {
            JSONObject item = tabs.optJSONObject(i);
            if (item != null && item.optInt("tab_type") == 11) tab = item;
        }
        if (tab == null) throw new IOException("短剧搜索暂不可用");

        JSONArray cells = tab.optJSONArray("data");
        JSONArray items = new JSONArray();
        int rawTotal = 0;
        LinkedHashSet<String> seen = new LinkedHashSet<>();
        String query = normalize(keyword);
        for (int i = 0; cells != null && i < cells.length(); i++) {
            JSONObject cell = cells.optJSONObject(i);
            if (cell == null) continue;
            List<JSONObject> rows = new ArrayList<>();
            rows.add(cell);
            JSONObject lynx = cell.optJSONObject("lynx_data");
            if (lynx == null) {
                try { lynx = new JSONObject(cell.optString("lynx_data", "")); } catch (Exception ignored) { }
            }
            JSONArray embedded = lynx == null ? null : lynx.optJSONArray("cell_data");
            for (int j = 0; embedded != null && j < embedded.length(); j++) {
                JSONObject row = embedded.optJSONObject(j);
                if (row != null) rows.add(row);
            }
            for (JSONObject row : rows) {
                Object raw = row.opt("video_data");
                List<JSONObject> videos = new ArrayList<>();
                if (raw instanceof JSONArray) {
                    JSONArray array = (JSONArray) raw;
                    for (int j = 0; j < array.length(); j++) {
                        JSONObject video = array.optJSONObject(j);
                        if (video != null) videos.add(video);
                    }
                } else if (raw instanceof JSONObject) {
                    videos.add((JSONObject) raw);
                }
                rawTotal += videos.size();
                for (JSONObject video : videos) {
                    String id = first(video, "series_id");
                    if (id.isEmpty()) id = row.optString("book_id");
                    if (id.isEmpty()) id = row.optString("search_result_id");
                    if (!id.matches("[0-9]{1,30}")) continue;
                    String title = first(video, "series_name", "series_title", "title");
                    if (title.isEmpty()) {
                        JSONObject highlight = row.optJSONObject("search_high_light");
                        JSONObject hlTitle = highlight == null ? null : highlight.optJSONObject("title");
                        if (hlTitle != null) title = hlTitle.optString("text", "");
                    }
                    if (title.isEmpty()) title = row.optString("cell_name", "");
                    if (title.isEmpty()) continue;
                    /* 官网/App 都会在结果尾部掺推荐；标题里没有查询词的一律丢掉。 */
                    if (!query.isEmpty() && !normalize(title).contains(query) && !isPinyin(query)) continue;
                    if (!seen.add(id)) continue;
                    int count = video.optInt("episode_cnt", 0);
                    /* 预约/待上线（content_type 1007，或 disable_play）不可播，搜索里直接剔掉：
                       用户要的是「聚宝仙盆之杂灵根才是真boss 的 16 季」，第 17 季是预约态。 */
                    if (video.optInt("content_type", 0) == 1007 || video.optBoolean("disable_play", false)) continue;
                    /* 官方系列键：同一 related_album_id 就是同一部剧，season_index 是官方季序号。
                       搜索响应里不一定带，带上了前端就不必再按标题猜。 */
                    long album = video.optLong("related_album_id", 0L);
                    if (album == 0L) album = video.optLong("album_id", 0L);
                    int seasonIndex = video.optInt("season_index", 0);
                    String seasonTag = "";
                    JSONObject tagInfo = video.optJSONObject("tag_info");
                    if (tagInfo != null) seasonTag = tagInfo.optString("text", "");
                    if (seasonTag.isEmpty() && seasonIndex > 0) seasonTag = "第" + seasonIndex + "季";
                    items.put(new JSONObject()
                            .put("id", id)
                            .put("title", title)
                            .put("cover", coverOf(video))
                            .put("description", first(video, "video_desc", "series_intro"))
                            .put("episodeLabel", count > 0 ? "全 " + count + " 集" : video.optString("rec_text", ""))
                            .put("category", "short")
                            .put("vid", video.optString("vid", ""))
                            .put("albumId", album > 0 ? String.valueOf(album) : "")
                            .put("seasonIndex", seasonIndex)
                            .put("season", seasonTag)
                            .put("tags", new JSONArray()));
                }
            }
        }
        boolean more = tab.optBoolean("has_more", false);
        /* rawTotal 是过滤前这一页实际收到多少条：标题不匹配、预约态都会被剔掉，
           items.length 可能远小于一页容量，调用方不能拿它判断有没有下一页。 */
        return new JSONObject().put("items", items).put("nextPage", more ? page + 1 : JSONObject.NULL)
                .put("rawCount", rawTotal);
    }

    // ---------------- 相关作品（其他季） ----------------

    /**
     * 详情页「相关作品」：接口返回一格 show_type=547 的 cell，里面是同一部剧的其他季
     * 加上平台推荐。待上线的 content_type 是 1007，可点但标记「待上线」。
     */
    static JSONArray related(String seriesId, String seriesTitle) throws Exception {
        String[] who = identity();
        LinkedHashMap<String, String> values = versioned("72232", "7.2.2.32");
        values.put("iid", who[1]);
        values.put("device_id", who[0]);
        values.put("scene", "10");
        values.put("from", "detail_page_more_related");
        values.put("book_id", seriesId);
        values.put("new_search_middle_page", "false");
        values.put("bookstore_tab_type", "0");
        values.put("query_history_removed", "false");
        values.put("user_is_login", "0");
        values.put("bookstore_tab", "0");
        values.put("search_middle_page_version", "0");
        values.put("pad_column_detail", "0");
        values.put("hot_word_exchange", "false");
        values.put("device_level", "3");
        values.put("limit", "0");
        values.put("offset", "0");
        values.put("is_horizontal_screen", "false");
        values.put("reader_single_col_from_ip_strategy", "false");

        JSONArray items = new JSONArray();
        LinkedHashSet<String> seen = new LinkedHashSet<>();
        boolean hasTitle = seriesTitle != null && !seriesTitle.trim().isEmpty();
        Exception failure = null;
        try {
            JSONArray cells = relatedCells(values);
            try { collectRelated(cells, seriesId, items, seen, true); } catch (Exception ignored) { }
            /* 真人短剧的相关作品格 show_type / 命名都不稳定（漫剧是 547，真人剧常常没有），
               严格那一遍捞不到就把整个响应里成条的作品都收进来 —— 这个接口本身就是
               「detail_page_more_related」，粒度比空着强。 */
            if (items.length() == 0) {
                try { collectRelated(cells, seriesId, items, seen, false); } catch (Exception ignored) { }
            }
        } catch (Exception error) {
            failure = error;
        }
        /* 还是空（或者接口本身挂了）：按剧名检索同 IP / 其他季，至少别给用户一块空白。 */
        if (items.length() == 0 && hasTitle) {
            collectByTitle(seriesId, seriesTitle.trim(), items, seen);
        }
        if (items.length() == 0 && failure != null) {
            throw new IOException(failure.getMessage() == null ? "相关作品接口暂不可用" : failure.getMessage());
        }
        attachCredits(items);
        return sortSeasons(items, seriesId);
    }

    /**
     * 给相关作品补署名（author / media_id）。
     *
     * 相关作品格只给剧名和封面，没有署名 —— 而电视端要把「同一制作方」的作品挑出来
     * 跟「标题同源」的作品一起卡片组，没有署名就只能按名字猜，准不了。
     * 详情接口支持 book_id 逗号批量（一次最多 20 个），所以整块补一次就够，不逐部发。
     * 失败静默：补不上署名只是不分组，不能让整块相关作品跟着失败。
     */
    private static void attachCredits(JSONArray items) {
        if (items == null || items.length() == 0) return;
        List<String> ids = new ArrayList<>();
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            if (item == null) continue;
            String id = item.optString("id", "");
            if (id.matches("[0-9]{1,30}")) ids.add(id);
        }
        if (ids.isEmpty()) return;
        Map<String, JSONObject> credits;
        try {
            credits = credits(ids);
        } catch (Exception ignored) {
            return;
        }
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            if (item == null) continue;
            JSONObject credit = credits.get(item.optString("id", ""));
            if (credit == null) continue;
            try {
                String author = credit.optString("name", "").trim();
                if (!author.isEmpty()) item.put("author", author);
                String media = credit.optString("mediaId", "");
                if (item.optString("mediaId", "").isEmpty() && !media.isEmpty()) item.put("mediaId", media);
                if (item.optString("episodeLabel", "").isEmpty()) {
                    String label = credit.optString("episodeLabel", "");
                    if (!label.isEmpty()) item.put("episodeLabel", label);
                }
            } catch (Exception ignored) { }
        }
    }

    /** 打「详情页更多相关」计划接口，多个域名轮流试。 */
    private static JSONArray relatedCells(LinkedHashMap<String, String> values) throws Exception {
        String text = null;
        Exception failure = null;
        for (String host : RELATED_HOSTS) {
            try {
                long now = System.currentTimeMillis();
                String raw = execute(HongguoV5.sign(host, values, null, now), null);
                if (!raw.isEmpty()) { text = raw; break; }
            } catch (Exception error) {
                failure = error;
            }
        }
        if (text == null) {
            throw new IOException(failure == null ? "相关作品接口暂无响应" : String.valueOf(failure.getMessage()));
        }
        JSONObject root = parse(text, "相关作品");
        if (root.optInt("code", -1) != 0) throw new IOException("相关作品接口暂不可用");
        return root.optJSONArray("data");
    }

    /**
     * @param strict true = 只认「相关作品」那一格（show_type 547 / 名字带相关）；
     *               false = 该响应里所有成条作品都算候选。
     */
    private static void collectRelated(JSONArray cells, String seriesId, JSONArray items,
                                       LinkedHashSet<String> seen, boolean strict) throws Exception {
        for (int i = 0; cells != null && i < cells.length(); i++) {
            JSONObject cell = cells.optJSONObject(i);
            if (cell == null) continue;
            if (strict) {
                String name = cell.optString("cell_name", "");
                boolean isRelated = cell.optInt("show_type") == 547
                        || name.contains("相关") || name.contains("更多推荐");
                if (!isRelated) continue;
            }
            JSONArray rows = cell.optJSONArray("video_data");
            for (int j = 0; rows != null && j < rows.length(); j++) {
                JSONObject row = rows.optJSONObject(j);
                if (row == null) continue;
                /* 真人剧这一格常见两种形态：短剧直接把作品字段平铺在行上，漫剧/推荐会再包一层
                   video_data。以前只认平铺的 series_id + title，包了一层或换叫 book_id 的
                   整条被丢掉 —— 这就是「只有漫剧有相关作品」的来源。 */
                JSONObject video = row.optJSONObject("video_data");
                if (video == null) video = row;
                String id = first(video, "series_id", "book_id", "id");
                String title = first(video, "title", "series_title", "book_name", "series_name");
                if (id.equals(seriesId) || !id.matches("[0-9]{1,30}") || title.isEmpty()) continue;
                if (!seen.add(id)) continue;
                JSONObject tag = video.optJSONObject("tag_info");
                if (tag == null) tag = row.optJSONObject("tag_info");
                String season = tag == null ? "" : tag.optString("text", "");
                int index = video.optInt("season_index", row.optInt("season_index", 0));
                if (season.isEmpty() && index > 0) season = "第" + index + "季";
                int count = video.optInt("episode_cnt", row.optInt("episode_cnt", 0));
                boolean upcoming = video.optInt("content_type", 0) == 1007
                        || video.optBoolean("disable_play", false);
                items.put(new JSONObject()
                        .put("id", id)
                        .put("title", title)
                        .put("cover", coverOf(video).isEmpty() ? coverOf(row) : coverOf(video))
                        .put("mediaId", first(video, "media_id", "mediaId").isEmpty()
                                ? first(row, "media_id", "mediaId") : first(video, "media_id", "mediaId"))
                        .put("season", season)
                        .put("seasonIndex", index)
                        .put("upcoming", upcoming)
                        .put("episodeLabel", upcoming ? "待上线" : (count > 0 ? "全 " + count + " 集" : "")));
            }
        }
    }

    /** 按剧名检索兜底：同 IP 的作品标题共享主体，季号从「第N季」里读。 */
    private static void collectByTitle(String seriesId, String title, JSONArray items, LinkedHashSet<String> seen)
            throws Exception {
        try {
            JSONObject result = search(title, 1);
            JSONArray rows = result.optJSONArray("items");
            String base = seasonBase(title);
            for (int i = 0; rows != null && i < rows.length(); i++) {
                JSONObject row = rows.optJSONObject(i);
                if (row == null) continue;
                String id = row.optString("id", "");
                String name = row.optString("title", "");
                if (id.isEmpty() || id.equals(seriesId) || name.isEmpty()) continue;
                /* 只收同 IP：标题里得带着主体名，避免把整页搜索结果都搬过来 */
                if (!base.isEmpty() && !normalize(name).contains(normalize(base))) continue;
                if (!seen.add(id)) continue;
                int index = seasonIndexOf(name);
                items.put(new JSONObject()
                        .put("id", id)
                        .put("title", name)
                        .put("cover", coverOf(row))
                        .put("season", index > 0 ? "第" + index + "季" : "")
                        .put("seasonIndex", index)
                        .put("upcoming", false)
                        .put("episodeLabel", row.optString("episodeLabel", "")));
            }
        } catch (Exception ignored) { }
    }

    /** 「某种…第二季」→ 2；没有季号返回 0。 */
    private static int seasonIndexOf(String title) {
        if (title == null) return 0;
        java.util.regex.Matcher match = java.util.regex.Pattern
                .compile("第\\s*([0-9]{1,2}|[一二三四五六七八九十]{1,3})\\s*季").matcher(title);
        if (!match.find()) return 0;
        String value = match.group(1);
        if (value.matches("[0-9]{1,2}")) return Integer.parseInt(value);
        String digits = "一二三四五六七八九十";
        if (value.length() == 1) {
            int at = digits.indexOf(value.charAt(0));
            return at >= 0 ? at + 1 : 0;
        }
        if (value.startsWith("十")) return 10 + Math.max(0, digits.indexOf(value.charAt(1)) + 1);
        if (value.endsWith("十")) return (digits.indexOf(value.charAt(0)) + 1) * 10;
        return 0;
    }

    /** 去掉「第N季 / 第二季」这类后缀，拿来做同 IP 判定。 */
    private static String seasonBase(String title) {
        return title == null ? "" : title.replaceAll("[（(]?第\\s*[0-9一二三四五六七八九十]{1,3}\\s*季[)）]?", "").trim();
    }

    /** 同一部剧的各季按季号排前面，其余推荐按原顺序跟在后面。 */
    private static JSONArray sortSeasons(JSONArray items, String currentId) {
        List<JSONObject> head = new ArrayList<>();
        List<JSONObject> tail = new ArrayList<>();
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            if (item == null) continue;
            if (item.optInt("seasonIndex", 0) > 0 || !item.optString("season").isEmpty()) head.add(item);
            else tail.add(item);
        }
        head.sort((a, b) -> Integer.compare(a.optInt("seasonIndex", 0), b.optInt("seasonIndex", 0)));
        JSONArray out = new JSONArray();
        for (JSONObject item : head) out.put(item);
        for (JSONObject item : tail) out.put(item);
        return out;
    }

    // ---------------- 制作方 ----------------

    /** 制作方资料：author（名字）+ media_id（身份），用于「点作者看其他作品」。 */
    static JSONObject producer(String seriesId) throws Exception {
        String[] who = identity();
        LinkedHashMap<String, String> values = new LinkedHashMap<>(HongguoV5.DEVICE);
        values.put("iid", who[1]);
        values.put("device_id", who[0]);
        values.put("book_id", seriesId);
        values.put("book_type", "2");
        long now = System.currentTimeMillis();
        JSONObject root = parse(execute(HongguoV5.sign(DETAIL, values, null, now), null), "制作方资料");
        JSONArray rows = root.optJSONArray("data");
        for (int i = 0; rows != null && i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null || !seriesId.equals(row.optString("book_id"))) continue;
            String name = row.optString("author", "").trim();
            String media = row.optString("media_id", "");
            if (name.isEmpty()) throw new IOException("这部剧没有标注制作方");
            if (!media.matches("[1-9][0-9]{0,29}")) media = "";
            return new JSONObject().put("name", name).put("mediaId", media);
        }
        throw new IOException("这部剧没有标注制作方");
    }

    /** 制作方候选翻页：一「页」背后是窗口内的多个站点页并行拉，署名命中率才够。 */
    private static final int PRODUCER_PAGE_WINDOW = 3;
    private static final java.util.concurrent.ExecutorService PRODUCER_POOL =
            java.util.concurrent.Executors.newFixedThreadPool(4);

    /**
     * 制作方作品：先用官网搜索拿候选，再逐条核对 media_id 相同才认。
     *
     * 注意候选不能按「标题含关键词」过滤 —— 制作方是署名，不是剧名，
     * 之前复用搜剧那条路径把候选全滤掉了，所以点开永远是空的。
     * 同名制作方很多，认领时必须核对署名（有 media_id 就比 id，没有才退回比名字）。
     *
     * 一次只读一个站点页时，署名命中是稀疏的：20 条候选里常常只有 6~9 条属于这个人，
     * 一页作品要「加载更多」点好几次才凑齐，点开还老觉得「展示不全」。所以这里把
     * 一「页」扩成窗口内 3 个站点页并行拉，候选从 20 条涨到 60 条再一起核对。
     */
    static JSONObject producerWorks(String name, String mediaId, int page) throws Exception {
        int first = (Math.max(1, page) - 1) * PRODUCER_PAGE_WINDOW + 1;
        List<Future<JSONObject>> futures = new ArrayList<>();
        for (int i = 0; i < PRODUCER_PAGE_WINDOW; i++) {
            final int target = first + i;
            futures.add(PRODUCER_POOL.submit(new java.util.concurrent.Callable<JSONObject>() {
                @Override public JSONObject call() throws Exception { return siteSearch(name, target, false); }
            }));
        }
        List<JSONObject> pages = new ArrayList<>();
        boolean more = false;
        for (Future<JSONObject> future : futures) {
            try {
                JSONObject one = future.get(9, java.util.concurrent.TimeUnit.SECONDS);
                if (one == null) continue;
                pages.add(one);
                more |= one.optBoolean("hasMore", false);
            } catch (Exception ignored) { }
        }
        JSONArray rows = new JSONArray();
        Set<String> ids = new LinkedHashSet<>();
        for (JSONObject one : pages) {
            JSONArray list = one.optJSONArray("items");
            for (int i = 0; list != null && i < list.length(); i++) {
                JSONObject row = list.optJSONObject(i);
                String id = row == null ? "" : row.optString("id");
                if (id.isEmpty() || !ids.add(id)) continue;
                rows.put(row);
            }
        }
        JSONArray out = new JSONArray();
        if (rows.length() == 0) {
            return new JSONObject().put("items", out).put("hasMore", false);
        }
        List<String> wanted = new ArrayList<>(ids);
        Map<String, JSONObject> credits = new LinkedHashMap<>();
        /* 署名查询偶发超时：先整批取，缺的那几条再补一次。
           以前缺了就 continue，于是同一部剧今天有、明天少，看着像「搜索不稳定」。 */
        for (int round = 0; round < 2; round++) {
            List<String> batch = new ArrayList<>();
            for (String id : wanted) if (!credits.containsKey(id)) batch.add(id);
            if (batch.isEmpty()) break;
            try { credits.putAll(credits(batch)); } catch (Exception ignored) { }
        }
        String target = normalize(name);
        Set<String> seenTitle = new LinkedHashSet<>();
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) continue;
            JSONObject credit = credits.get(row.optString("id"));
            if (credit == null) continue;
            String creditMedia = credit.optString("mediaId", "");
            String creditName = credit.optString("name", "");
            /* 署名必须是本人：站内搜索「陈柯文化」会连带推荐一堆同 IP、同题材的剧，
               这些剧的 author 根本不是他。以前只在「media_id 缺失」时才比署名，
               于是只要站点翻出来就认领，「不是他的也列在他名下」。
               现在反过来：署名先过，media_id 两边都有时再要求相等。 */
            String creditKey = normalize(creditName);
            if (target.isEmpty() || creditKey.isEmpty()) continue;
            if (!creditKey.equals(target) && !creditKey.contains(target)) continue;
            if (!mediaId.isEmpty() && !creditMedia.isEmpty() && !mediaId.equals(creditMedia)) continue;
            String title = credit.optString("title", row.optString("title"));
            if (title.isEmpty() || !seenTitle.add(normalize(title))) continue;
            /* 封面优先用站内搜索的那张，再退回多详情：
               多详情给的是 p*-reading-sign.fqnovelpic.com/…~tplv-noop.heic?签名 这种
               带时效签名的 HEIC 原图，WebView 解不了码，只能显示灰块；站内搜索给的是
               p*-novel.byteimg.com/…~tplv-shrink:640:0.image，就是网站列表上那张 JPEG。
               以前这里反过来（先 credit 后 row），于是「真人剧点制作方全是灰块、
               漫剧因为 credit 没匹配上反而落到了 row 上」—— 两种题材两套结果。 */
            String cover = coverOf(row);
            if (cover.isEmpty()) cover = coverOf(credit);
            out.put(new JSONObject()
                    .put("id", row.optString("id"))
                    .put("title", title)
                    .put("cover", cover)
                    .put("episodeLabel", credit.optString("episodeLabel", "")));
        }
        return new JSONObject().put("items", out).put("hasMore", more);
    }

    /** 批量取 author / media_id（接口一次最多 20 个）。 */
    static Map<String, JSONObject> credits(List<String> ids) throws Exception {
        Map<String, JSONObject> out = new LinkedHashMap<>();
        if (ids == null || ids.isEmpty()) return out;
        String[] who = identity();
        List<String> batch = new ArrayList<>();
        for (String id : ids) {
            if (id != null && id.matches("[0-9]{1,30}") && !out.containsKey(id) && !batch.contains(id)) batch.add(id);
            if (batch.size() >= 20) {
                fetchCredits(batch, who, out);
                batch.clear();
            }
        }
        if (!batch.isEmpty()) fetchCredits(batch, who, out);
        return out;
    }

    private static void fetchCredits(List<String> batch, String[] who, Map<String, JSONObject> out) throws Exception {
        LinkedHashMap<String, String> values = new LinkedHashMap<>(HongguoV5.DEVICE);
        values.put("iid", who[1]);
        values.put("device_id", who[0]);
        values.put("book_id", join(batch, ","));
        values.put("book_type", "2");
        long now = System.currentTimeMillis();
        JSONObject root = parse(execute(HongguoV5.sign(DETAIL, values, null, now), null), "制作方资料");
        JSONArray rows = root.optJSONArray("data");
        for (int i = 0; rows != null && i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) continue;
            String id = row.optString("book_id", "");
            if (!id.matches("[0-9]{1,30}")) continue;
            int count = row.optInt("total_chapter_num",
                    row.optInt("chapter_number", row.optInt("final_chapter_number", 0)));
            out.put(id, new JSONObject()
                    .put("name", row.optString("author", "").trim())
                    .put("mediaId", row.optString("media_id", ""))
                    .put("title", row.optString("book_name", ""))
                    .put("cover", coverOf(row))
                    .put("episodeLabel", count > 0 ? "全 " + count + " 集" : ""));
        }
    }

    // ---------------- 评论（分集） ----------------

    /**
     * 分集评论，20 条一页，用服务端下发的 cursor 续读。
     * 只读：没有任何写接口，也不带账号 Cookie。
     */
    static JSONObject comments(String seriesId, String episodeId, String cursor) throws Exception {
        JSONObject payload = new JSONObject()
                .put("comment_source", 4)
                .put("server_channel", 18)
                .put("group_id", episodeId)
                .put("group_type", 30)
                .put("comment_type", 4)
                .put("sort", 1)
                .put("need_count", true)
                .put("count", 20)
                .put("cursor", cursor == null ? "" : cursor)
                .put("aid", 8662)
                .put("compliance_status", 0)
                .put("business_param", new JSONObject().put("book_id", seriesId).put("req_type", 0));
        JSONObject root = readComments(episodeId, payload, 4, 18);
        if (root.optInt("code", -1) != 0) throw new IOException("评论接口未返回数据");

        JSONObject data = root.optJSONObject("data");
        if (data == null) throw new IOException("评论数据格式已变化");
        JSONObject info = data.optJSONObject("common_list_info");
        JSONArray rows = data.optJSONArray("data_list");
        JSONArray items = new JSONArray();
        LinkedHashSet<String> seen = new LinkedHashSet<>();
        for (int i = 0; rows != null && i < Math.min(rows.length(), 100); i++) {
            JSONObject wrapper = rows.optJSONObject(i);
            JSONObject comment = wrapper == null ? null : wrapper.optJSONObject("comment");
            if (comment == null) continue;
            JSONObject common = comment.optJSONObject("common");
            if (common == null) continue;
            if (common.optInt("status", -1) != 1) continue;
            JSONObject content = common.optJSONObject("content");
            String text = content == null ? "" : content.optString("text", "").trim();
            if (text.isEmpty()) continue;
            String id = comment.optString("comment_id", "");
            if (id.isEmpty() || !seen.add(id)) continue;
            JSONObject user = common.optJSONObject("user_info");
            JSONObject base = user == null ? null : user.optJSONObject("base_info");
            String avatar = base == null ? "" : base.optString("user_avatar", "");
            if (!avatar.startsWith("https://")) avatar = "";
            items.put(new JSONObject()
                    .put("id", id)
                    .put("author", base == null ? "" : base.optString("user_name", ""))
                    .put("avatar", avatar)
                    .put("content", text.length() > 2000 ? text.substring(0, 2000) : text)
                    .put("created", common.optLong("create_timestamp", 0))
                    .put("likes", diggCount(comment, common)));
        }
        String next = info == null ? "" : info.optString("cursor", "");
        boolean more = info != null && info.optBoolean("has_more", false) && !next.isEmpty() && !next.equals(cursor);
        return new JSONObject()
                .put("items", items)
                .put("nextCursor", more ? next : "")
                .put("hasMore", more)
                .put("total", info == null ? 0 : info.optLong("total", 0));
    }

    private static int diggCount(JSONObject comment, JSONObject common) {
        JSONObject stats = comment.optJSONObject("statistics");
        if (stats != null) {
            int value = stats.optInt("digg_count", stats.optInt("like_count", -1));
            if (value >= 0) return value;
        }
        return Math.max(0, common.optInt("digg_count", 0));
    }

    // ---------------- 弹幕（时间轴） ----------------

    /**
     * 时间轴弹幕：按 30 秒一段向后取，每条带 offset_time（毫秒）。
     * 没有弹幕的剧返回空列表，不拿普通评论顶替。
     */
    static JSONObject danmaku(String seriesId, String episodeId, long startMS, long durationMS) throws Exception {
        if (startMS < 0) startMS = 0;
        if (durationMS <= startMS) durationMS = startMS + 60_000L;
        JSONArray guide = new JSONArray();
        guide.put(1);
        guide.put(3);
        guide.put(4);
        guide.put(2);
        JSONObject payload = new JSONObject()
                .put("comment_source", 601)
                .put("server_channel", 1000)
                .put("group_id", episodeId)
                .put("group_type", 30)
                .put("comment_type", 20)
                .put("sort", 1)
                .put("count", 90)
                .put("cursor", "")
                .put("aid", 8662)
                .put("compliance_status", 0)
                .put("business_param", new JSONObject()
                        .put("book_id", seriesId)
                        .put("start_offset_time", startMS)
                        .put("playlet_item_duration", durationMS)
                        .put("need_danmaku_guide_type", guide));
        JSONObject root = readComments(episodeId, payload, 601, 1000);
        if (root.optInt("code", -1) != 0) throw new IOException("弹幕接口未返回数据");

        JSONObject data = root.optJSONObject("data");
        if (data == null) return new JSONObject().put("items", new JSONArray()).put("nextMS", durationMS);
        JSONObject extra = data.optJSONObject("extra");
        long next = extra == null ? durationMS : extra.optLong("next_query_danmaku_list_time", durationMS);
        if (next <= startMS) next = durationMS;
        long end = Math.min(next, durationMS);

        JSONArray rows = data.optJSONArray("data_list");
        JSONArray items = new JSONArray();
        LinkedHashSet<String> seen = new LinkedHashSet<>();
        for (int i = 0; rows != null && i < Math.min(rows.length(), 300); i++) {
            JSONObject wrapper = rows.optJSONObject(i);
            JSONObject comment = wrapper == null ? null : wrapper.optJSONObject("comment");
            if (comment == null) continue;
            JSONObject common = comment.optJSONObject("common");
            JSONObject expand = comment.optJSONObject("expand");
            if (common == null || expand == null) continue;
            if (common.optInt("status", -1) != 1) continue;
            long time = expand.optLong("offset_time", -1);
            if (time < startMS || time >= end) continue;
            JSONObject content = common.optJSONObject("content");
            String text = content == null ? "" : content.optString("text", "").trim();
            text = text.replaceAll("[\\p{Cc}\\u2028\\u2029]", " ");
            if (text.isEmpty()) continue;
            String id = comment.optString("comment_id", "");
            if (id.isEmpty() || !seen.add(id)) continue;
            items.put(new JSONObject().put("id", id).put("text", text).put("timeMS", time));
            if (items.length() >= 90) break;
        }
        return new JSONObject().put("items", items).put("nextMS", end).put("durationMS", durationMS);
    }

    private static JSONObject readComments(String episodeId, JSONObject payload, int source, int channel)
            throws Exception {
        byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
        String[] who = identity();
        LinkedHashMap<String, String> values = versioned("74332", "7.4.3.32");
        values.put("iid", who[1]);
        values.put("device_id", who[0]);
        long now = System.currentTimeMillis();
        HongguoV5.Signed signed = HongguoV5.signPlayback(COMMENT + episodeId + "/v1/", values, body, now);
        Request.Builder builder = new Request.Builder().url(signed.url)
                .header("User-Agent", "com.phoenix.read/74332 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3)")
                .header("Accept", "application/json")
                .header("Content-Type", "application/json; charset=utf-8")
                .header("Comment-Source", String.valueOf(source))
                .header("Server-Channel", String.valueOf(channel))
                .header("x-ss-stub", HongguoV5.hexText(HongguoV5.md5(body)).toUpperCase());
        for (Map.Entry<String, String> entry : signed.headers.entrySet()) {
            builder.header(entry.getKey(), entry.getValue());
        }
        return parse(execute(builder.post(RequestBody.create(body, JSON)).build()), "评论");
    }

    // ---------------- 官网搜索（兜底 / 制作方作品） ----------------

    private static JSONObject siteSearch(String keyword, int page) throws Exception {
        return siteSearch(keyword, page, true);
    }

    /**
     * @param filterTitle true = 只留标题里含关键词的结果（普通搜剧）；
     *                    false = 保留全部候选（按制作方署名搜，标题里当然没有署名）。
     */
    private static JSONObject siteSearch(String keyword, int page, boolean filterTitle) throws Exception {
        Request request = new Request.Builder()
                .url(SITE + "/api/search/result?query=" + HongguoV5.encode(keyword) + "&page=" + page)
                .header("User-Agent", "Mozilla/5.0")
                .header("Referer", SITE + "/")
                .header("Accept", "application/json")
                .build();
        String text = execute(request);
        JSONObject root;
        try { root = new JSONObject(text); } catch (Exception error) { throw new IOException("搜索响应格式已变化"); }
        JSONArray rows = root.optJSONArray("searchList");
        JSONArray items = new JSONArray();
        LinkedHashSet<String> seen = new LinkedHashSet<>();
        String query = normalize(keyword);
        for (int i = 0; rows != null && i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            JSONObject video = row == null ? null : row.optJSONObject("video_data");
            if (video == null) continue;
            String id = video.optString("series_id", "");
            String title = video.optString("series_title", row.optString("name", ""));
            String genre = video.optString("genre", "");
            /* 203 = 真人短剧，205 = 漫剧。以前只收 203，于是漫剧详情点「制作方」永远是
               “平台检索不到该制作方的其他作品”—— 漫剧署名下的作品全被这一行筛掉了。 */
            if (!"203".equals(genre) && !"205".equals(genre)) continue;
            if (!id.matches("[0-9]{1,30}") || title.isEmpty()) continue;
            if (filterTitle && !query.isEmpty() && !normalize(title).contains(query) && !isPinyin(query)) continue;
            if (!seen.add(id)) continue;
            items.put(new JSONObject()
                    .put("id", id)
                    .put("title", title)
                    .put("cover", coverOf(video)));
        }
        boolean more = root.has("hasMore") ? root.optBoolean("hasMore")
                : root.optInt("totalPages", 0) > 0 && page < root.optInt("totalPages");
        return new JSONObject().put("items", items).put("hasMore", more);
    }

    // ---------------- 工具 ----------------

    private static LinkedHashMap<String, String> versioned(String code, String name) {
        LinkedHashMap<String, String> values = new LinkedHashMap<>(HongguoV5.DEVICE);
        for (String key : VERSION_KEYS) values.put(key, code);
        values.put("version_name", name);
        return values;
    }

    private static String execute(HongguoV5.Signed signed, byte[] body) throws IOException {
        Request.Builder builder = new Request.Builder().url(signed.url);
        for (Map.Entry<String, String> entry : signed.headers.entrySet()) {
            builder.header(entry.getKey(), entry.getValue());
        }
        if (body != null) builder.post(RequestBody.create(body, JSON));
        return execute(builder.build());
    }

    private static String execute(Request request) throws IOException {
        try (Response response = HTTP.newCall(request).execute()) {
            if (!response.isSuccessful()) throw new IOException("接口返回 HTTP " + response.code());
            if (response.body() == null) throw new IOException("接口没有返回内容");
            String text = response.body().string();
            if (text.isEmpty()) throw new IOException("接口返回空正文（身份或签名被拒）");
            return text;
        }
    }

    private static JSONObject parse(String text, String what) throws IOException {
        String clean = text.startsWith("\uFEFF") ? text.substring(1) : text;
        try {
            return new JSONObject(clean);
        } catch (Exception error) {
            throw new IOException(what + "返回了无法识别的内容");
        }
    }

    private static String first(JSONObject object, String... names) {
        for (String name : names) {
            String value = object.optString(name, "");
            if (!value.isEmpty()) return value;
        }
        return "";
    }

    /**
     * 封面字段各家接口叫法不一样：红果搜索/联想是 series_cover，多详情是 thumb_url，
     * App 接口是 cover，官网 HTML 走 profile 里的 cover。以前每条链路只认自己那一种，
     * 换条链路进来就是灰块 —— 统一按优先级取第一个能用的。
     */
    static String coverOf(JSONObject object) {
        if (object == null) return "";
        String[] names = {"cover", "series_cover", "cover_url", "series_cover_url",
                "thumb_url", "horizontal_cover", "poster", "image", "cover_uri", "thumb_uri"};
        List<String> found = new ArrayList<>();
        for (String name : names) {
            String value = rawUrl(object.opt(name));
            if (!value.isEmpty()) found.add(value);
        }
        /* 有的接口把封面做成 {url_list:[...]} / ["..."]，再往里兜一层 */
        for (String name : names) {
            Object raw = object.opt(name);
            if (raw instanceof JSONObject) {
                String value = rawUrl(((JSONObject) raw).opt("url_list"));
                if (value.isEmpty()) value = rawUrl(((JSONObject) raw).opt("uri"));
                if (!value.isEmpty()) found.add(value);
            } else if (raw instanceof JSONArray) {
                String value = rawUrl(((JSONArray) raw).opt(0));
                if (!value.isEmpty()) found.add(value);
            }
        }
        for (String value : found) {
            String cover = normalizeCover(value);
            /* 一张都转不成 JPEG 的 HEIC 别拿去当封面：WebView 解不了，只会留个灰块，
               不如继续看下一个候选字段。 */
            if (!cover.isEmpty() && !cover.contains(".heic")) return cover;
        }
        return "";
    }

    /**
     * 把 HEIC 原图地址换成网站列表在用的 JPEG 模板。
     *
     * 多详情接口给的封面是 p3-reading-sign.fqnovelpic.com/novel-pic/<hash>~tplv-noop.heic?lk3s=…
     * &x-signature=…：带时效签名的 HEIC，既解不了码、签名过期还会 403。
     * 同一张图在站内列表里用的是 p3-novel.byteimg.com/novel-pic/<hash>~tplv-shrink:640:0.image，
     * 换域名 + 换模板即可拿到 JPEG（已实测 200 image/jpeg）。换不动就原样返回。
     */
    static String normalizeCover(String url) {
        if (url == null || url.isEmpty()) return "";
        java.util.regex.Matcher sign = java.util.regex.Pattern
                .compile("^https://(p\\d+)-reading-sign\\.fqnovelpic\\.com(/.*)$")
                .matcher(url);
        if (!sign.matches()) return url;
        String path = sign.group(2);
        int cut = path.indexOf('?');
        if (cut >= 0) path = path.substring(0, cut);
        path = path.replaceAll("~tplv-[^/]*$", "~tplv-shrink:640:0.image");
        return "https://" + sign.group(1) + "-novel.byteimg.com" + path;
    }

    /** 字段可能是字符串，也可能是 {uri/url/url_list} 或数组，统一取一个能用的 https 地址。 */
    private static String rawUrl(Object raw) {
        if (raw == null) return "";
        if (raw instanceof String) return cleanUrl((String) raw);
        if (raw instanceof JSONObject) {
            JSONObject object = (JSONObject) raw;
            String value = cleanUrl(object.optString("url", ""));
            if (value.isEmpty()) value = cleanUrl(object.optString("src", ""));
            if (value.isEmpty()) value = rawUrl(object.opt("url_list"));
            if (value.isEmpty()) {
                String uri = cleanUrl(object.optString("uri", ""));
                if (!uri.isEmpty()) value = uri;
            }
            return value;
        }
        if (raw instanceof JSONArray) {
            JSONArray array = (JSONArray) raw;
            for (int i = 0; i < array.length(); i++) {
                String value = rawUrl(array.opt(i));
                if (!value.isEmpty()) return value;
            }
        }
        return "";
    }

    private static String cleanUrl(String url) {
        if (url == null) return "";
        String value = url.trim();
        if (value.startsWith("//")) value = "https:" + value;
        if (value.startsWith("http://")) value = "https://" + value.substring(7);
        return value.startsWith("https://") ? value : "";
    }

    private static String normalize(String text) {
        return text == null ? "" : text.replaceAll("\\s+", "").toLowerCase(Locale.ROOT);
    }

    private static boolean isPinyin(String query) {
        if (query.isEmpty()) return false;
        for (int i = 0; i < query.length(); i++) {
            char c = query.charAt(i);
            if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))) return false;
        }
        return true;
    }

    private static String join(List<String> values, String sep) {
        StringBuilder sb = new StringBuilder();
        for (String value : values) {
            if (sb.length() > 0) sb.append(sep);
            sb.append(value);
        }
        return sb.toString();
    }
}
