package com.veyra.gybeyond;

import android.content.Context;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.jsoup.parser.Parser;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

final class SiteRepository {
    private final SiteProfile profile;
    private final File coverDir;
    private final Context appContext;
    private final String proxyAddress;   // 黄果代理 "host:port"，未设置为空串
    // 通道模式每次请求实时读取 ProxySettings.mode()（切换下拉立即生效，无需重建）：
    // 仅直连/仅代理 = 只用该通道，失败即报错；走后端 = 全部经后端转发。红果不走本类。
    private static final int CHANNEL_TIMEOUT_MS = 5_000;   // 直连/代理通道超时
    private static final int BACKEND_READ_TIMEOUT_MS = 12_000;
    private final okhttp3.OkHttpClient backendClient;
    /**
     * 直连/代理通道里 301 最终落到的域名，由 page() 确认页面有效后才采用。
     * 用 ThreadLocal：首页会并行抓多个分类，共用一个字段会串台。
     */
    private final ThreadLocal<String> landedOrigin = new ThreadLocal<>();

    SiteRepository(Context context) { this(context, HotUpdateManager.get(context).currentSite()); }

    SiteRepository(Context context, SiteProfile profile) {
        this.profile = profile;
        appContext = context.getApplicationContext();
        coverDir = new File(context.getCacheDir(), "covers");
        if (!coverDir.exists()) coverDir.mkdirs();
        proxyAddress = ProxySettings.address(appContext);
        backendClient = new okhttp3.OkHttpClient.Builder()
                .connectTimeout(8, java.util.concurrent.TimeUnit.SECONDS)
                .readTimeout(BACKEND_READ_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
                .callTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
                .build();
    }

    private static Proxy proxy(String address) {
        String[] parts = address.split(":");
        String host = parts.length > 0 && !parts[0].isEmpty() ? parts[0] : "127.0.0.1";
        int port = 80;
        if (parts.length > 1) try { port = Integer.parseInt(parts[1]); } catch (NumberFormatException ignored) { }
        return new Proxy(Proxy.Type.HTTP, new InetSocketAddress(host, port));
    }

    /**
     * 通道抓取（仅黄果源；红果不走此通道）。模式每次实时读取，切换立即生效：
     *   走后端 → 全部经后端转发；仅直连/仅代理 → 只用该通道，失败即报错。无自动判定。
     */
    private byte[] fetch(String url) throws Exception {
        int mode = ProxySettings.mode(appContext);
        if (mode == ProxySettings.MODE_BACKEND) return fetchViaBackend(url);
        if (mode == ProxySettings.MODE_DIRECT) return fetchDirect(url);
        if (proxyAddress.isEmpty()) throw new IOException("未配置代理地址");
        return fetchViaProxy(url);
    }

    /** 直连通道：系统默认网络栈（VPN/全局代理自然生效），4s 判定超时。 */
    private byte[] fetchDirect(String url) throws Exception {
        return openAndRead(url, null, CHANNEL_TIMEOUT_MS);
    }

    /** 代理通道：走设置里配置的代理地址。 */
    private byte[] fetchViaProxy(String url) throws Exception {
        if (proxyAddress.isEmpty()) throw new IOException("未配置代理地址");
        return openAndRead(url, proxy(proxyAddress), CHANNEL_TIMEOUT_MS);
    }

    private byte[] openAndRead(String url, Proxy proxy, int timeout) throws Exception {
        URL parsed;
        try {
            parsed = new URL(url);
        } catch (Exception error) {
            throw new IOException("站点地址配置无效（" + url + "）：请检查站点配置或稍后重试", error);
        }
        if (!"https".equals(parsed.getProtocol())) throw new IllegalArgumentException("仅支持 HTTPS");
        final HttpURLConnection connection = proxy == null
                ? (HttpURLConnection) parsed.openConnection()
                : (HttpURLConnection) parsed.openConnection(proxy);
        connection.setConnectTimeout(timeout);
        connection.setReadTimeout(timeout);
        JSONObject headers = profile.object("headers");
        for (java.util.Iterator<String> keys = headers.keys(); keys.hasNext();) {
            String key = keys.next();
            connection.setRequestProperty(key, headers.getString(key).replace("{origin}", profile.origin()));
        }
        connection.setUseCaches(false);
        try {
            int status = connection.getResponseCode();
            // 跟随重定向后 connection 指向最终地址；黄果换域名靠这个跟上
            URL landed = connection.getURL();
            if (landed != null && landed.getHost() != null)
                landedOrigin.set(landed.getProtocol() + "://" + landed.getHost());
            if (status < 200 || status >= 300) throw new IllegalStateException("站点请求失败（" + status + "）");
            try (InputStream stream = connection.getInputStream(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int count;
                while ((count = stream.read(buffer)) != -1) bytes.write(buffer, 0, count);
                return bytes.toByteArray();
            }
        } catch (IOException error) {
            throw new IOException("站点连接失败", error);
        } finally {
            connection.disconnect();
        }
    }

    /** 后端通道：经自建后端 /api/huangguo-proxy 转发（后端侧可配代理；白名单限黄果域名；m3u8 分片自动重写）。 */
    private byte[] fetchViaBackend(String url) throws Exception {
        String base = ServerConfig.get(appContext);
        if (base.isEmpty()) throw new IOException("未配置后端地址，无法走后端转发");
        String endpoint = base + "api/huangguo-proxy?url=" + java.net.URLEncoder.encode(url, "UTF-8");
        okhttp3.Request request = new okhttp3.Request.Builder().url(endpoint).build();
        try (okhttp3.Response response = backendClient.newCall(request).execute()) {
            if (!response.isSuccessful() || response.body() == null)
                throw new IOException("后端转发失败（HTTP " + response.code() + "）");
            return response.body().bytes();
        } catch (IOException error) {
            throw new IOException("后端转发连接失败", error);
        }
    }

    /**
     * 播放/选集 URL 通道化：走后端模式时改写为后端代理地址（m3u8 及其分片由后端重写兜底）。
     * 仅直连/仅代理模式保持原 URL（播放器走系统网络栈/代理软件）。
     */
    private String channelizedUrl(String raw) throws Exception {
        if (ProxySettings.mode(appContext) == ProxySettings.MODE_BACKEND) {
            String base = ServerConfig.get(appContext);
            if (!base.isEmpty()) return base + "api/huangguo-proxy?url=" + java.net.URLEncoder.encode(raw, "UTF-8");
        }
        return raw;
    }

    /**
     * 抓取页面（仅黄果；红果不走此方法）。模式每次实时读取：
     *   仅直连/自动 → 先走系统网络栈；仅直连失败即报错，自动失败后按 代理→后端 兜底；
     *   仅代理 → 只用配置代理，失败即报错；走后端 → 直接后端多源循环（互相兜底）。
     */
    /**
     * 抓取页面（仅黄果；红果不走此方法）。模式每次实时读取，无自动判定：
     *   仅直连 → 直连失败即报错；仅代理 → 代理失败即报错；走后端 → 后端多源循环（互相兜底）。
     */
    private Document page(String path) throws Exception {
        if (!path.startsWith("/") || path.startsWith("//")) throw new IllegalArgumentException("无效路径");
        landedOrigin.remove();
        int mode = ProxySettings.mode(appContext);
        if (mode == ProxySettings.MODE_DIRECT) {
            return parse(fetchDirect(profile.origin() + path));
        }
        if (mode == ProxySettings.MODE_PROXY) {
            if (proxyAddress.isEmpty()) throw new IOException("未配置代理地址");
            return parse(fetchViaProxy(profile.origin() + path));
        }
        for (int attempt = 0; attempt < profile.sourceCount(); attempt++) {
            try {
                return parse(fetchViaBackend(profile.origin() + path));
            } catch (Exception error) {
                if (attempt + 1 < profile.sourceCount() && profile.switchSource()) continue; // 换备用源
                throw error;
            }
        }
        throw new IllegalStateException("所有通道与站点源均不可用");
    }

    /**
     * 页面拿到并解析成功，才认 301 落到的域名。
     * 顺序很关键：先确认抓回来的是真页面，再改 origin，
     * 否则一个鉴权跳转就能把站点地址带偏，而站点地址是持久化的。
     */
    private Document parse(byte[] body) throws Exception {
        if (body.length < 1000) throw new IllegalStateException("站点暂时返回空页面");
        Document document = Jsoup.parse(new String(body, StandardCharsets.UTF_8), profile.origin());
        String landed = landedOrigin.get();
        landedOrigin.remove();
        if (landed != null) profile.adoptOrigin(landed);
        return document;
    }

    private static String text(Element element) {
        return element == null ? "" : element.text().replaceAll("\\s+", " ").trim();
    }

    private static String attr(Element element, String name) {
        return element == null ? "" : element.attr(name);
    }

    private String cover(Element card) {
        Element image = card.selectFirst(profile.selector("cover"));
        String value = attr(image, profile.attribute("cover"));
        return value.isEmpty() ? attr(image, profile.attribute("coverFallback")) : value;
    }

    private JSONArray cards(Element document, String category) throws Exception {
        JSONArray items = new JSONArray();
        Set<String> ids = new HashSet<>();
        for (Element card : document.select(profile.selector("cards"))) {
            String id = card.attr(profile.attribute("id"));
            if (!id.matches("\\d+") || !ids.add(id)) continue;
            Element titleNode = card.selectFirst(profile.selector("title"));
            if (titleNode != null) titleNode = titleNode.clone();
            if (titleNode != null) titleNode.select(profile.selector("removeTitle")).remove();
            String title = text(titleNode);
            if (title.isEmpty()) title = card.attr(profile.attribute("title"));
            if (title.isEmpty()) title = "剧集 " + id;
            JSONObject item = new JSONObject();
            item.put("id", id);
            item.put("title", title);
            item.put("cover", cover(card));
            item.put("description", text(card.selectFirst(profile.selector("description"))));
            item.put("score", text(card.selectFirst(profile.selector("score"))));
            item.put("episodeLabel", text(card.selectFirst(profile.selector("episodeLabel"))));
            String mappedCategory = category;
            if (mappedCategory.isEmpty()) {
                mappedCategory = profile.object("categoryMap").optString(card.attr(profile.attribute("type")));
            }
            if (!mappedCategory.isEmpty()) item.put("category", mappedCategory);
            JSONArray tags = new JSONArray();
            for (Element tag : card.select(profile.selector("tags"))) {
                if (tags.length() >= 3) break;
                Element clean = tag.clone();
                clean.select(profile.selector("removeTag")).remove();
                String value = text(clean);
                if (!value.isEmpty()) tags.put(value);
            }
            item.put("tags", tags);
            items.put(item);
        }
        return items;
    }

    private JSONObject listing(Document document, int currentPage, String category) throws Exception {
        JSONObject result = new JSONObject();
        result.put("items", cards(document, category));
        int next = Integer.MAX_VALUE;
        for (Element link : document.select(profile.selector("pager"))) {
            String href = link.attr("href");
            java.util.regex.Matcher match = profile.pattern("page", null).matcher(href);
            if (!match.find()) continue;
            int page = Integer.parseInt(match.group(1));
            if (page > currentPage && page < next) next = page;
        }
        result.put("nextPage", next == Integer.MAX_VALUE ? JSONObject.NULL : next);
        return result;
    }

    JSONObject home() throws Exception {
        Document root = page(profile.route("home"));
        JSONArray featured = new JSONArray();
        Element heroData = root.selectFirst(profile.selector("hero"));
        if (heroData != null) {
            try {
                JSONArray slides = new JSONArray(heroData.data().isEmpty() ? heroData.text() : heroData.data());
                for (int i = 0; i < slides.length(); i++) {
                    JSONObject slide = slides.optJSONObject(i);
                    if (slide == null) continue;
                    slide = profile.mapJson(slide, "hero");
                    if (slide.optBoolean("isAd") || slide.optInt("adId") != 0) continue;
                    String href = slide.optString("href");
                    java.util.regex.Matcher match = profile.pattern("heroId", null).matcher(profile.relative(href));
                    if (!match.find()) continue;
                    JSONObject item = new JSONObject();
                    item.put("id", match.group(1));
                    item.put("title", slide.optString("title"));
                    item.put("cover", slide.optString("cover"));
                    item.put("description", slide.optString("desc"));
                    item.put("score", slide.optString("score"));
                    item.put("episodeLabel", slide.optString("episode"));
                    featured.put(item);
                }
            } catch (Exception ignored) { /* 无轮播时展示推荐目录 */ }
        }
        JSONObject result = new JSONObject();
        result.put("featured", featured);
        result.put("items", cards(root, ""));
        for (Element section : root.select(profile.selector("sections"))) {
            String heading = text(section.selectFirst(profile.selector("sectionTitle")));
            if (profile.object("sectionNames").optString("recommend").equals(heading)) result.put("homepageRecommend", cards(section, ""));
            if (profile.object("sectionNames").optString("newest").equals(heading)) result.put("homepageNewest", cards(section, ""));
        }
        try { result.put("recommend", listing(page(profile.route("recommend")), 1, "")); }
        catch (Exception error) { result.put("recommend", new JSONObject().put("items", result.getJSONArray("items")).put("nextPage", JSONObject.NULL)); }
        try { result.put("newest", listing(page(profile.route("newest")), 1, "")); }
        catch (Exception error) { result.put("newest", new JSONObject().put("items", new JSONArray()).put("nextPage", JSONObject.NULL)); }
        if (featured.length() == 0 && result.getJSONArray("items").length() == 0) throw new IllegalStateException("首页内容暂时不可用");
        return result;
    }

    JSONObject category(String id, int pageNumber) throws Exception {
        if (!profile.categoryAllowed(id) || pageNumber < 1 || pageNumber > 100) throw new IllegalArgumentException("无效分类");
        String path = profile.route(pageNumber == 1 ? "category" : "categoryPage", "category", id, "page", String.valueOf(pageNumber));
        JSONObject result = listing(page(path), pageNumber, id);
        if (result.getJSONArray("items").length() == 0) throw new IllegalStateException("分类内容暂时不可用");
        return result;
    }

    JSONObject tags() throws Exception {
        JSONArray bundled;
        try (InputStream input = appContext.getAssets().open("tags.json"); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) bytes.write(buffer, 0, count);
            bundled = new JSONArray(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
        }
        JSONArray items = new JSONArray();
        try {
            String xml = new String(fetch(profile.origin() + profile.route("tagSitemap")), StandardCharsets.UTF_8);
            Document sitemap = Jsoup.parse(xml, "", Parser.xmlParser());
            Set<String> current = new LinkedHashSet<>();
            for (Element loc : sitemap.select("loc")) {
                java.util.regex.Matcher match = profile.pattern("tag", null).matcher(profile.relative(text(loc)));
                if (match.matches()) current.add(match.group(1));
            }
            if (!current.isEmpty()) {
                for (int i = 0; i < bundled.length(); i++) {
                    JSONObject tag = bundled.optJSONObject(i);
                    if (tag != null && current.remove(tag.optString("slug"))) items.put(tag);
                }
                for (String slug : current) {
                    String name = slug;
                    try { name = text(page(profile.route("tag", "slug", slug)).selectFirst(profile.selector("tagTitle"))).replaceFirst("短剧在线观看$", "").trim(); }
                    catch (Exception ignored) { /* 新标签暂用链接名称，仍可进入列表 */ }
                    items.put(new JSONObject().put("slug", slug).put("name", name).put("group", "other"));
                }
            }
        } catch (Exception ignored) { /* 离线时沿用内置标签 */ }
        if (items.length() == 0) items = bundled;
        return new JSONObject().put("items", items);
    }

    JSONObject tagListing(String slug, int pageNumber) throws Exception {
        if (slug == null || !slug.matches("[a-z0-9-]{1,80}") || pageNumber < 1 || pageNumber > 500) {
            throw new IllegalArgumentException("无效标签或页码");
        }
        String path = profile.route(pageNumber == 1 ? "tag" : "tagPage", "slug", slug, "page", String.valueOf(pageNumber));
        return listing(page(path), pageNumber, "");
    }

    JSONObject recommend(int pageNumber, boolean newest) throws Exception {
        if (pageNumber < 1) throw new IllegalArgumentException("无效页码");
        String name = newest ? "newest" : "recommend";
        return listing(page(profile.route(pageNumber == 1 ? name : name + "Page", "page", String.valueOf(pageNumber))), pageNumber, "");
    }

    private static final ExecutorService SEARCH_POOL = Executors.newFixedThreadPool(6);
    private static final String[] CN_NUM = {"一", "二", "三", "四", "五", "六", "七", "八", "九", "十"};

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

    /** 联想接口查询集：宽词 + 主体第 + 主体季 + 各"第N季" + 冒号"：第N季"（N=1..10）。
     *  实测单次返回不稳定（同一关键词两次子集不同）、部分查询偶发 500，且"持械入宋第三季"只返回
     *  100 集版、341 集版需"持械入宋：第三季"带冒号变体才返回——故穷举组合查询合并，三轮实测
     *  全量覆盖（143 第二季 / 100 第二季 / 341 第三季 / 214 第五季 / 138 主剧 / 宣和铁骑×2，共 15 部）。 */
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

    /** 红果联想接口（hongguoduanju.com 官方站，juku 同款）：返回以关键词开头的完整短剧名。
     *  剥离季后缀后按 suggestionQueries 穷举查询并行合并，覆盖网页搜索漏掉的全集版
     *  （341 集版第三季、100 集版第二季等）。失败由调用方兜底。 */
    private JSONArray suggestionItems(String query) throws Exception {
        return suggestionItemsFor(seasonBase(query), suggestionQueries(seasonBase(query)));
    }

    /** 联想浮层用轻量版：只查 宽词 + 主体第 + 主体季（3 个请求，快）。 */
    private JSONArray suggestionItemsLight(String query) throws Exception {
        String base = seasonBase(query);
        java.util.LinkedHashSet<String> queries = new java.util.LinkedHashSet<>();
        queries.add(base);
        if (base.length() <= 8) { queries.add(base + "第"); queries.add(base + "季"); }
        return suggestionItemsFor(base, queries);
    }

    private JSONArray suggestionItemsFor(final String base, java.util.LinkedHashSet<String> queries) throws Exception {
        java.util.LinkedHashMap<String, JSONObject> seen = new java.util.LinkedHashMap<>();
        java.util.List<Future<Void>> futures = new java.util.ArrayList<>();
        for (final String q : queries) {
            futures.add(SEARCH_POOL.submit(new Callable<Void>() {
                @Override public Void call() {
                    try {
                        String url = "https://hongguoduanju.com/incent_resource/suggestion?app_id=8662&query="
                                + java.net.URLEncoder.encode(q, StandardCharsets.UTF_8) + "&count=50";
                        byte[] body = fetch(url);
                        JSONObject json = new JSONObject(new String(body, StandardCharsets.UTF_8));
                        JSONArray list = json.optJSONArray("suggest_list");
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
                    return null;
                }
            }));
        }
        for (Future<Void> f : futures) { try { f.get(); } catch (Exception ignored) { } }
        JSONArray items = new JSONArray();
        for (JSONObject it : seen.values()) items.put(it);
        return items;
    }

    private static String normalizeTitle(String text) {
        return text.replaceAll("\\s+", "").toLowerCase(Locale.ROOT);
    }
    private static int titleRank(String title, String query) {
        String t = normalizeTitle(title), q = normalizeTitle(query);
        if (t.equals(q)) return 0;
        if (t.startsWith(q)) return 1;
        if (t.contains(q)) return 2;
        return 3;
    }

    JSONObject search(String term, boolean suggest) throws Exception {
        String query = term.trim();
        if (query.length() > 80) query = query.substring(0, 80);
        if (query.isEmpty()) return new JSONObject().put("items", new JSONArray()).put("nextPage", JSONObject.NULL);
        JSONObject result = listing(page(profile.route("search", "query", java.net.URLEncoder.encode(query, StandardCharsets.UTF_8))), 1, "");
        // 联想接口查询用剧名主体（剥离"第N季"后缀），过滤也用主体——
        // 网页/联想返回的"持械入宋：第一季"等标题不含完整查询词"持械入宋第二季"，必须放宽到主体。
        final String baseQuery = seasonBase(query);
        if (suggest) {
            // 联想浮层：优先红果联想接口（真实短剧名建议，轻量 3 查询，快），失败回退网页查询
            try {
                JSONArray suggestList = suggestionItemsLight(query);
                java.util.LinkedHashMap<String, JSONObject> filtered = new java.util.LinkedHashMap<>();
                for (int i = 0; i < suggestList.length(); i++) {
                    JSONObject it = suggestList.optJSONObject(i);
                    if (it != null && it.optString("title").contains(baseQuery)) filtered.putIfAbsent(it.optString("id"), it);
                }
                if (filtered.size() > 0) {
                    JSONArray items = new JSONArray();
                    for (JSONObject it : filtered.values()) items.put(it);
                    return new JSONObject().put("items", items).put("nextPage", JSONObject.NULL);
                }
            } catch (Exception ignored) { }
            return result;
        }
        // 搜索补全：源站网页搜索对"剧名+第/季"匹配不全（如搜"持械入宋"漏掉 341 集版第三季、100 集版第二季）。
        // 主补全走红果联想接口（双查询合并完整短剧名列表，juku 同款方案）；联想接口不可用时
        // 回退并行穷举 去尾字 / +第 / +季 / +第N季(1..8) 变体查询。按 id 合并去重后按标题匹配度排序。
        JSONArray items = result.optJSONArray("items");
        int count = items == null ? 0 : items.length();
        java.util.LinkedHashMap<String, JSONObject> seen = new java.util.LinkedHashMap<>();
        if (items != null) {
            for (int i = 0; i < items.length(); i++) {
                JSONObject it = items.optJSONObject(i);
                if (it != null) seen.putIfAbsent(it.optString("id"), it);
            }
        }
        // 三层补全（并行）：
        // 1) 网页按季穷举 base+第N季(N=1..10)：网页搜索是确定性的，实测"持械入宋第三季"必出 341 集版、
        //    "持械入宋第二季"必出 143 集版 —— 这是确保全集版出现的确定性通道；
        // 2) 联想接口组合（23 查询）：补网页搜不到的条目（138 集主剧、宣和铁骑系列等）；
        // 3) 联想接口整体不可用时回退网页变体穷举（去尾字/+第/+季）。
        java.util.List<Future<Void>> futures = new java.util.ArrayList<>();
        for (final String n : CN_NUM) {
            if (baseQuery.length() + n.length() + 3 > 12) continue;
            final String variant = baseQuery + "第" + n + "季";
            futures.add(SEARCH_POOL.submit(new Callable<Void>() {
                @Override public Void call() {
                    try {
                        JSONObject extra = listing(page(profile.route("search", "query", java.net.URLEncoder.encode(variant, StandardCharsets.UTF_8))), 1, "");
                        JSONArray extraItems = extra.optJSONArray("items");
                        synchronized (seen) {
                            for (int i = 0; extraItems != null && i < extraItems.length(); i++) {
                                JSONObject it = extraItems.optJSONObject(i);
                                if (it == null) continue;
                                if (it.optString("title").contains(baseQuery)) seen.putIfAbsent(it.optString("id"), it);
                            }
                        }
                    } catch (Exception ignored) { }
                    return null;
                }
            }));
        }
        boolean suggestionOk = false;
        try {
            JSONArray suggestList = suggestionItems(query);
            if (suggestList.length() > 0) {
                suggestionOk = true;
                for (int i = 0; i < suggestList.length(); i++) {
                    JSONObject it = suggestList.optJSONObject(i);
                    if (it != null && it.optString("title").contains(baseQuery)) seen.putIfAbsent(it.optString("id"), it);
                }
            }
        } catch (Exception ignored) { }
        if (!suggestionOk && count < 20 && query.length() > 2) {
            java.util.LinkedHashSet<String> variants = new java.util.LinkedHashSet<>();
            final String fallbackQuery = query;
            String shorter = query.substring(0, query.length() - 1).trim();
            if (shorter.length() >= 2) variants.add(shorter);
            if (query.length() <= 8) variants.add(query + "第");
            variants.add(query + "季");
            java.util.List<Future<Void>> fallbackFutures = new java.util.ArrayList<>();
            for (final String variant : variants) {
                fallbackFutures.add(SEARCH_POOL.submit(new Callable<Void>() {
                    @Override public Void call() {
                        try {
                            JSONObject extra = listing(page(profile.route("search", "query", java.net.URLEncoder.encode(variant, StandardCharsets.UTF_8))), 1, "");
                            JSONArray extraItems = extra.optJSONArray("items");
                            synchronized (seen) {
                                for (int i = 0; extraItems != null && i < extraItems.length(); i++) {
                                    JSONObject it = extraItems.optJSONObject(i);
                                    if (it == null) continue;
                                    // 只并入标题包含查询词的条目（剧名带"·/："等符号也保留），避免引入无关噪音
                                    String title = it.optString("title");
                                    if (title.contains(baseQuery)) seen.putIfAbsent(it.optString("id"), it);
                                }
                            }
                        } catch (Exception ignored) { }
                        return null;
                    }
                }));
            }
            for (Future<Void> f : fallbackFutures) { try { f.get(); } catch (Exception ignored) { } }
        }
        for (Future<Void> f : futures) { try { f.get(); } catch (Exception ignored) { } }
        if (seen.size() > count) {
            java.util.List<JSONObject> ordered = new java.util.ArrayList<>(seen.values());
            final String rankQuery = query;
            ordered.sort((a, b) -> {
                int r = Integer.compare(titleRank(a.optString("title"), rankQuery), titleRank(b.optString("title"), rankQuery));
                return r != 0 ? r : Integer.compare(a.optString("title").length(), b.optString("title").length());
            });
            JSONArray merged = new JSONArray();
            for (JSONObject it : ordered) merged.put(it);
            result.put("items", merged);
        }
        return result;
    }

    JSONObject detail(String id) throws Exception {
        if (!id.matches("\\d+")) throw new IllegalArgumentException("无效剧集");
        Document document = page(profile.route("detail", "id", id));
        Element node = document.selectFirst(profile.selector("content"));
        if (node == null) throw new IllegalStateException("未找到剧集详情");
        JSONObject data = profile.mapJson(new JSONObject(node.data().isEmpty() ? node.text() : node.data()), "content");
        if (!id.equals(String.valueOf(data.opt("id")))) throw new IllegalStateException("剧集详情不匹配");
        JSONObject result = new JSONObject();
        result.put("id", id);
        result.put("title", data.optString("title"));
        result.put("cover", data.optString("coverSrc", data.optString("posterSrc")));
        result.put("description", data.optString("description"));
        result.put("score", text(document.selectFirst(profile.selector("detailScore"))));
        JSONArray tags = new JSONArray();
        JSONArray siteTags = data.optJSONArray("tags");
        for (int i = 0; siteTags != null && i < siteTags.length(); i++) {
            if (tags.length() >= 5) break;
            String value = siteTags.optString(i).trim();
            if (!value.isEmpty()) tags.put(value);
        }
        result.put("tags", tags);
        JSONArray episodes = new JSONArray();
        Set<Integer> seenEpisodes = new HashSet<>();
        for (Element link : document.select(profile.selector("episodeLinks"))) {
            String href = link.attr("href");
            java.util.regex.Matcher match = profile.pattern("episode", id).matcher(profile.relative(href));
            if (!match.matches()) continue;
            int number = match.group(1) == null ? 1 : Integer.parseInt(match.group(1));
            if (!seenEpisodes.add(number)) continue;
            episodes.put(new JSONObject().put("number", number).put("url", channelizedUrl(profile.origin() + href)));
        }
        if (episodes.length() == 0 && node != null) {
            // AI 换脸/魔改等无选集链接的作品：videoInitialData 直接给出 epPlaySrcs（集数→m3u8），按集数生成选集
            try {
                JSONObject srcs = data.optJSONObject("epPlaySrcs");
                if (srcs != null && srcs.length() > 0) {
                    for (java.util.Iterator<String> keys = srcs.keys(); keys.hasNext();) {
                        try {
                            int n = Integer.parseInt(keys.next());
                            if (n >= 1 && seenEpisodes.add(n)) {
                                episodes.put(new JSONObject().put("number", n)
                                        .put("url", channelizedUrl(profile.origin() + "/video/" + id + "/")));
                            }
                        } catch (NumberFormatException ignored) { }
                    }
                }
            } catch (Exception ignored) { }
        }
        if (episodes.length() == 0) throw new IllegalStateException("未找到选集列表");
        // 黄果详情页选集链接顺序偶有错乱（如第 2 集排在最前），统一按集号升序
        {
            java.util.List<JSONObject> ordered = new java.util.ArrayList<>();
            for (int i = 0; i < episodes.length(); i++) ordered.add(episodes.optJSONObject(i));
            ordered.sort((a, b) -> Integer.compare(a.optInt("number"), b.optInt("number")));
            JSONArray sortedEpisodes = new JSONArray();
            for (JSONObject o : ordered) sortedEpisodes.put(o);
            episodes = sortedEpisodes;
        }
        result.put("episodeLabel", "共 " + episodes.length() + " 集");
        result.put("episodes", episodes);
        // 提取红果官方系列键（网页版 JSON 里可能带 App series_id/album_id 等），供 NAS 任务走红果 App 取流
        // （不落地会退化为网页源低码率；宁可多候选键，取第一个合法数字）
        String appSeries = firstNonEmpty(
                data.optString("series_id"), data.optString("seriesId"),
                data.optString("album_id"), data.optString("albumId"),
                data.optString("related_album_id"), data.optString("red_key"),
                data.optString("redKey"), data.optString("video_album_id"));
        if (!appSeries.isEmpty() && appSeries.matches("[0-9]{1,30}")) result.put("seriesId", appSeries);
        return result;
    }

    private static String firstNonEmpty(String... values) {
        for (String v : values) if (v != null && !v.trim().isEmpty()) return v.trim();
        return "";
    }

    JSONObject episode(String id, int number) throws Exception {
        if (!id.matches("\\d+") || number < 1) throw new IllegalArgumentException("无效选集");
        String path = profile.route(number == 1 ? "episodeFirst" : "episode", "id", id, "episode", String.valueOf(number));
        Document document = page(path);
        Element node = document.selectFirst(profile.selector("content"));
        if (node == null) throw new IllegalStateException("未取得播放信息");
        JSONObject data = profile.mapJson(new JSONObject(node.data().isEmpty() ? node.text() : node.data()), "content");
        String videoSrc = data.optString("videoSrc").trim();
        // 2026-11 改版：详情页不再塞播放地址（videoSrc 留空），改成 /api/videos/:id/play 单独下发
        if (videoSrc.isEmpty()) {
            JSONObject play = playAddress(id, number);
            videoSrc = play.optString("video_url").trim();
            if (videoSrc.isEmpty()) throw new IllegalStateException("播放接口没有给出地址");
            String title = play.optString("title").trim();
            if (!title.isEmpty()) data.put("title", title);
        }
        videoSrc = channelizedUrl(videoSrc);
        String base = ServerConfig.get(appContext);
        boolean viaBackend = !base.isEmpty() && videoSrc.startsWith(base + "api/huangguo-proxy?");
        if (!id.equals(String.valueOf(data.opt("id"))) || !(videoSrc.startsWith("https://") || viaBackend)) {
            throw new IllegalStateException("未取得有效播放地址");
        }
        JSONObject result = new JSONObject();
        result.put("id", id);
        result.put("episode", number);
        result.put("title", data.optString("title", "剧集 " + id));
        result.put("source", videoSrc);
        result.put("cover", channelizedUrl(data.optString("coverSrc", data.optString("posterSrc"))));
        result.put("nextUrl", attr(document.selectFirst(profile.selector("next")), "href"));
        return result;
    }

    /**
     * 新版详情页的播放地址在这个接口里，返回 { data: { video_url, title, ... } }。
     * 同样走当前通道：仅直连/仅代理自己取，走后端则交后端代取。
     */
    private JSONObject playAddress(String id, int number) throws Exception {
        String path = profile.route("playApi", "id", id, "episode", String.valueOf(number));
        byte[] body = fetch(profile.origin() + path);
        if (body.length == 0) throw new IllegalStateException("播放接口返回空");
        JSONObject envelope = new JSONObject(new String(body, StandardCharsets.UTF_8));
        JSONObject data = envelope.optJSONObject("data");
        if (data == null) throw new IllegalStateException("播放接口没有返回数据");
        return data;
    }

    String coverData(String value) throws Exception {
        value = profile.coverUrl(value);
        URL url = new URL(value);
        String path = url.getPath();
        String extension = path.substring(path.lastIndexOf('.') + 1).toLowerCase(java.util.Locale.ROOT);
        if (profile.object("cover").optBoolean("checkExtension", true) && !Arrays.asList("jpg", "jpeg", "png", "webp", "gif").contains(extension)) throw new IllegalArgumentException("不支持的封面格式");
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] hash = digest.digest((profile.fingerprint + ":" + url.getHost() + path).getBytes(StandardCharsets.UTF_8));
        StringBuilder key = new StringBuilder();
        for (int i = 0; i < 16; i++) key.append(String.format("%02x", hash[i] & 0xff));
        File file = new File(coverDir, key + ".img");
        byte[] decoded;
        if (file.isFile()) {
            decoded = java.nio.file.Files.readAllBytes(file.toPath());
            if (repairConfiguredHeader(decoded)) {
                try (FileOutputStream output = new FileOutputStream(file)) { output.write(decoded); }
            }
            if (!validImage(decoded)) {
                file.delete();
                decoded = null;
            } else file.setLastModified(System.currentTimeMillis());
        } else decoded = null;
        if (decoded == null) {
            decoded = fetch(value);
            String mode = profile.object("cover").optString("mode");
            // 后端通道若已解密返回真图则直接使用；仅当数据仍非有效图片时才本地 AES-CBC 解密（兼容旧后端/直连通道）
            if (!validImage(decoded) && ("aes-cbc".equals(mode) || "auto".equals(mode))) {
                Cipher cipher = Cipher.getInstance(profile.object("cover").getString("transformation"));
                cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(profile.keyBytes("key"), "AES"),
                        new IvParameterSpec(profile.keyBytes("iv")));
                decoded = cipher.doFinal(decoded);
            }
            repairConfiguredHeader(decoded);
            if (!validImage(decoded)) throw new IllegalStateException("封面解密结果无效");
            try (FileOutputStream output = new FileOutputStream(file)) { output.write(decoded); }
            trimCoverCache();
        }
        String mime = decoded[0] == (byte) 0xff ? "image/jpeg" :
                decoded[0] == (byte) 0x89 ? "image/png" : decoded[0] == 'G' ? "image/gif" : "image/webp";
        return "data:" + mime + ";base64," + Base64.encodeToString(decoded, Base64.NO_WRAP);
    }

    private boolean repairConfiguredHeader(byte[] bytes) throws Exception {
        boolean repaired = "legacy-xor".equals(profile.object("cover").optString("headerRepair")) && repairCoverHeader(bytes);
        boolean patched = profile.patchHeader(bytes);
        return repaired || patched;
    }

    private static boolean repairCoverHeader(byte[] bytes) {
        // Current CDN payloads differ from the valid Windows cache at byte offset 6 by XOR 0x0E.
        // Check the surrounding format signature so an already-normalized cache is not changed twice.
        if (bytes.length < 12) return false;
        boolean png = bytes[0] == (byte) 0x89 && bytes[1] == 'P' && bytes[2] == 'N' && bytes[3] == 'G' &&
                bytes[4] == 0x0d && bytes[5] == 0x0a && bytes[6] == 0x14 && bytes[7] == 0x0a;
        boolean jpeg = bytes[0] == (byte) 0xff && bytes[1] == (byte) 0xd8 && bytes[2] == (byte) 0xff;
        boolean jfif = jpeg && bytes[3] == (byte) 0xe0 && bytes[6] == 'D' &&
                bytes[7] == 'F' && bytes[8] == 'I' && bytes[9] == 'F' && bytes[10] == 0;
        boolean dqt = jpeg && bytes[3] == (byte) 0xdb && (bytes[6] & 0xfc) == 0x0c;
        boolean exif = jpeg && bytes[3] == (byte) 0xe1 && bytes[6] == 'K' &&
                bytes[7] == 'x' && bytes[8] == 'i' && bytes[9] == 'f';
        boolean icc = jpeg && bytes[3] == (byte) 0xe2 && bytes[6] == 'G' &&
                bytes[7] == 'C' && bytes[8] == 'C' && bytes[9] == '_';
        if (!(png || jfif || dqt || exif || icc)) return false;
        bytes[6] ^= 0x0e;
        return true;
    }

    private static boolean validImage(byte[] bytes) {
        if (bytes.length < 16) return false;
        return (bytes[0] == (byte) 0xff && bytes[1] == (byte) 0xd8) ||
                (bytes[0] == (byte) 0x89 && bytes[1] == 'P' && bytes[2] == 'N' && bytes[3] == 'G' &&
                        bytes[4] == 0x0d && bytes[5] == 0x0a && bytes[6] == 0x1a && bytes[7] == 0x0a) ||
                (bytes[0] == 'R' && bytes[1] == 'I' && bytes[2] == 'F' && bytes[3] == 'F' &&
                        bytes[8] == 'W' && bytes[9] == 'E' && bytes[10] == 'B' && bytes[11] == 'P') ||
                (bytes[0] == 'G' && bytes[1] == 'I' && bytes[2] == 'F');
    }

    private void trimCoverCache() {
        File[] files = coverDir.listFiles();
        if (files == null) return;
        long bytes = 0;
        for (File file : files) bytes += file.length();
        if (bytes <= 150L * 1024 * 1024) return;
        Arrays.sort(files, Comparator.comparingLong(File::lastModified));
        for (File file : files) {
            if (bytes <= 150L * 1024 * 1024) break;
            long size = file.length();
            if (file.delete()) bytes -= size;
        }
    }

    void clearCovers() {
        File[] files = coverDir.listFiles();
        if (files != null) for (File file : files) file.delete();
    }
}
