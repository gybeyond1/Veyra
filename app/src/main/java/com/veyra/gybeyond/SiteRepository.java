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
import java.util.LinkedHashSet;
import java.util.Set;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

final class SiteRepository {
    private final SiteProfile profile;
    private final File coverDir;
    private final Context appContext;
    private final String proxyAddress;   // 黄果代理 "host:port"，未设置为空串
    // 通道状态：直连（系统网络栈，VPN/全局代理自然生效）→ 配置代理 → 后端转发
    private volatile long lastDirectFailAt = 0;   // 直连/代理通道最近失败时间
    private static final long DIRECT_FAIL_TTL_MS = 60_000; // 直连失败缓存 60s：期间直接走后端，不再重复等判定
    private static final int CHANNEL_TIMEOUT_MS = 4_000;   // 直连/代理通道判定超时（3~5s 窗口）
    private static final int BACKEND_READ_TIMEOUT_MS = 12_000;
    private final okhttp3.OkHttpClient backendClient;

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

    /** 直连/代理通道最近失败过（60s 内）→ 直接走后端转发。 */
    private synchronized boolean directBlocked() {
        return System.currentTimeMillis() - lastDirectFailAt < DIRECT_FAIL_TTL_MS;
    }
    private synchronized void markDirectFailed() { lastDirectFailAt = System.currentTimeMillis(); }

    private static Proxy proxy(String address) {
        String[] parts = address.split(":");
        String host = parts.length > 0 && !parts[0].isEmpty() ? parts[0] : "127.0.0.1";
        int port = 80;
        if (parts.length > 1) try { port = Integer.parseInt(parts[1]); } catch (NumberFormatException ignored) { }
        return new Proxy(Proxy.Type.HTTP, new InetSocketAddress(host, port));
    }

    /**
     * 通道抓取（仅黄果源；红果不走此通道）：
     * 直连（系统网络栈，VPN/全局代理自然生效）→ 配置代理 → 后端转发。
     * 直连失败缓存 60s，期间直接走后端（不再每次等 4s 判定）。
     */
    private byte[] fetch(String url) throws Exception {
        if (directBlocked()) {
            if (!proxyAddress.isEmpty()) {
                try { return fetchViaProxy(url); } catch (Exception ignored) { }
            }
            return fetchViaBackend(url);
        }
        try {
            return fetchDirect(url);
        } catch (Exception directError) {
            markDirectFailed();
            if (!proxyAddress.isEmpty()) {
                try { return fetchViaProxy(url); } catch (Exception ignored) { }
            }
            return fetchViaBackend(url);
        }
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

    /** 播放/选集 URL 通道化：直连不通时改写为后端代理地址（m3u8 及其分片由后端重写兜底）。 */
    private String channelizedUrl(String raw) throws Exception {
        if (directBlocked()) {
            String base = ServerConfig.get(appContext);
            if (!base.isEmpty()) return base + "api/huangguo-proxy?url=" + java.net.URLEncoder.encode(raw, "UTF-8");
        }
        return raw;
    }

    /**
     * 抓取页面；直连（4s 判定）→ 配置代理 → 后端通道+备用源循环（互相兜底）。
     * 红果不走此方法。
     */
    private Document page(String path) throws Exception {
        if (!path.startsWith("/") || path.startsWith("//")) throw new IllegalArgumentException("无效路径");
        if (!directBlocked()) {
            try {
                byte[] body = fetchDirect(profile.origin() + path);
                if (body.length < 1000) throw new IllegalStateException("站点暂时返回空页面");
                return Jsoup.parse(new String(body, StandardCharsets.UTF_8), profile.origin());
            } catch (Exception directError) {
                markDirectFailed();
                if (!proxyAddress.isEmpty()) {
                    try {
                        byte[] body = fetchViaProxy(profile.origin() + path);
                        if (body.length < 1000) throw new IllegalStateException("站点暂时返回空页面");
                        return Jsoup.parse(new String(body, StandardCharsets.UTF_8), profile.origin());
                    } catch (Exception ignored) { }
                }
            }
        }
        for (int attempt = 0; attempt < profile.sourceCount(); attempt++) {
            try {
                byte[] body = fetchViaBackend(profile.origin() + path);
                if (body.length < 1000) throw new IllegalStateException("站点暂时返回空页面");
                return Jsoup.parse(new String(body, StandardCharsets.UTF_8), profile.origin());
            } catch (Exception error) {
                if (attempt + 1 < profile.sourceCount() && profile.switchSource()) continue; // 换备用源
                throw error;
            }
        }
        throw new IllegalStateException("所有通道与站点源均不可用");
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

    JSONObject search(String term) throws Exception {
        String query = term.trim();
        if (query.length() > 80) query = query.substring(0, 80);
        if (query.isEmpty()) return new JSONObject().put("items", new JSONArray()).put("nextPage", JSONObject.NULL);
        return listing(page(profile.route("search", "query", java.net.URLEncoder.encode(query, StandardCharsets.UTF_8))), 1, "");
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
        if (episodes.length() == 0) throw new IllegalStateException("未找到选集列表");
        result.put("episodeLabel", "共 " + episodes.length() + " 集");
        result.put("episodes", episodes);
        return result;
    }

    JSONObject episode(String id, int number) throws Exception {
        if (!id.matches("\\d+") || number < 1) throw new IllegalArgumentException("无效选集");
        String path = profile.route(number == 1 ? "episodeFirst" : "episode", "id", id, "episode", String.valueOf(number));
        Document document = page(path);
        Element node = document.selectFirst(profile.selector("content"));
        if (node == null) throw new IllegalStateException("未取得播放信息");
        JSONObject data = profile.mapJson(new JSONObject(node.data().isEmpty() ? node.text() : node.data()), "content");
        String videoSrc = channelizedUrl(data.optString("videoSrc"));
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
            if ("aes-cbc".equals(mode) || "auto".equals(mode) && !validImage(decoded)) {
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
