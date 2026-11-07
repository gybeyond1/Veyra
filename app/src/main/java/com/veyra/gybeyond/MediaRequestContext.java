package com.veyra.gybeyond;

import org.json.JSONObject;

import java.net.URL;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * 「仅直连」用的源站凭据。
 *
 * <p>接口型源（剧果 / 野果 / 禁果短剧 / 黄果 AI）在 net=1 时，后端只下发源站真实地址，
 * 不再代取流。但源站的防盗链认两样东西：Referer 必须是它自己的播放页，
 * Cookie 是 CloudFront 签名或登录态 —— 播放器默认一个都不带，清单第一步就 403。
 *
 * <p>后端已经把这两个头一起返回了（{@code headers}），这里做一次进程内传递，
 * 由 {@link ChannelHttpDataSource} 在每次建连时取用。放在静态里而不是层层透传，
 * 是因为 ExoPlayer 的 DataSource 工厂是全局构造的，拿不到单集的解析结果。
 *
 * <p>只在打开一集时整体替换，读到的永远是最近一次播放的凭据，不会半新半旧。
 */
final class MediaRequestContext {

    private static volatile Map<String, String> headers = Collections.emptyMap();
    private static volatile String site = "";

    private MediaRequestContext() { }

    /** 播放前调用：data 是后端 episode 返回的 JSON，url 是它给的播放地址。 */
    static void set(JSONObject data, String url) {
        Map<String, String> parsed = new LinkedHashMap<>();
        JSONObject source = data == null ? null : data.optJSONObject("headers");
        if (source != null) {
            for (Iterator<String> keys = source.keys(); keys.hasNext(); ) {
                String key = keys.next();
                String value = source.optString(key, "");
                if (!key.isEmpty() && !value.isEmpty()) parsed.put(key, value);
            }
        }
        headers = Collections.unmodifiableMap(parsed);
        site = hostOf(url);
    }

    static void clear() {
        headers = Collections.emptyMap();
        site = "";
    }

    static Map<String, String> headers() {
        return headers;
    }

    static String site() {
        return site;
    }

    /**
     * Cookie 只发回源站自己。清单和分片通常同域，但有些源的密钥 / 分片会落到另一条 CDN，
     * 把签名 Cookie 发过去会被当成非法请求拒掉，所以按站点做一次收口。
     */
    static boolean sameSite(String host, String origin) {
        if (host == null || host.isEmpty() || origin == null || origin.isEmpty()) return false;
        String left = host.toLowerCase(Locale.ROOT);
        String right = origin.toLowerCase(Locale.ROOT);
        return left.equals(right) || left.endsWith("." + right) || right.endsWith("." + left);
    }

    private static String hostOf(String url) {
        try {
            String host = new URL(url).getHost();
            return host == null ? "" : host;
        } catch (Exception ignored) {
            return "";
        }
    }
}
