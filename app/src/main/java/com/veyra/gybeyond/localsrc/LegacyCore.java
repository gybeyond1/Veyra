package com.veyra.gybeyond.localsrc;

import org.json.JSONObject;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * 黄果旧版 / 禁果共用的那套 App 接口协议，从 server/sources/legacy-core.js 一字节一字节搬过来的。
 *
 *   1. 参数 JSON 用 AES-128-CBC（paramKey / paramIv）加密，塞进 data 查询参数；
 *   2. 响应是信封，data 是密文：前 12 字节随机前缀 + interfaceKey 派生 AES-256 的 key/iv；
 *   3. 先用设备号换访客 token，token 过期（5005/5009）自动重登一次。
 *
 * 搬到客户端的原因很简单：这些接口在用户后端（国内机房）上会 ECONNRESET，
 * 而同一台手机开着 VPN 却通 —— 那就让请求从手机发出去。
 */
final class LegacyCore {

    /** 官网脚本里那套密钥；抓不到脚本时用它顶上。 */
    static final String FALLBACK_INTERFACE = "65dc07d1b7915c6b2937432b091837a7";
    static final String FALLBACK_PARAM = "BxJand%xf5h3sycH";
    static final String FALLBACK_IV = "BxJand%xf5h3sycH";

    /** 设备号 / token 的落地位置：客户端用 SharedPreferences，桌面验证用内存。 */
    interface Store {
        String get(String key);
        void put(String key, String value);
    }

    interface Config {
        String key();
        String label();
        String[] bases();
        String front();
        String cdn();
        String ua();
        /** X-User-Agent 头，带设备号。 */
        String userAgent(String device);
        String newDevice();
    }

    private final Config config;
    private final Store store;

    private String token = "";
    private String device = "";
    private String base = "";
    private String interfaceKey = "";
    private String paramKey = "";
    private String paramIv = "";
    private long protocolAt;
    private boolean refreshing;

    LegacyCore(Config config, Store store) {
        this.config = config;
        this.store = store;
        String savedDevice = store.get(config.key() + ".device");
        device = savedDevice == null ? "" : savedDevice;
        String savedBase = store.get(config.key() + ".base");
        base = savedBase == null ? "" : savedBase;
        String savedKeys = store.get(config.key() + ".protocol");
        if (savedKeys != null && savedKeys.contains("|")) {
            String[] parts = savedKeys.split("\\|");
            if (parts.length == 3) {
                interfaceKey = parts[0];
                paramKey = parts[1];
                paramIv = parts[2];
                protocolAt = System.currentTimeMillis();
            }
        }
    }

    String label() {
        return config.label();
    }

    /* ---------------- 协议 ---------------- */

    private String paramKey() {
        if (paramKey.isEmpty() || System.currentTimeMillis() - protocolAt > 24L * 3600 * 1000) useFallback();
        return paramKey;
    }

    private String paramIv() {
        if (paramIv.isEmpty()) useFallback();
        return paramIv;
    }

    private String interfaceKey() {
        if (interfaceKey.isEmpty()) useFallback();
        return interfaceKey;
    }

    private void useFallback() {
        interfaceKey = FALLBACK_INTERFACE;
        paramKey = FALLBACK_PARAM;
        paramIv = FALLBACK_IV;
        protocolAt = System.currentTimeMillis();
    }

    /** 抓一次官网脚本把新密钥捞回来；失败就保持现有值，绝不把能用的密钥冲掉。 */
    private void refreshProtocol() {
        if (refreshing) return;
        refreshing = true;
        try {
            String front = config.front();
            Map<String, String> headers = Net.headers("Referer", front + "/", "User-Agent", config.ua());
            Net.Res page = Net.get(front + "/", headers, 8000, 1L << 20);
            String html = page.text();
            java.util.regex.Matcher entry = java.util.regex.Pattern
                    .compile("<script[^>]*type=\"module\"[^>]*src=\"([^\"]+)\"").matcher(html);
            if (!entry.find()) return;
            String scriptUrl = Net.absolute(front + "/", entry.group(1));
            String script = Net.get(scriptUrl, headers, 10000, 4L << 20).text();
            String nextInterface = pick(script, "interfaceKey");
            String nextKey = pick(script, "parameterKey");
            String nextIv = pick(script, "parameterIv");
            if (nextInterface.isEmpty() || nextKey.length() != 16 || nextIv.length() != 16) return;
            interfaceKey = nextInterface;
            paramKey = nextKey;
            paramIv = nextIv;
            protocolAt = System.currentTimeMillis();
            store.put(config.key() + ".protocol", interfaceKey + "|" + paramKey + "|" + paramIv);
        } catch (Exception ignored) {
            /* 抓不到就继续用旧的 */
        } finally {
            refreshing = false;
        }
    }

