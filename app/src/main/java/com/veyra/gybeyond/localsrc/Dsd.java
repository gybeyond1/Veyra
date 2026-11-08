package com.veyra.gybeyond.localsrc;

import org.json.JSONArray;
import org.json.JSONObject;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 帝果（www.dsd.com.se，苹果 CMS 模板站）：端侧实现。
 *
 * 这个站按出口 IP 拦机房，后端在国内云上直接超时；手机出口正常，
 * 所以解析挪到端上反而是「修好」它，而不是降级。
 *
 * 三个坑都踩过，改之前先看清楚：
 *  1. 它没有 /vod/detail/id/x.html 这种「详情页」——详情和第一集播放页是同一张
 *     页面（/index.php/vod/play/id/x/sid/1/nid/1.html）。去抓 detail 页只会拿到
 *     一张空模板，于是「详情页没有解析到分集」。
 *  2. 卡片是一个 <a> 包住标题 + 播放量 + 时长，直接取 a.text() 会得到
 *     「剧名 452346次 02:07:40」。标题必须从 .video-desc 之类的子节点取。
 *  3. 播放地址要经 /addons/vplayer/?url=<路径> 换一次签名（返回 aaencode 编码的
 *     vPath），Referer 也得跟着换成 /addons/vplayer/，否则分片 403。
 */
public final class Dsd implements LocalSource {

    private static final String SITE = "https://www.dsd.com.se";
    private static final String UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

    /** player_aaaa = {…} 的定位（这站还有 player_bbb 之类，取第一个 id+url 齐的）。 */
    private static final Pattern PLAYER_ASSIGN = Pattern.compile("\\bplayer_[A-Za-z0-9_]+\\s*=\\s*");

    private static final Pattern PAGE_NUMBER = Pattern.compile("/page/(\\d+)");

    private static final String[] TITLE_NODES = {
            ".video-desc", ".surface-title", ".video-title", ".video-name", ".title"
    };

    @Override public String id() { return "dsd"; }
    @Override public String name() { return "帝果"; }

    /* ---------------- 抓页面 ---------------- */

    private static final class Page {
        final String url;
        final Document doc;

        Page(String url, Document doc) {
            this.url = url;
            this.doc = doc;
        }
    }

    private Page page(String path) throws Exception {
        String url = path.matches("(?i)^https?://.*") ? path
                : SITE + (path.startsWith("/") ? "" : "/") + path;
        Net.Res res;
        try {
            res = Net.get(url, Net.headers(
                    "User-Agent", UA,
                    "Accept", "text/html,application/xhtml+xml",
                    "Accept-Language", "zh-CN,zh;q=0.9"), 12000, 6L << 20);
        } catch (Exception error) {
            throw new IllegalStateException("帝果连不上（" + error.getMessage() + "）", error);
        }
        if (res.status < 200 || res.status >= 300) throw new IllegalStateException("帝果返回 " + res.status);
        String html = res.text();
        if (!html.matches("(?is).*<\\s*(html|body|div|a)\\b.*")) throw new IllegalStateException("帝果返回的不是页面");
        return new Page(url, Jsoup.parse(html, url));
    }

    /* ---------------- 路由：兼容 /index.php、.html、?query 三种写法 ---------------- */

    private static final class Route {
        final String action;
        final Map<String, String> params;

        Route(String action, Map<String, String> params) {
            this.action = action;
            this.params = params;
        }

        String get(String key) {
            String value = params.get(key);
            return value == null ? "" : value;
        }

        int intOf(String key) {
            try {
                return Integer.parseInt(get(key).replaceAll("\\D", ""));
            } catch (Exception error) {
                return 0;
            }
        }
    }

    private static Route route(String reference) {
        String value = reference == null ? "" : reference.trim();
        if (value.isEmpty()) return null;
        try {
            java.net.URI uri = java.net.URI.create(value);
            if (uri.getHost() != null && !uri.getHost().equalsIgnoreCase("www.dsd.com.se")
                    && !uri.getHost().equalsIgnoreCase("dsd.com.se")) return null;
            String path = uri.getPath() == null ? "" : uri.getPath();
            if (path.startsWith("/index.php")) path = path.substring("/index.php".length());
            path = path.replaceAll("/+$", "");
            if (path.toLowerCase().endsWith(".html")) path = path.substring(0, path.length() - 5);
            String[] parts = path.replaceAll("^/+", "").split("/");
            if (parts.length < 2 || !"vod".equals(parts[0])) return null;
            String action = parts[1];
            if (!"play".equals(action) && !"detail".equals(action) && !"type".equals(action)
                    && !"show".equals(action) && !"search".equals(action)) return null;

            Map<String, String> params = new LinkedHashMap<>();
            for (int i = 2; i + 1 < parts.length; i += 2) {
                if (!parts[i].isEmpty()) params.put(parts[i], parts[i + 1]);
            }
            String query = uri.getRawQuery();
            if (query != null && !query.isEmpty()) {
                for (String pair : query.split("&")) {
                    int eq = pair.indexOf('=');
                    if (eq <= 0) continue;
                    String key = dec(pair.substring(0, eq));
                    if (!params.containsKey(key)) params.put(key, dec(pair.substring(eq + 1)));
                }
            }
            return new Route(action, params);
        } catch (Exception error) {
            return null;
        }
    }

