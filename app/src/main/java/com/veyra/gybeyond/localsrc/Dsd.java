package com.veyra.gybeyond.localsrc;

import org.json.JSONArray;
import org.json.JSONObject;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.jsoup.select.Elements;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 帝果（server/sources/dsd.js 的端侧版）：苹果 CMS 模板站，接口就是 HTML。
 *
 * 这个站按出口 IP 拦机房，后端在国内云上直接超时；手机出口正常，
 * 所以解析挪到端上反而是「修好」它，而不是降级。
 */
public final class Dsd implements LocalSource {

    private static final String SITE = "https://www.dsd.com.se";
    private static final String UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

    /** /vod/{play|detail|type|show|search}/id/{id}[/sid/{sid}][/nid/{nid}] */
    private static final Pattern VOD = Pattern.compile(
            "/vod/(play|detail|type|show|search)/id/(\\d+)(?:/sid/(\\d+))?(?:/nid/(\\d+))?");

    private static final Pattern PLAY_PAGE = Pattern.compile(
            "/vod/play/id/(\\d+)/sid/(\\d+)/nid/(\\d+)");

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
                    "Accept-Language", "zh-CN,zh;q=0.9"), 10000, 6L << 20);
        } catch (Exception error) {
            throw new IllegalStateException("帝果连不上（" + error.getMessage() + "）", error);
        }
        if (res.status < 200 || res.status >= 300) throw new IllegalStateException("帝果返回 " + res.status);
        String html = res.text();
        if (!html.matches("(?is).*<\\s*(html|body|div|a)\\b.*")) throw new IllegalStateException("帝果返回的不是页面");
        return new Page(url, Jsoup.parse(html, url));
    }

    /* ---------------- 解析 ---------------- */

    private static String clean(String value) {
        return value == null ? "" : value.replaceAll("\\s+", " ").trim();
    }

    private static String coverOf(Document doc) {
        Element image = doc.selectFirst("meta[property=og:image]");
        if (image != null && !image.attr("content").trim().isEmpty()) return image.attr("content").trim();
        Element img = doc.selectFirst("img");
        if (img != null) {
            for (String key : new String[]{"data-src", "data-original", "data-echo", "src"}) {
                String value = img.attr(key).trim();
                if (!value.isEmpty() && !value.startsWith("data:")) return img.absUrl(key).isEmpty() ? value : img.absUrl(key);
            }
        }
        return "";
    }

    private static String cardCover(Element link) {
        Element img = link.selectFirst("img");
        if (img != null) {
            for (String key : new String[]{"data-src", "data-original", "data-echo", "src"}) {
                String value = img.attr(key).trim();
                if (value.isEmpty() || value.startsWith("data:")) continue;
                String absolute = img.absUrl(key);
                return absolute.isEmpty() ? value : absolute;
            }
        }
        String style = link.attr("style");
        if (!style.isEmpty()) {
            Matcher hit = Pattern.compile("url\\(\\s*[\"']?([^\"')]+)").matcher(style);
            if (hit.find()) return hit.group(1);
        }
        return "";
    }

    private List<JSONObject> cards(Document doc) {
        List<JSONObject> items = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (Element link : doc.select("a.video-item, a.video-surface")) {
            String href = link.absUrl("href");
            if (href.isEmpty()) href = link.attr("href");
            Matcher match = VOD.matcher(href);
            if (!match.find() || !match.group(1).matches("play|detail")) continue;
            String id = match.group(2);
            if (seen.contains(id)) continue;
            String title = clean(link.text()).replaceAll("^(VIP|会员|独播|新剧)\\s*", "");
            if (title.isEmpty()) title = clean(link.attr("title"));
            if (title.isEmpty()) continue;
            seen.add(id);
            Matcher episodes = Pattern.compile("(\\d+)\\s*集").matcher(clean(link.text()));
            int total = episodes.find() ? Integer.parseInt(episodes.group(1)) : 0;
            try {
                items.add(new JSONObject()
                        .put("id", id)
                        .put("title", title.length() > 200 ? title.substring(0, 200) : title)
                        .put("cover", cardCover(link))
                        .put("description", "")
                        .put("score", "")
                        .put("episodeLabel", total > 0 ? "全 " + total + " 集" : "")
                        .put("category", "短剧")
                        .put("tags", new JSONArray())
                        .put("status", total > 0 ? "finished" : ""));
            } catch (Exception ignored) { }
        }
        return items;
    }

    private JSONArray categoriesOf(Document doc) {
        JSONArray list = new JSONArray();
        try {
            list.put(new JSONObject().put("id", "").put("name", "全部"));
        } catch (Exception ignored) { }
        Set<String> seen = new LinkedHashSet<>();
        seen.add("");
        for (Element link : doc.select("a[href]")) {
            String href = link.absUrl("href");
            if (href.isEmpty()) href = link.attr("href");
            Matcher match = Pattern.compile("/vod/type/id/(\\d+)").matcher(href);
            String name = clean(link.text());
            if (!match.find() || name.isEmpty() || name.length() > 12) continue;
            String id = match.group(1);
            if (seen.contains(id)) continue;
            seen.add(id);
            try {
                list.put(new JSONObject().put("id", id).put("name", name));
            } catch (Exception ignored) { }
            if (list.length() >= 20) break;
        }
        return list;
    }

    private static int pageCount(Document doc) {
        int max = 1;
        for (Element link : doc.select("a[href]")) {
            String href = link.absUrl("href");
            if (href.isEmpty()) href = link.attr("href");
            Matcher match = Pattern.compile("/page/(\\d+)").matcher(href);
            if (match.find()) {
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
        if (list.length() <= 1) throw new IllegalStateException("帝果没有返回分类");
        categoriesCache = list;
        categoriesAt = now;
        return list;
    }

    private JSONObject loadList(String path, int pageNumber) throws Exception {
        Page data = page(path.replace("{page}", String.valueOf(pageNumber)));
        List<JSONObject> items = cards(data.doc);
        if (items.isEmpty() && pageNumber == 1) throw new IllegalStateException("帝果目录没有解析到内容");
        int total = pageCount(data.doc);
        return new JSONObject()
                .put("items", new JSONArray(items))
                .put("nextPage", pageNumber < total ? pageNumber + 1 : JSONObject.NULL);
    }

    @Override public JSONArray categories() throws Exception { return loadCategories(); }

    @Override public JSONObject home() throws Exception {
        JSONObject first;
        try {
            first = loadList("/index.php/vod/show/id/1.html", 1);
        } catch (Exception error) {
            if (error.getMessage() != null && error.getMessage().contains("连不上")) throw error;
            Page data = page("/");
            first = new JSONObject().put("items", new JSONArray(cards(data.doc))).put("nextPage", JSONObject.NULL);
        }
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
        JSONArray list = loadCategories();
        String id = "";
        for (int i = 0; i < list.length(); i++) {
            JSONObject item = list.optJSONObject(i);
            if (item != null && value.equals(item.optString("id"))) id = item.optString("id");
        }
        if (id.isEmpty()) return loadList("/index.php/vod/show/id/1.html", page);
        return loadList("/index.php/vod/type/id/" + id + ".html", page);
    }

    @Override public JSONObject search(String keyword, int page) throws Exception {
        String word = keyword == null ? "" : keyword.trim();
        if (word.isEmpty()) return new JSONObject().put("items", new JSONArray()).put("nextPage", JSONObject.NULL);
        Page data = page("/index.php/vod/search.html?wd=" + enc(word) + "&page=" + page);
        List<JSONObject> items = cards(data.doc);
        if (items.isEmpty()) {
            // 部分模板的搜索结果不带 video-item 类名，退化成正则扫链接
            Set<String> seen = new LinkedHashSet<>();
            for (Element link : data.doc.select("a[href]")) {
                String href = link.absUrl("href");
                if (href.isEmpty()) href = link.attr("href");
                Matcher match = Pattern.compile("/vod/(?:detail|play)/id/(\\d+)").matcher(href);
                if (!match.find() || seen.contains(match.group(1))) continue;
                String title = clean(link.text());
                if (title.isEmpty() || title.length() > 60) continue;
                seen.add(match.group(1));
                try {
                    items.add(new JSONObject().put("id", match.group(1)).put("title", title)
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

    /* ---------------- 详情 / 播放 ---------------- */

    private volatile String detailId = "";
    private volatile String detailTitle = "";
    private volatile String detailCover = "";
    private volatile String detailSid = "1";

    @Override public JSONObject detail(String id) throws Exception {
        final String key = id == null ? "" : id.replaceAll("\\D", "");
        if (key.isEmpty()) throw new IllegalArgumentException("无效剧集");
        Page data = page("/index.php/vod/detail/id/" + key + ".html");
        Document doc = data.doc;

        String title = meta(doc, "og:title");
        if (title.isEmpty()) title = meta(doc, "title");
        if (title.isEmpty()) {
            Element h1 = doc.selectFirst("h1");
            title = h1 == null ? "" : clean(h1.text());
        }
        String cover = meta(doc, "og:image");
        if (cover.isEmpty()) cover = coverOf(doc);

        Set<Integer> seen = new LinkedHashSet<>();
        List<JSONObject> episodes = new ArrayList<>();
        for (Element link : doc.select("a[href]")) {
            String href = link.absUrl("href");
            if (href.isEmpty()) href = link.attr("href");
            Matcher match = PLAY_PAGE.matcher(href);
            if (!match.find() || !key.equals(match.group(1))) continue;
            int number = Integer.parseInt(match.group(3));
            if (number <= 0 || seen.contains(number)) continue;
            seen.add(number);
            String label = clean(link.text());
            episodes.add(new JSONObject()
                    .put("number", number)
                    .put("sid", Integer.parseInt(match.group(2)))
                    .put("title", label.isEmpty() ? "第 " + number + " 集" : label));
        }
        episodes.sort((a, b) -> a.optInt("number") - b.optInt("number"));
        if (episodes.isEmpty()) throw new IllegalStateException("帝果详情页没有解析到分集");

        JSONArray listed = new JSONArray();
        for (JSONObject item : episodes) {
            listed.put(new JSONObject().put("number", item.optInt("number"))
                    .put("url", SITE + "/index.php/vod/play/id/" + key + "/sid/" + item.optInt("sid")
                            + "/nid/" + item.optInt("number") + ".html"));
        }
        detailId = key;
        detailTitle = title.isEmpty() ? "帝果 " + key : title;
        detailCover = cover;
        detailSid = String.valueOf(episodes.get(0).optInt("sid"));
        detailEpisodes = new JSONArray(episodes);

        return new JSONObject()
                .put("id", key)
                .put("title", detailTitle.length() > 200 ? detailTitle.substring(0, 200) : detailTitle)
                .put("cover", cover)
                .put("description", meta(doc, "og:description"))
                .put("score", "")
                .put("tags", new JSONArray())
                .put("episodeLabel", "共 " + episodes.size() + " 集")
                .put("episodes", listed);
    }

    private volatile JSONArray detailEpisodes;

    private static String meta(Document doc, String name) {
        Element element = doc.selectFirst("meta[property=" + name + "]");
        if (element == null) element = doc.selectFirst("meta[name=" + name + "]");
        return element == null ? "" : clean(element.attr("content"));
    }

    @Override public JSONObject episode(String id, int number) throws Exception {
        final String key = id == null ? "" : id.replaceAll("\\D", "");
        if (!key.equals(detailId) || detailEpisodes == null) detail(key);
        String sid = detailSid;
        for (int i = 0; i < detailEpisodes.length(); i++) {
            JSONObject item = detailEpisodes.optJSONObject(i);
            if (item != null && item.optInt("number") == number) sid = String.valueOf(item.optInt("sid"));
        }
        String pageUrl = SITE + "/index.php/vod/play/id/" + key + "/sid/" + sid + "/nid/" + number + ".html";
        Page data = page(pageUrl);
        String html = data.doc.outerHtml();
        Matcher script = Pattern.compile("player_aaaa\\s*=\\s*(\\{[\\s\\S]*?\\})\\s*[;<\\n]").matcher(html);
        String media = "";
        if (script.find()) {
            String json = script.group(1).replace("\\'", "'");
            JSONObject player = new JSONObject(json);
            media = player.optString("url", "");
            String encrypt = player.optString("encrypt", "0");
            if ("1".equals(encrypt)) media = decode(media);
            else if ("2".equals(encrypt)) media = decode(new String(Crypt.unb64(media), java.nio.charset.StandardCharsets.UTF_8));
        } else {
            Matcher simple = Pattern.compile("\"url\"\\s*:\\s*\"([^\"]+)\"").matcher(html);
            if (simple.find()) media = simple.group(1).replace("\\/", "/");
        }
        media = Net.absolute(pageUrl, media);
        if (media.isEmpty()) throw new IllegalStateException("帝果这一集没有可直接播放的地址");
        return new JSONObject()
                .put("url", media)
                .put("referer", SITE + "/")
                .put("title", detailTitle)
                .put("cover", detailCover);
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