    private static String pick(String script, String name) {
        java.util.regex.Matcher hit = java.util.regex.Pattern
                .compile("[\"']" + name + "[\"']\\s*[:,]\\s*[\"']([^\"'\\\\\\r\\n]+)[\"']").matcher(script);
        return hit.find() ? hit.group(1) : "";
    }

    private String encryptParam(JSONObject value) {
        byte[] key = paramKey().getBytes(StandardCharsets.UTF_8);
        byte[] iv = paramIv().getBytes(StandardCharsets.UTF_8);
        byte[] plain = Crypt.pkcs7(value.toString().getBytes(StandardCharsets.UTF_8));
        return Crypt.base64(Crypt.aesEncrypt(key, iv, plain, false));
    }

    /** 前 12 字节是随机前缀，用它和 interfaceKey 派生出 key 与 iv。 */
    private byte[] decryptResponse(String dataString) {
        byte[] payload = Crypt.unb64(dataString);
        if (payload.length < 12) throw new IllegalStateException("响应密文过短");
        byte[] prefix = java.util.Arrays.copyOfRange(payload, 0, 12);
        byte[] iface = interfaceKey().getBytes(StandardCharsets.UTF_8);
        byte[] mixed = new byte[iface.length + prefix.length];
        System.arraycopy(iface, 0, mixed, 0, iface.length);
        System.arraycopy(prefix, 0, mixed, iface.length, prefix.length);

        int half = mixed.length >> 1;
        byte[] seed = java.util.Arrays.copyOfRange(Crypt.sha256(mixed), 8, 24);

        byte[] left = new byte[seed.length + half];
        System.arraycopy(seed, 0, left, 0, seed.length);
        System.arraycopy(mixed, 0, left, seed.length, half);

        byte[] right = new byte[(mixed.length - half) + seed.length];
        System.arraycopy(mixed, half, right, 0, mixed.length - half);
        System.arraycopy(seed, 0, right, mixed.length - half, seed.length);

        byte[] h1 = Crypt.sha256(left);
        byte[] h2 = Crypt.sha256(right);

        byte[] key = new byte[32];
        System.arraycopy(h1, 0, key, 0, 8);
        System.arraycopy(h2, 8, key, 8, 16);
        System.arraycopy(h1, 24, key, 24, 8);

        byte[] iv = new byte[16];
        System.arraycopy(h2, 0, iv, 0, 4);
        System.arraycopy(h1, 12, iv, 4, 8);
        System.arraycopy(h2, 28, iv, 12, 4);

        byte[] body = java.util.Arrays.copyOfRange(payload, 12, payload.length);
        if (body.length % 16 != 0) throw new IllegalStateException("响应密文未对齐");
        return Crypt.aesDecrypt(key, iv, body, true);
    }

    /* ---------------- 请求 ---------------- */

    private Map<String, String> apiHeaders() {
        Map<String, String> headers = Net.headers(
                "Accept", "application/json",
                "temp", "test",
                "X-User-Agent", config.userAgent(device.isEmpty() ? "00000000000000000000000000000" : device),
                "User-Agent", config.ua());
        String front = config.front();
        if (front != null && !front.isEmpty()) {
            headers.put("Origin", front);
            headers.put("Referer", front + "/");
        }
        return headers;
    }

    private String[] bases() {
        String[] raw = config.bases();
        if (base == null || base.isEmpty()) return raw;
        java.util.List<String> out = new java.util.ArrayList<>();
        out.add(base);
        for (String item : raw) if (!item.equals(base)) out.add(item);
        return out.toArray(new String[0]);
    }