    private static String dec(String value) {
        try {
            return java.net.URLDecoder.decode(value, "UTF-8");
        } catch (Exception error) {
            return value;
        }
    }

    /* ---------------- 小工具 ---------------- */

    private static String clean(String value) {
        return value == null ? "" : value.replaceAll("\\s+", " ").trim();
    }

    private static String digits(String value) {
        return value == null ? "" : value.replaceAll("\\D", "");
    }

    /** 卡片整段文本兜底：切掉播放量、时长、集数标签，别让它们混进剧名。 */
    private static String tidy(String raw) {
        String value = clean(raw);
        if (value.isEmpty()) return "";
        // <title> / og:title 带着的站点后缀，先摘干净
        value = value.replaceAll("(?i)^\\s*在线播放\\s*", "");
        value = value.replaceAll("(?i)\\s*第\\s*\\d+\\s*集.*$", "");
        value = value.replaceAll("(?i)\\s*[-|_]\\s*(高清资源|懂色帝|在线观看|免费观看).*$", "");
        value = value.replaceAll("(?i)\\s*\\|\\s*www\\.[^\\s|]+.*$", "");
        for (int i = 0; i < 6; i++) {
            String before = value;
            // 全 88 集 / 更新至12集 —— 这类标签夹在中间也要摘掉
            value = value.replaceAll("(?i)\\s*(更新至|全|共|已完结)\\s*\\d+\\s*集\\s*", " ");
            // 尾巴：剧名 452346次 02:07:40
            value = value.replaceAll("\\s*\\d+(\\.\\d+)?\\s*(万|亿)?\\s*次\\s*$", "");
            value = value.replaceAll("\\s*\\d{1,2}:\\d{2}(:\\d{2})?\\s*$", "");
            // 脑袋：452346次 02:07:40 剧名（有的模板 DOM 顺序是反的）
            value = value.replaceAll("(?i)^\\s*(\\d+(\\.\\d+)?\\s*(万|亿)?\\s*次|\\d{1,2}:\\d{2}(:\\d{2})?)\\s*", "");
            // 卡片里用来换行的裸反斜杠
            value = value.replaceAll("^[\\\\|\\s]+", "");
            value = value.replaceAll("\\\\", " ");
            value = value.replaceAll("\\s{2,}", " ").trim();
            if (value.equals(before)) break;
        }
        return value.trim();
    }

    private static String firstText(Element root, String... selectors) {
        for (String selector : selectors) {
            Element hit = root.selectFirst(selector);
            if (hit == null) continue;
            String text = clean(hit.text());
            if (!text.isEmpty()) return text;
        }
        return "";
    }

    private static String coverOf(Document doc) {
        Element image = doc.selectFirst("meta[property=og:image]");
        if (image != null && !image.attr("content").trim().isEmpty()) return image.attr("content").trim();
        for (Element img : doc.select("img")) {
            for (String key : new String[]{"data-src", "data-original", "data-echo", "src"}) {
                String value = img.attr(key).trim();
                if (value.isEmpty() || value.startsWith("data:")) continue;
                String absolute = img.absUrl(key);
                return absolute.isEmpty() ? value : absolute;
            }
        }
        for (Element node : doc.select("[style]")) {
            String style = node.attr("style");
            if (style.isEmpty()) continue;
            Matcher hit = Pattern.compile("url\\(\\s*[\"']?([^\"')]+)").matcher(style);
            if (hit.find()) return Net.absolute(doc.baseUri(), hit.group(1));
        }
        return "";
    }

    private static String cardCover(Element link) {
        for (Element img : link.select("img")) {
            for (String key : new String[]{"data-src", "data-original", "data-echo", "src"}) {
                String value = img.attr(key).trim();
                if (value.isEmpty() || value.startsWith("data:")) continue;
                if (key.equals("src") && !value.contains("/upload") && !value.startsWith("/video")) continue;
                String absolute = img.absUrl(key);
                return absolute.isEmpty() ? value : absolute;
            }
        }
        for (Element node : link.select("div, span, a")) {
            String style = node.attr("style");
            if (style.isEmpty()) continue;
            Matcher hit = Pattern.compile("url\\(\\s*[\"']?([^\"')]+)").matcher(style);
            if (hit.find()) return hit.group(1);
        }
        return "";
    }

