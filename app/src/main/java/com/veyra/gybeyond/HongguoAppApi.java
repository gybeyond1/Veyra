package com.veyra.gybeyond;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;

/**
 * 红果 App 详情接口（api5-normal-sinfonlineb.fqnovel.com /novel/player/video_detail/v1/）。
 * 2026-10-15 变更：签名接口已被红果对第三方静默风控（HTTP 200 空 body），改用无签名 +
 * 固定设备参数（klink_egdi/iid/device_id/cdid…，与 hongguo-dl 同款，实测 video_detail 正常返回）。
 * 目标：拿到红果官方系列键 related_album_id 与官方季序号 season_index，供前端按官方系列分组。
 */
final class HongguoAppApi {
    private static final String BASE = "https://api5-normal-sinfonlineb.fqnovel.com";
    private static final String UA = "com.phoenix.read/71532 (Linux; U; Android 9; SM-N9860; "
            + "Build/PQ3A.190705.10241111;tt-ok/3.12.13.20)";
    private static final MediaType JSON = MediaType.parse("application/json; charset=utf-8");

    private final OkHttpClient http;
    private final LinkedHashMap<String, JSONObject> cache = new LinkedHashMap<>(32, 0.75f, true);

    HongguoAppApi(OkHttpClient http) { this.http = http; }

    /** 独立使用场景（如 MainActivity 注入 vids）：自建客户端。 */
    HongguoAppApi() { this(new OkHttpClient()); }

    /** 取一部剧的官方系列信息；失败返回 null（调用方降级为不分组）。内存缓存避免重复请求。 */
    JSONObject fetch(String seriesId) {
        if (seriesId == null || !seriesId.matches("[0-9]{1,30}")) return null;
        synchronized (cache) {
            JSONObject hit = cache.get(seriesId);
            if (hit != null) return hit;
        }
        try {
            JSONObject result = doFetch(seriesId);
            if (result == null) return null;
            synchronized (cache) {
                cache.put(seriesId, result);
                while (cache.size() > 256) {
                    String oldest = cache.keySet().iterator().next();
                    cache.remove(oldest);
                }
            }
            return result;
        } catch (Exception ignored) { return null; }
    }

    private JSONObject doFetch(String seriesId) throws Exception {
        // 固定设备参数（hongguo-dl 同款）：无签名接口依赖这些参数，每次请求只变 _rticket
        Map<String, String> params = new TreeMap<>();
        params.put("klink_egdi", "AAI29o4dI-eMiO73_SRSbZ_0By1v3fUSriNeu8-L951MoXhWT88pzj5B");
        params.put("iid", "3788260546453235"); params.put("device_id", "538083340353620");
        params.put("ac", "wifi"); params.put("channel", "oppo_8662_64"); params.put("aid", "8662");
        params.put("app_name", "novelread"); params.put("version_code", "71532");
        params.put("version_name", "7.1.5.32"); params.put("device_platform", "android");
        params.put("os", "android"); params.put("ssmix", "a"); params.put("device_type", "SM-N9860");
        params.put("device_brand", "Samsung"); params.put("language", "zh"); params.put("os_api", "28");
        params.put("os_version", "9"); params.put("manifest_version_code", "71532");
        params.put("resolution", "900*1600"); params.put("dpi", "320"); params.put("update_version_code", "71532");
        params.put("host_abi", "arm64-v8a"); params.put("dragon_device_type", "pad"); params.put("pv_player", "71532");
        params.put("compliance_status", "0"); params.put("need_personal_recommend", "1");
        params.put("player_so_load", "1"); params.put("is_android_pad_screen", "0");
        params.put("rom_version", "PQ3A.190705.10241111+release-keys");
        params.put("cdid", "b4f93387-5319-4134-aab9-2cd4e9279b8f");
        params.put("_rticket", String.valueOf(System.currentTimeMillis()));
        String rawQuery = goEncode(params);
        byte[] body = ("{\"series_id\":\"" + seriesId + "\"}").getBytes(StandardCharsets.UTF_8);
        Request.Builder rb = new Request.Builder()
                .url(BASE + "/novel/player/video_detail/v1/?" + rawQuery)
                .post(RequestBody.create(JSON, body))
                .header("User-Agent", UA)
                .header("Accept", "application/json");
        // 注意：不要手动设 Accept-Encoding: gzip——okhttp 只有在未显式设置时才会自动解压 gzip 响应。
        try (Response response = http.newCall(rb.build()).execute()) {
            if (!response.isSuccessful() || response.body() == null) return null;
            JSONObject json = new JSONObject(response.body().string());
            JSONObject data = json.optJSONObject("data");
            JSONObject video = data == null ? null : data.optJSONObject("video_data");
            if (video == null) return null;
            // 解析每集 vid（vids[i] = 第 i+1 集），供 NAS 下载任务直推，绕开 NAS 端签名取流被风控
            JSONArray list = video.optJSONArray("video_list");
            JSONArray vids = new JSONArray();
            if (list != null) {
                for (int i = 0; i < list.length(); i++) {
                    JSONObject v = list.optJSONObject(i);
                    if (v != null && v.opt("vid") != null) vids.put(String.valueOf(v.opt("vid")));
                }
            }
            return new JSONObject()
                    .put("album_id", String.valueOf(video.optLong("related_album_id", 0L)))
                    .put("season_index", video.optInt("season_index", 0))
                    .put("episode_cnt", video.optInt("episode_cnt", 0))
                    .put("series_title", video.optString("series_title", ""))
                    // 网页详情 404 时要用这两项拼详情页（网页版才有封面/简介，App 接口里叫这个名字）
                    .put("series_cover", video.optString("series_cover", video.optString("cover_url", "")))
                    .put("series_intro", video.optString("series_intro", video.optString("video_desc", "")))
                    .put("vids", vids);
        }
    }

    /** Go url.Values.Encode()：TreeMap 按键排序 + QueryEscape（空格→+、~ 保留、其余 %XX 大写）。 */
    private static String goEncode(Map<String, String> params) {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : params.entrySet()) {
            if (sb.length() > 0) sb.append('&');
            sb.append(goEscape(e.getKey())).append('=').append(goEscape(e.getValue()));
        }
        return sb.toString();
    }

    private static String goEscape(String s) {
        StringBuilder out = new StringBuilder();
        byte[] bytes = s.getBytes(StandardCharsets.UTF_8);
        for (byte b : bytes) {
            int c = b & 0xff;
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                    || c == '-' || c == '_' || c == '.' || c == '~') out.append((char) c);
            else if (c == ' ') out.append('+');
            else out.append('%').append(String.format(Locale.ROOT, "%02X", c));
        }
        return out.toString();
    }
}
