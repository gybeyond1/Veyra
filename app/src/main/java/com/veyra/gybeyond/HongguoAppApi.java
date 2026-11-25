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
 * 红果 App 的读接口（api5-normal-sinfonlineb.fqnovel.com）。
 *
 * 2026-10-15 变更：签名接口已被红果对第三方静默风控（HTTP 200 空 body），改用无签名 +
 * 固定设备参数（klink_egdi/iid/device_id/cdid…，与 hongguo-dl 同款），video_detail
 * 与 album_detail 这两条读接口到现在（2026-11-25）仍然正常返回。
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

    private JSONObject doFetch(String seriesId) {
        JSONObject body = new JSONObject();
        try {
            body.put("series_id", seriesId);
        } catch (Exception ignored) { return null; }
        JSONObject json = post("/novel/player/video_detail/v1/", body);
        if (json == null) return null;
        try {
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
                    // 「更新至 0 集」这种状态就写在这，详情页拿它当待播提示
                    .put("episode_label", video.optString("episode_right_text", ""))
                    .put("vids", vids);
        } catch (Exception ignored) { return null; }
    }

    /**
     * UGC 合集：个人创作者上传的多集视频。
     *
     * 这类内容在 video_detail 里是个空壳（content_type 1003、episode_cnt 0、
     * video_list 空），照它判断就会被当成「还没上线」；实际上它的分集挂在
     * album_detail 下，album_id 就是搜索结果里给的那个 series_id。
     * 每集的 series_id_str 就是取流用的 vid（合集列表项的 video_list[0].vid 是空的，
     * 真正的 vid 只在 video_detail_data 里出现，所以这里两处都看，拿不到就用 series_id 顶上）。
     */
    JSONObject album(String albumId) {
        if (albumId == null || !albumId.matches("[0-9]{1,30}")) return null;
        JSONObject body = new JSONObject();
        try {
            body.put("album_id", albumId)
                    .put("need_video_detail_info", true)
                    .put("series_ids", new JSONArray())
                    .put("biz_param", new JSONObject().put("video_platform", 3));
        } catch (Exception ignored) { return null; }
        JSONObject json = post("/novel/player/album_detail/v1/", body);
        if (json == null) return null;
        try {
            JSONObject data = json.optJSONObject("data");
            JSONObject album = data == null ? null : data.optJSONObject("album_data");
            if (album == null) return null;
            JSONArray list = album.optJSONArray("video_detail_list");
            if (list == null || list.length() == 0) return null;
            JSONObject details = data.optJSONObject("video_detail_data");
            JSONArray vids = new JSONArray(), titles = new JSONArray();
            for (int i = 0; i < list.length(); i++) {
                JSONObject item = list.optJSONObject(i);
                if (item == null) continue;
                String seriesId = item.optString("series_id_str", "");
                if (seriesId.isEmpty()) {
                    long numeric = item.optLong("series_id", 0L);
                    if (numeric > 0) seriesId = String.valueOf(numeric);
                }
                String vid = "";
                JSONObject one = seriesId.isEmpty() || details == null ? null : details.optJSONObject(seriesId);
                JSONObject video = one == null ? null : one.optJSONObject("video_data");
                JSONArray wl = video == null ? null : video.optJSONArray("video_list");
                JSONObject first = wl == null ? null : wl.optJSONObject(0);
                if (first != null) vid = first.optString("vid", "");
                if (vid.isEmpty()) vid = seriesId;
                if (vid.isEmpty()) continue;
                vids.put(vid);
                titles.put(item.optString("series_title", ""));
            }
            if (vids.length() == 0) return null;
            /* episode_entrance_text 是数组（["合集", 标题, "更新至10集"]），
               挑带「集」的那条当标签，比原样显示一个 JSON 数组好看。 */
            String label = labelWithEpisodeCount(album.optJSONArray("episode_entrance_text"));
            if (label.isEmpty()) label = labelWithEpisodeCount(album.optJSONArray("sub_title_list"));
            if (label.isEmpty()) label = "共 " + vids.length() + " 集";
            return new JSONObject()
                    .put("title", album.optString("title", ""))
                    .put("cover", album.optString("cover", ""))
                    .put("intro", album.optString("intro", ""))
                    .put("label", label)
                    .put("vids", vids)
                    .put("titles", titles);
        } catch (Exception ignored) { return null; }
    }

    /** 从 ["合集", 标题, "更新至10集"] 这种副标题数组里挑出带「集」的那条。 */
    private static String labelWithEpisodeCount(JSONArray list) {
        String picked = "";
        for (int i = 0; list != null && i < list.length(); i++) {
            String text = list.optString(i, "");
            if (text.contains("集")) picked = text;
        }
        return picked;
    }

    /** 无签名接口的固定设备参数（hongguo-dl 同款）：每次请求只变 _rticket。 */
    private static Map<String, String> deviceParams() {
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
        return params;
    }

    /** POST 一个 JSON body；非 2xx 或空正文返回 null（红果风控就是 200 + 空）。 */
    private JSONObject post(String path, JSONObject body) {
        try {
            Request.Builder rb = new Request.Builder()
                    .url(BASE + path + "?" + goEncode(deviceParams()))
                    .post(RequestBody.create(JSON, body.toString().getBytes(StandardCharsets.UTF_8)))
                    .header("User-Agent", UA)
                    .header("Accept", "application/json");
            // 注意：不要手动设 Accept-Encoding: gzip——okhttp 只有在未显式设置时才会自动解压 gzip 响应。
            try (Response response = http.newCall(rb.build()).execute()) {
                if (!response.isSuccessful() || response.body() == null) return null;
                String text = response.body().string();
                return text.isEmpty() ? null : new JSONObject(text);
            }
        } catch (Exception ignored) {
            return null;
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