    /* ---------------- 目录 ---------------- */

    /**
     * 列表卡片上抓到的封面，按 id 存着。
     *
     * 播放页的正文是 JS 注入的，服务端 HTML 里只有标题和简介 —— 封面常常拿不到，
     * 而封面恰好是这个站唯一能反推媒体地址的线索（…/FNS-206/1.jpg → …/FNS-206/1000k/index.m3u8）。
     */
    private final Map<String, String> coverCache = new LinkedHashMap<String, String>(64, 0.75f, true) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, String> eldest) {
            return size() > 256;
        }
    };

    private void remember(String id, String cover) {
        if (id == null || id.isEmpty() || cover == null || cover.isEmpty()) return;
        synchronized (coverCache) {
            coverCache.put(id, cover);
        }
    }

    private String rememberedCover(String id) {
        synchronized (coverCache) {
            String value = coverCache.get(id);
            return value == null ? "" : value;
        }
    }

    /**
     * 封面反推媒体地址：/video1/<组>/<番号>/1.jpg → /video1/<组>/<番号>/1000k/index.m3u8。
     * 这是参考实现里的兜底，也是这个站「没有 player_aaaa 也能播」的关键。
     */
    private static String mediaFromCover(String cover) {
        if (cover == null || cover.isEmpty()) return "";
        try {
            java.net.URL url = new java.net.URL(cover);
            String path = url.getPath() == null ? "" : url.getPath();
            if (!path.matches("(?i)^/video\\d*/.*/1\\.(jpg|jpeg|png|webp)$")) return "";
            String directory = path.substring(0, path.lastIndexOf('/'));
            return url.getProtocol() + "://" + url.getAuthority() + directory + "/1000k/index.m3u8";
        } catch (Exception error) {
            return "";
        }
    }

    private List<JSONObject> cards(Document doc) {
        List<JSONObject> items = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        List<Element> links = doc.select("a.video-item, a.video-surface");
        if (links.isEmpty()) links = doc.select("a[href*=/vod/]");
        for (Element link : links) {
            Route route = route(link.absUrl("href").isEmpty() ? link.attr("href") : link.absUrl("href"));
            if (route == null || !("play".equals(route.action) || "detail".equals(route.action))) continue;
            String id = route.get("id");
            if (id.isEmpty() || seen.contains(id)) continue;

            String title = firstText(link, TITLE_NODES);
            if (title.isEmpty()) title = clean(link.attr("title"));
            if (title.isEmpty()) {
                Element img = link.selectFirst("img");
                if (img != null) title = clean(img.attr("alt"));
            }
            if (title.isEmpty()) title = tidy(link.text());
            title = tidy(title).replaceAll("^(VIP|会员|独播|新剧)\\s*", "");
            if (title.isEmpty() || title.length() > 80) continue;

            seen.add(id);
            String label = "";
            Matcher total = Pattern.compile("(?:全|更新至|共|已完结)\\s*(\\d+)\\s*集").matcher(clean(link.text()));
            if (total.find()) label = "全 " + total.group(1) + " 集";
            String cover = cardCover(link);
            remember(id, cover);
            try {
                items.add(new JSONObject()
                        .put("id", id)
                        .put("title", title.length() > 200 ? title.substring(0, 200) : title)
                        .put("cover", cover)
                        .put("description", "")
                        .put("score", "")
                        .put("episodeLabel", label)
                        .put("category", "短剧")
                        .put("tags", new JSONArray())
                        .put("status", label.isEmpty() ? "" : "finished"));
            } catch (Exception ignored) { }
        }
        return items;
    }

    private JSONArray categoriesOf(Document doc) {
        JSONArray list = new JSONArray();
        Set<String> seen = new LinkedHashSet<>();
        for (Element link : doc.select("a[href]")) {
            Route route = route(link.absUrl("href").isEmpty() ? link.attr("href") : link.absUrl("href"));
            if (route == null || !"type".equals(route.action)) continue;
            String id = route.get("id");
            String name = clean(link.text());
            if (id.isEmpty() || name.isEmpty() || name.length() > 12) continue;
            if (!seen.add(id)) continue;
            try {
                list.put(new JSONObject().put("id", id).put("name", name));
            } catch (Exception ignored) { }
            if (list.length() >= 24) break;
        }
        return list;
    }

    private static int pageCount(Document doc) {
        int max = 1;
        for (Element link : doc.select("a[href]")) {
            String href = link.absUrl("href").isEmpty() ? link.attr("href") : link.absUrl("href");
            Matcher match = PAGE_NUMBER.matcher(href);
            while (match.find()) {
                try {
                    max = Math.max(max, Integer.parseInt(match.group(1)));
                } catch (Exception ignored) { }
            }
        }
        return max;
    }

    private volatile JSONArray categoriesCache;
    private volatile long categoriesAt;

    private JSONArray loadCategories() throws Exception {
        long now = System.currentTimeMillis();
        if (categoriesCache != null && now - categoriesAt < 6L * 3600 * 1000) return categoriesCache;
        Page home = page("/");
        JSONArray list = categoriesOf(home.doc);
        if (list.length() == 0) throw new IllegalStateException("帝果没有返回分类");
        categoriesCache = list;
        categoriesAt = now;
        return list;
    }

    private String defaultCategory() throws Exception {
        JSONArray list = loadCategories();
        for (int i = 0; i < list.length(); i++) {
            JSONObject item = list.optJSONObject(i);
            if (item != null && !item.optString("id").isEmpty()) return item.optString("id");
        }
        throw new IllegalStateException("帝果没有返回分类");
    }

    private JSONObject loadList(String categoryId, int pageNumber) throws Exception {
        Page data = page("/index.php/vod/type/id/" + categoryId + "/page/" + pageNumber + ".html");
        List<JSONObject> items = cards(data.doc);
        if (items.isEmpty() && pageNumber == 1) throw new IllegalStateException("帝果目录没有解析到内容");
        int total = pageCount(data.doc);
        return new JSONObject()
                .put("items", new JSONArray(items))
                .put("nextPage", pageNumber < total ? pageNumber + 1 : JSONObject.NULL);
    }

    @Override public JSONArray categories() throws Exception { return loadCategories(); }

    @Override public JSONObject home() throws Exception {
        JSONObject first = loadList(defaultCategory(), 1);
        JSONArray items = first.optJSONArray("items");
        JSONArray top = new JSONArray();
        for (int i = 0; items != null && i < items.length() && i < 5; i++) top.put(items.optJSONObject(i));
        return new JSONObject()
                .put("featured", top)
                .put("items", items)
                .put("homepageRecommend", slice(items, 0, 6))
                .put("homepageNewest", slice(items, 6, 12))
                .put("recommend", new JSONObject().put("items", items).put("nextPage", first.opt("nextPage")))
                .put("newest", new JSONObject().put("items", slice(items, 6, 12)).put("nextPage", first.opt("nextPage")));
    }

    private static JSONArray slice(JSONArray rows, int from, int to) throws Exception {
        JSONArray out = new JSONArray();
        for (int i = from; rows != null && i < rows.length() && i < to; i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row != null) out.put(row);
        }
        return out;
    }

    @Override public JSONObject category(String slug, int page) throws Exception {
        String value = slug == null ? "" : slug.trim();
        String id = defaultCategory();
        JSONArray list = loadCategories();
        for (int i = 0; i < list.length(); i++) {
            JSONObject item = list.optJSONObject(i);
            if (item != null && value.equals(item.optString("id"))) {
                id = item.optString("id");
                break;
            }
        }
        return loadList(id, Math.max(1, page));
    }

    @Override public JSONObject search(String keyword, int page) throws Exception {
        String word = keyword == null ? "" : keyword.trim();
        if (word.isEmpty()) return new JSONObject().put("items", new JSONArray()).put("nextPage", JSONObject.NULL);
        Page data = page("/index.php/vod/search.html?wd=" + enc(word) + "&page=" + Math.max(1, page));
        List<JSONObject> items = cards(data.doc);
        if (items.isEmpty()) {
            // 部分模板的搜索结果不带 video-item 类名，退化成正则扫链接
            Set<String> seen = new LinkedHashSet<>();
            for (Element link : data.doc.select("a[href]")) {
                String href = link.absUrl("href").isEmpty() ? link.attr("href") : link.absUrl("href");
                Route route = route(href);
                if (route == null || !("detail".equals(route.action) || "play".equals(route.action))) continue;
                String id = route.get("id");
                if (id.isEmpty() || !seen.add(id)) continue;
                String title = tidy(link.text());
                if (title.isEmpty() || title.length() > 60) continue;
                try {
                    items.add(new JSONObject().put("id", id).put("title", title)
                            .put("cover", "").put("description", "").put("score", "")
                            .put("episodeLabel", "").put("category", "短剧")
                            .put("tags", new JSONArray()).put("status", ""));
                } catch (Exception ignored) { }
            }
        }
        int total = pageCount(data.doc);
        return new JSONObject().put("items", new JSONArray(items))
                .put("nextPage", page < total ? page + 1 : JSONObject.NULL);
    }

    /* ---------------- 播放器参数 ---------------- */

    /** 从页面脚本里抠出 player_aaaa 这种赋值对象；括号配对要自己数，正则会被嵌套对象截断。 */
    private static JSONObject player(Document doc) {
        for (Element script : doc.select("script")) {
            String body = script.data();
            if (body == null || !body.contains("player_")) continue;
            Matcher assign = PLAYER_ASSIGN.matcher(body);
            int from = 0;
            while (assign.find(from)) {
                from = assign.end();
                int brace = body.indexOf('{', from);
                if (brace < 0) break;
                String json = objectAt(body, brace);
                if (json == null) continue;
                try {
                    JSONObject candidate = new JSONObject(json.replace("\\'", "'"));
                    if (candidate.has("id") && candidate.has("url")) return candidate;
                } catch (Exception ignored) { }
            }
        }
        return null;
    }

    private static String objectAt(String text, int start) {
        int depth = 0;
        boolean inString = false;
        boolean escaped = false;
        for (int i = start; i < text.length(); i++) {
            char c = text.charAt(i);
            if (inString) {
                if (escaped) escaped = false;
                else if (c == '\\') escaped = true;
                else if (c == '"') inString = false;
                continue;
            }
            if (c == '"') inString = true;
            else if (c == '{') depth++;
            else if (c == '}') {
                depth--;
                if (depth == 0) return text.substring(start, i + 1);
            }
        }
        return null;
    }

    private static String playPath(String key, int sid, int nid) {
        return SITE + "/index.php/vod/play/id/" + key + "/sid/" + sid + "/nid/" + nid + ".html";
    }

    /* ---------------- 详情 / 分集 ---------------- */

    private final Map<String, JSONObject> detailCache = new LinkedHashMap<String, JSONObject>(16, 0.75f, true) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, JSONObject> eldest) {
            return size() > 24;
        }
    };

    private volatile String detailId = "";
    private volatile String detailTitle = "";
    private volatile String detailCover = "";
    private volatile int detailSid = 1;
    private volatile JSONArray detailEpisodes;

    @Override public JSONObject detail(String id) throws Exception {
        final String key = digits(id);
        if (key.isEmpty()) throw new IllegalArgumentException("无效剧集");

        synchronized (detailCache) {
            JSONObject hit = detailCache.get(key);
            if (hit != null) return hit;
        }

        // 这个站的「详情页」就是第一集播放页；sid 实际可能不是 1，先从页面里拿。
        Page data = null;
        JSONObject player = null;
        Exception failure = null;
        try {
            data = page(playPath(key, 1, 1));
            player = player(data.doc);
        } catch (Exception error) {
            failure = error;
        }
        if (player != null && !key.equals(digits(player.optString("id", "")))) player = null;
        if (data == null || player == null) {
            try {
                Page fallback = page("/index.php/vod/detail/id/" + key + ".html");
                JSONObject fallbackPlayer = player(fallback.doc);
                if (player == null || (fallbackPlayer != null
                        && key.equals(digits(fallbackPlayer.optString("id", ""))))) {
                    data = fallback;
                    if (fallbackPlayer != null) player = fallbackPlayer;
                }
            } catch (Exception error) {
                if (data == null) throw failure != null ? failure : error;
            }
        }
        if (data == null) throw new IllegalStateException("帝果没有返回剧集页面");
        return parseDetail(key, data, player);
    }

    /** 纯解析：页面拿到手之后的活，便于离线回归（不需要网络）。 */
    private JSONObject parseDetail(String key, Page data, JSONObject player) throws Exception {
        Document doc = data.doc;
        JSONObject vodData = player == null ? null : player.optJSONObject("vod_data");

        String title = vodData == null ? "" : clean(vodData.optString("vod_name", ""));
        if (title.isEmpty()) {
            Element heading = doc.selectFirst("div.video-info h1");
            if (heading == null) heading = doc.selectFirst("h1");
            title = heading == null ? "" : clean(heading.text());
        }
        if (title.isEmpty()) title = meta(doc, "og:title");
        title = tidy(title);

        String cover = player == null ? "" : player.optString("poster", "").trim();
        if (cover.isEmpty()) cover = meta(doc, "og:image");
        if (cover.isEmpty()) cover = coverOf(doc);
        if (cover.isEmpty()) cover = rememberedCover(key);
        cover = Net.absolute(data.url, cover);

        // 分集：同一个播放页里所有 /vod/play/id/{key}/sid/../nid/.. 链接；
        // 多线路时只保留集数最多的那条（否则 nid 会重号覆盖）。
        Map<Integer, Map<Integer, String>> byLine = new LinkedHashMap<>();
        Map<Integer, Map<Integer, String>> labels = new LinkedHashMap<>();
        for (Element link : doc.select("a[href]")) {
            String href = link.absUrl("href").isEmpty() ? link.attr("href") : link.absUrl("href");
            Route route = route(href);
            if (route == null || !"play".equals(route.action)) continue;
            if (!key.equals(digits(route.get("id")))) continue;
            int sid = route.intOf("sid");
            int nid = route.intOf("nid");
            if (sid <= 0 || nid <= 0) continue;
            Map<Integer, String> line = byLine.get(sid);
            if (line == null) {
                line = new LinkedHashMap<>();
                byLine.put(sid, line);
                labels.put(sid, new LinkedHashMap<Integer, String>());
            }
            if (!line.containsKey(nid)) {
                line.put(nid, href);
                labels.get(sid).put(nid, clean(link.text()));
            }
        }

        int bestSid = 0;
        int bestCount = 0;
        for (Map.Entry<Integer, Map<Integer, String>> entry : byLine.entrySet()) {
            if (entry.getValue().size() > bestCount) {
                bestCount = entry.getValue().size();
                bestSid = entry.getKey();
            }
        }
        /*
         * 这站是「一片一 id」：列表里每条的链接都是 sid/1/nid/1.html，播放页正文又由 JS 注入，
         * 服务端 HTML 里根本不会出现分集列表。所以「扫不到分集」是常态，不是错误 ——
         * 直接当单集正片处理，媒体地址由 episode() 用封面反推。
         */
        if (bestSid == 0) {
            int sid = player == null ? 1 : Math.max(1, player.optInt("sid", 1));
            int nid = player == null ? 1 : Math.max(1, player.optInt("nid", 1));
            bestSid = sid;
            Map<Integer, String> single = new LinkedHashMap<>();
            single.put(nid, data.url);
            byLine.put(sid, single);
            Map<Integer, String> label = new LinkedHashMap<>();
            label.put(nid, "");
            labels.put(sid, label);
            bestCount = 1;
        }
        if (bestCount == 0) throw new IllegalStateException("帝果详情页没有解析到分集");

        JSONArray listed = new JSONArray();
        JSONArray episodes = new JSONArray();
        Map<Integer, String> line = byLine.get(bestSid);
        Map<Integer, String> label = labels.get(bestSid);
        for (Map.Entry<Integer, String> entry : line.entrySet()) {
            int nid = entry.getKey();
            String text = label.get(nid);
            if (text == null || text.isEmpty()) text = line.size() == 1 ? "正片" : "第 " + nid + " 集";
            try {
                listed.put(new JSONObject()
                        .put("number", nid)
                        .put("url", playPath(key, bestSid, nid)));
                episodes.put(new JSONObject()
                        .put("number", nid)
                        .put("sid", bestSid)
                        .put("title", text));
            } catch (Exception ignored) { }
        }

        detailId = key;
        detailTitle = title.isEmpty() ? "帝果 " + key : title;
        detailCover = cover;
        detailSid = bestSid;
        detailEpisodes = episodes;

        String description = vodData == null ? "" : clean(vodData.optString("vod_blurb", ""));
        if (description.isEmpty()) description = meta(doc, "og:description");

        JSONObject result = new JSONObject()
                .put("id", key)
                .put("title", detailTitle.length() > 200 ? detailTitle.substring(0, 200) : detailTitle)
                .put("cover", cover)
                .put("description", description)
                .put("score", "")
                .put("tags", new JSONArray())
                .put("episodeLabel", "共 " + listed.length() + " 集")
                .put("episodes", listed);

        synchronized (detailCache) {
            detailCache.put(key, result);
        }
        return result;
    }

    private static String meta(Document doc, String name) {
        Element element = doc.selectFirst("meta[property=" + name + "]");
        if (element == null) element = doc.selectFirst("meta[name=" + name + "]");
        return element == null ? "" : clean(element.attr("content"));
    }

    @Override public JSONObject episode(String id, int number) throws Exception {
        final String key = digits(id);
        if (key.isEmpty()) throw new IllegalArgumentException("无效剧集");
        if (!key.equals(detailId) || detailEpisodes == null) detail(key);
        JSONArray episodes = detailEpisodes;
        if (episodes == null) throw new IllegalStateException("帝果详情已过期，请重新进入");

        int sid = detailSid;
        boolean found = false;
        for (int i = 0; i < episodes.length(); i++) {
            JSONObject item = episodes.optJSONObject(i);
            if (item == null || item.optInt("number") != number) continue;
            sid = item.optInt("sid", sid);
            found = true;
            break;
        }
        if (!found) throw new IllegalStateException("帝果没有第 " + number + " 集");

        String pageUrl = playPath(key, sid, number);
        Page data = page(pageUrl);
        JSONObject player = player(data.doc);
        if (player != null && !key.equals(digits(player.optString("id", "")))) player = null;

        int trysee = player == null ? 0 : player.optInt("trysee", 0);
        if (trysee > 0) throw new IllegalStateException("帝果这一集只能试看，暂未取得正片地址");

        String media = "";
        if (player != null) {
            media = player.optString("url", "").trim();
            String encrypt = player.optString("encrypt", "0");
            if ("1".equals(encrypt)) media = decode(media);
            else if ("2".equals(encrypt)) media = decode(new String(Crypt.unb64(media), java.nio.charset.StandardCharsets.UTF_8));
            media = Net.absolute(pageUrl, media);
        }
        /*
         * 服务端 HTML 里没有 player_aaaa 是常态（正文由 JS 注入），
         * 这时用封面反推 /1000k/index.m3u8 —— 参考实现也是这么做的。
         */
        if (media.isEmpty()) {
            media = mediaFromCover(detailCover);
            if (media.isEmpty()) {
                String cover = meta(data.doc, "og:image");
                if (cover.isEmpty()) cover = coverOf(data.doc);
                media = mediaFromCover(Net.absolute(data.url, cover));
            }
        }
        if (media.isEmpty()) throw new IllegalStateException("帝果这一集没有可直接播放的地址");
        if (!media.matches("(?i)^https?://.*\\.(m3u8|mp4)(\\?.*)?$")) {
            throw new IllegalStateException("帝果这一集不是可直接播放的媒体");
        }

        String referer = SITE + "/";
        String signed = sign(media, pageUrl);
        if (!signed.equals(media)) {
            media = signed;
            referer = SITE + "/addons/vplayer/";
        }

        return new JSONObject()
                .put("url", media)
                .put("referer", referer)
                .put("title", detailTitle)
                .put("cover", detailCover);
    }

    /* ---------------- vplayer 签名 ---------------- */

    private String sign(String address, String pageUrl) {
        if (address.contains("sign=")) return address;
        try {
            String path = mediaPath(address);
            String endpoint = SITE + "/addons/vplayer/?url=" + enc(path) + "&jump=";
            Net.Res res = Net.get(endpoint, Net.headers(
                    "User-Agent", UA,
                    "Referer", pageUrl,
                    "Accept", "text/html,application/xhtml+xml"), 10000, 2L << 20);
            if (res.status < 200 || res.status >= 300) return address;
            String signed = signedPath(res.text());
            if (signed.isEmpty()) return address;
            String resolved = Net.absolute(SITE + "/addons/vplayer/", signed);
            return resolved.matches("(?i)^https?://.*\\.(m3u8|mp4)(\\?.*)?$") ? resolved : address;
        } catch (Exception error) {
            return address;
        }
    }

    private static String mediaPath(String address) {
        try {
            java.net.URL url = new java.net.URL(address);
            String path = url.getPath() == null || url.getPath().isEmpty() ? "/" : url.getPath();
            String query = url.getQuery();
            return query == null || query.isEmpty() ? path : path + "?" + query;
        } catch (Exception error) {
            return address;
        }
    }

    /** vplayer 返回一段 aaencode 混淆脚本，里面 var vPath = "…" 才是签名后的路径。 */
    private static String signedPath(String body) {
        Matcher script = Pattern.compile("(?is)<script\\b[^>]*>(.*?)</script>").matcher(body);
        while (script.find()) {
            String block = script.group(1);
            if (!block.contains("(ﾟДﾟ)")) continue;
            String decoded = aaDecode(block);
            if (decoded == null) continue;
            Matcher path = Pattern.compile("\\bvar\\s+vPath\\s*=\\s*[\"']([^\"']+)[\"']").matcher(decoded);
            if (path.find()) return path.group(1).trim();
        }
        return "";
    }

    /**
     * aaencode 三个锚点都写成正则：各站压缩后的空格位置不一致，
     * 按常量字符串找会整段漏掉，签名就悄悄失效。
     */
    private static final Pattern AA_HEAD = Pattern.compile(
            "\\(ﾟДﾟ\\)\\s*\\['_'\\]\\s*\\(\\s*\\(ﾟДﾟ\\)\\s*\\['_'\\]");
    private static final Pattern AA_TAIL = Pattern.compile("\\+\\s*\\(ﾟДﾟ\\)\\s*\\[\\s*ﾟoﾟ\\s*\\]");
    private static final Pattern AA_SPLIT = Pattern.compile("\\(ﾟДﾟ\\)\\s*\\[\\s*ﾟεﾟ\\s*\\]\\+");

    private static String aaDecode(String raw) {
        try {
            Matcher head = AA_HEAD.matcher(raw);
            if (!head.find()) return null;
            String body = raw.substring(head.start());
            Matcher tail = AA_TAIL.matcher(body);
            int end = -1;
            while (tail.find()) end = tail.start();
            if (end < 0) return null;
            String[] tokens = AA_SPLIT.split(body.substring(0, end), -1);
            StringBuilder decoded = new StringBuilder();
            for (int i = 1; i < tokens.length; i++) {
                StringBuilder value = new StringBuilder();
                for (String part : splitTop(tokens[i])) {
                    String digit = aaDigit(part);
                    if (digit == null) return null;
                    value.append(digit);
                }
                String digits = value.toString();
                if (digits.startsWith("u") && digits.length() == 5) {
                    decoded.append((char) Integer.parseInt(digits.substring(1), 16));
                } else if (!digits.isEmpty() && digits.matches("[0-7]+")) {
                    decoded.append((char) Integer.parseInt(digits, 8));
                }
                if (decoded.length() > 65536) return null;
            }
            return decoded.toString();
        } catch (Exception error) {
            return null;
        }
    }

    private static List<String> splitTop(String value) {
        List<String> parts = new ArrayList<>();
        int depth = 0;
        int start = 0;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '(') depth++;
            else if (c == ')') {
                if (depth > 0) depth--;
            } else if (c == '+' && depth == 0) {
                String part = value.substring(start, i).trim();
                if (!part.isEmpty()) parts.add(part);
                start = i + 1;
            }
        }
        String tail = value.substring(start).trim();
        if (!tail.isEmpty()) parts.add(tail);
        return parts;
    }

    private static String aaDigit(String part) {
        String value = part == null ? "" : part.trim();
        if (value.isEmpty()) return null;
        if (value.contains("(oﾟｰﾟo)")) return "u";
        if (value.contains("(ﾟДﾟ).ﾟΘﾟﾉ")) return "b";
        value = value.replace("(c^_^o)", "0")
                .replace("(ﾟΘﾟ)", "1")
                .replace("(o^_^o)", "3")
                .replace("(ﾟｰﾟ)", "4");
        Integer number = evalInt(value);
        return number == null ? null : String.valueOf(number);
    }

    private static Integer evalInt(String text) {
        int[] pos = {0};
        try {
            int value = expr(text, pos);
            skipSpace(text, pos);
            return pos[0] == text.length() ? value : null;
        } catch (RuntimeException error) {
            return null;
        }
    }

    private static void skipSpace(String text, int[] pos) {
        while (pos[0] < text.length() && Character.isWhitespace(text.charAt(pos[0]))) pos[0]++;
    }

    private static int expr(String text, int[] pos) {
        int value = term(text, pos);
        while (true) {
            skipSpace(text, pos);
            if (pos[0] >= text.length()) return value;
            char op = text.charAt(pos[0]);
            if (op != '+' && op != '-') return value;
            pos[0]++;
            int right = term(text, pos);
            value = op == '+' ? value + right : value - right;
        }
    }

    private static int term(String text, int[] pos) {
        int value = factor(text, pos);
        while (true) {
            skipSpace(text, pos);
            if (pos[0] >= text.length()) return value;
            char op = text.charAt(pos[0]);
            if (op != '*' && op != '/' && op != '%') return value;
            pos[0]++;
            int right = factor(text, pos);
            if (right == 0 && op != '*') throw new ArithmeticException("div0");
            value = op == '*' ? value * right : op == '/' ? value / right : value % right;
        }
    }

    private static int factor(String text, int[] pos) {
        skipSpace(text, pos);
        if (pos[0] >= text.length()) throw new IllegalArgumentException("eof");
        char c = text.charAt(pos[0]);
        if (c == '(') {
            pos[0]++;
            int value = expr(text, pos);
            skipSpace(text, pos);
            if (pos[0] >= text.length() || text.charAt(pos[0]) != ')') throw new IllegalArgumentException(")");
            pos[0]++;
            return value;
        }
        if (c == '-') {
            pos[0]++;
            return -factor(text, pos);
        }
        if (!Character.isDigit(c)) throw new IllegalArgumentException("digit");
        int start = pos[0];
        while (pos[0] < text.length() && Character.isDigit(text.charAt(pos[0]))) pos[0]++;
        return Integer.parseInt(text.substring(start, pos[0]));
    }

    private static String decode(String value) {
        try {
            return java.net.URLDecoder.decode(value, "UTF-8");
        } catch (Exception error) {
            return value;
        }
    }

    private static String enc(String value) {
        try {
            return java.net.URLEncoder.encode(value == null ? "" : value, "UTF-8");
        } catch (Exception error) {
            return value;
        }
    }
}
