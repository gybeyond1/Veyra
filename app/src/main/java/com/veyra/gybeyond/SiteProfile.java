package com.veyra.gybeyond;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import org.jsoup.Jsoup;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Iterator;
import java.util.regex.Pattern;

/** Immutable rules for one screen/playback session; callers keep the same request interface. */
final class SiteProfile {
    private final JSONObject rules;
    final String[] origins;      // 主源 + 备用源（互相兜底），顺序即优先级
    final String fingerprint;
    private int sourceIndex = 0;

    SiteProfile(Context context, JSONObject overrides) throws Exception {
        JSONObject defaults = new JSONObject(new String(HotUpdateManager.read(
                context.getAssets().open("site-default.json"), 128 * 1024), StandardCharsets.UTF_8));
        rules = merge(defaults, overrides == null ? new JSONObject() : overrides);
        // 源列表解析：热更新/内置若显式给了 "origin"，作为首选源；再接 "origins" 数组；去重保序
        java.util.LinkedHashSet<String> sourceSet = new java.util.LinkedHashSet<>();
        if (overrides != null && overrides.has("origin") && !overrides.getString("origin").trim().isEmpty())
            sourceSet.add(overrides.getString("origin").trim());
        JSONArray originList = rules.optJSONArray("origins");
        for (int i = 0; originList != null && i < originList.length(); i++)
            sourceSet.add(originList.optString(i));
        if (sourceSet.isEmpty()) sourceSet.add(rules.getString("origin"));
        origins = sourceSet.toArray(new String[0]);
        for (int i = 0; i < origins.length; i++) {
            origins[i] = origins[i].replaceAll("/+$", "");
            URI uri = new URI(origins[i]);
            if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null
                    || uri.getQuery() != null || uri.getFragment() != null || !uri.getPath().isEmpty())
                throw new IllegalArgumentException("站点必须是 HTTPS 域名");
        }
        for (Iterator<String> keys = object("routes").keys(); keys.hasNext();) {
            String path = object("routes").getString(keys.next());
            if (!path.startsWith("/") || path.startsWith("//") || path.contains(".."))
                throw new IllegalArgumentException("无效站点路径");
        }
        for (Iterator<String> keys = object("selectors").keys(); keys.hasNext();)
            Jsoup.parse("").select(object("selectors").getString(keys.next()));
        for (Iterator<String> keys = object("patterns").keys(); keys.hasNext();)
            Pattern.compile(object("patterns").getString(keys.next()).replace("{id}", "1"));
        JSONArray hosts = object("cover").getJSONArray("allowedHosts");
        if (hosts.length() == 0) throw new IllegalArgumentException("缺少封面域名");
        for (int i = 0; i < hosts.length(); i++) {
            if (!hosts.getString(i).matches("[a-zA-Z0-9.-]+")) throw new IllegalArgumentException("无效封面域名");
        }
        String mode = object("cover").getString("mode");
        if (!java.util.Arrays.asList("plain", "aes-cbc", "auto").contains(mode))
            throw new IllegalArgumentException("不支持的封面模式");
        String transformation = object("cover").getString("transformation");
        if (!java.util.Arrays.asList("AES/CBC/NoPadding", "AES/CBC/PKCS5Padding").contains(transformation))
            throw new IllegalArgumentException("不支持的解密方式");
        if (!"plain".equals(mode) && (keyBytes("key").length != 16 && keyBytes("key").length != 24
                && keyBytes("key").length != 32 || keyBytes("iv").length != 16))
            throw new IllegalArgumentException("无效封面密钥或 IV");
        fingerprint = hex(MessageDigest.getInstance("SHA-256").digest(rules.toString().getBytes(StandardCharsets.UTF_8)));
    }

    private static JSONObject merge(JSONObject base, JSONObject patch) throws Exception {
        JSONObject out = new JSONObject(base.toString());
        for (Iterator<String> keys = patch.keys(); keys.hasNext();) {
            String key = keys.next();
            Object value = patch.get(key);
            if (value instanceof JSONObject && out.opt(key) instanceof JSONObject)
                out.put(key, merge(out.getJSONObject(key), (JSONObject) value));
            else out.put(key, value);
        }
        return out;
    }

    /** 当前生效的源（主源或兜底切换后的备用源）。 */
    String origin() { return origins[sourceIndex]; }
    /** 切换到下一个备用源；无更多源时返回 false。 */
    boolean switchSource() {
        if (sourceIndex + 1 >= origins.length) return false;
        sourceIndex++;
        return true;
    }
    int sourceCount() { return origins.length; }

    JSONObject object(String key) { return rules.optJSONObject(key); }
    String selector(String key) { return object("selectors").optString(key); }
    String attribute(String key) { return object("attributes").optString(key); }
    String route(String name, String... pairs) {
        String result = object("routes").optString(name);
        for (int i = 0; i < pairs.length; i += 2) result = result.replace("{" + pairs[i] + "}", pairs[i + 1]);
        return result;
    }
    Pattern pattern(String name, String id) {
        return Pattern.compile(object("patterns").optString(name).replace("{id}", id == null ? "" : id));
    }
    String relative(String link) {
        try {
            URI resolved = new URI(origin() + "/").resolve(link);
            if (!new URI(origin()).getHost().equalsIgnoreCase(resolved.getHost())) return "";
            return resolved.getRawPath();
        } catch (Exception error) { return ""; }
    }
    boolean categoryAllowed(String name) {
        JSONArray names = rules.optJSONArray("categories");
        for (int i = 0; names != null && i < names.length(); i++) if (name.equals(names.optString(i))) return true;
        return false;
    }
    JSONObject mapJson(JSONObject input, String kind) throws Exception {
        JSONObject map = object("fields").getJSONObject(kind), result = new JSONObject(input.toString());
        for (Iterator<String> keys = map.keys(); keys.hasNext();) {
            String key = keys.next();
            Object paths = map.get(key);
            JSONArray aliases = paths instanceof JSONArray ? (JSONArray) paths : new JSONArray().put(paths);
            result.remove(key);
            for (int i = 0; i < aliases.length(); i++) {
                Object value = input;
                for (String part : aliases.getString(i).split("\\."))
                    value = value instanceof JSONObject ? ((JSONObject) value).opt(part) : null;
                if (value != null && value != JSONObject.NULL) { result.put(key, value); break; }
            }
        }
        return result;
    }
    byte[] keyBytes(String name) {
        String value = object("cover").optString(name);
        String encoding = object("cover").optString("keyEncoding", "text");
        if ("base64".equals(encoding)) return android.util.Base64.decode(value, android.util.Base64.DEFAULT);
        if ("hex".equals(encoding)) {
            if (!value.matches("(?:[0-9a-fA-F]{2})+")) throw new IllegalArgumentException("无效十六进制密钥");
            byte[] bytes = new byte[value.length() / 2];
            for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) Integer.parseInt(value.substring(i * 2, i * 2 + 2), 16);
            return bytes;
        }
        if (!"text".equals(encoding)) throw new IllegalArgumentException("不支持的密钥编码");
        return value.getBytes(StandardCharsets.UTF_8);
    }
    String coverUrl(String value) throws Exception {
        URI uri = new URI(value);
        String host = uri.getHost();
        if (!"https".equals(uri.getScheme()) || host == null || uri.getUserInfo() != null)
            throw new IllegalArgumentException("无效封面地址");
        JSONObject rewrites = object("cover").optJSONObject("hostRewrites");
        if (rewrites != null && rewrites.has(host)) {
            host = rewrites.getString(host);
            uri = new URI("https", null, host, uri.getPort(), uri.getPath(), uri.getQuery(), null);
        }
        JSONArray hosts = object("cover").getJSONArray("allowedHosts");
        for (int i = 0; i < hosts.length(); i++) if (host.equalsIgnoreCase(hosts.getString(i))) return uri.toString();
        throw new IllegalArgumentException("无效封面域名");
    }
    boolean patchHeader(byte[] data) throws Exception {
        boolean changed = false;
        JSONArray patches = object("cover").optJSONArray("bytePatches");
        for (int i = 0; patches != null && i < patches.length(); i++) {
            JSONObject patch = patches.getJSONObject(i);
            int offset = patch.getInt("offset");
            if (offset < 0 || offset >= data.length) throw new IllegalArgumentException("封面补丁越界");
            if ((data[offset] & 255) == patch.getInt("from")) {
                changed |= (data[offset] & 255) != patch.getInt("to");
                data[offset] = (byte) patch.getInt("to");
            }
        }
        return changed;
    }
    static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder();
        for (byte value : bytes) out.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return out.toString();
    }
}