    private synchronized String login(boolean force) throws Exception {
        if (!token.isEmpty() && !force) return token;
        if (device.isEmpty()) {
            device = config.newDevice();
            store.put(config.key() + ".device", device);
        }
        if (force) refreshProtocol();
        if (paramKey().isEmpty()) useFallback();

        JSONObject params = new JSONObject().put("devID", device).put("sysType", "ios").put("isAppStore", false);
        String payload = new JSONObject().put("data", encryptParam(params)).toString();

        Exception lastError = null;
        for (String candidate : bases()) {
            try {
                Map<String, String> headers = apiHeaders();
                headers.put("Content-Type", "application/json");
                Net.Res res = Net.postJson(candidate + "/api/app/mine/login/h5", headers, payload, 8000, 2L << 20);
                JSONObject envelope = new JSONObject(res.text());
                Object data = envelope.opt("data");
                JSONObject info = null;
                if (data instanceof String) {
                    info = new JSONObject(new String(decryptResponse((String) data), StandardCharsets.UTF_8));
                } else if (data instanceof JSONObject) {
                    info = (JSONObject) data;
                }
                String found = info == null ? "" : info.optString("token", info.optString("accessToken", ""));
                if (found.isEmpty()) throw new IllegalStateException(label() + "访客登录失败");
                token = found;
                base = candidate;
                store.put(config.key() + ".base", base);
                return token;
            } catch (Exception error) {
                lastError = error;
            }
        }
        if (!force) return login(true);
        throw lastError == null ? new IllegalStateException(label() + "访客登录失败") : lastError;
    }

    JSONObject api(String path, JSONObject params) throws Exception {
        return api(path, params, false);
    }

    private JSONObject api(String path, JSONObject params, boolean retried) throws Exception {
        String auth = login(false);
        Exception lastError = null;
        for (String candidate : bases()) {
            try {
                String url = candidate + path;
                if (params != null) {
                    url += (url.contains("?") ? "&" : "?") + "data="
                            + URLEncoder.encode(encryptParam(params), "UTF-8");
                }
                Map<String, String> headers = apiHeaders();
                headers.put("Authorization", auth);
                Net.Res res = Net.get(url, headers, 15000, 8L << 20);
                JSONObject envelope;
                try {
                    envelope = new JSONObject(res.text());
                } catch (Exception error) {
                    throw new IllegalStateException(label() + "返回 " + res.status);
                }
                String code = envelope.optString("code", "").replace("\"", "");
                if (!code.isEmpty() && !"200".equals(code) && !"0".equals(code) && !"null".equals(code)) {
                    if (("5005".equals(code) || "5009".equals(code)) && !retried) {
                        token = "";
                        return api(path, params, true);
                    }
                    throw new IllegalStateException(label() + "：" + envelope.optString("msg", code));
                }
                Object data = envelope.opt("data");
                if (data instanceof String && envelope.has("hash")) {
                    try {
                        data = new JSONObject(new String(decryptResponse((String) data), StandardCharsets.UTF_8));
                    } catch (Exception error) {
                        if (!retried) {
                            token = "";
                            interfaceKey = "";
                            return api(path, params, true);
                        }
                        throw new IllegalStateException(label() + "响应解密失败");
                    }
                }
                if (data == null || data == JSONObject.NULL) throw new IllegalStateException(label() + "没有返回数据");
                if (!candidate.equals(base)) {
                    base = candidate;
                    store.put(config.key() + ".base", base);
                }
                if (data instanceof JSONObject) return (JSONObject) data;
                return new JSONObject().put("list", data);
            } catch (Exception error) {
                lastError = error;
            }
        }
        throw lastError == null ? new IllegalStateException(label() + "请求失败") : lastError;
    }

    /** 播放地址：{base}/api/app/vid/h5/m3u8/{路径}?token=… [&c=CDN] */
    String playUrl(String videoUrl) throws Exception {
        String auth = login(false);
        String host = (base == null || base.isEmpty()) ? config.bases()[0] : base;
        StringBuilder url = new StringBuilder()
                .append(host).append("/api/app/vid/h5/m3u8/")
                .append(URLEncoder.encode(videoUrl, "UTF-8"))
                .append("?token=").append(URLEncoder.encode(auth, "UTF-8"));
        String cdn = config.cdn();
        if (cdn != null && !cdn.isEmpty()) url.append("&c=").append(URLEncoder.encode(cdn, "UTF-8"));
        return url.toString();
    }

    String referer() {
        return config.front() + "/";
    }
}
