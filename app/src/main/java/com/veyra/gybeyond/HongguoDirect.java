package com.veyra.gybeyond;

import android.util.Base64;

import com.hongguotv.core.MediaCrypto;
import com.hongguotv.core.StreamInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * 红果 App 播放取址（2026-11 之后的链路）。
 *
 * 站方换过两次协议，现在只认这一条：
 *   1) 到 log5-applog-lf.fqnovel.com 注册一台匿名设备（ttEncrypt 加密的报文体），
 *      拿到 device_id / install_id / cdid；
 *   2) 用这台设备的身份 + Android v5 签名（{@link HongguoV5}）请求
 *      /novel/player/multi_video_model/player/v1（POST，gzip 正文）。
 *
 * 2026-10-27 之前那套（video_model/v1 + 551 Argus/Ladon）现在一律回
 * HTTP 200 + 空正文；再往前的 8402 签名连 query 都不认。也就是说「能翻能点、
 * 就是播不出来」不是网络问题，是签名版本不对。
 *
 * 身份是一次性的：同一台设备短时间内连续取流会被判重返回空正文，所以失败后
 * 换一台身份再试一次（注册一次约 200~400ms）。
 */
final class HongguoDirect {
    private static final String HOST = "https://api5-normal-sinfonlinea.fqnovel.com";
    private static final String PLAYER_MODEL = HOST + "/novel/player/multi_video_model/player/v1";
    private static final String REGISTER = "https://log5-applog-lf.fqnovel.com/service/2/device_register/"
            + "?tt_data=a&cronet_version=8d40f833_2026-03-03&ttnet_version=4.2.243.31-douyin&use_store_region_cookie=1";
    private static final String REGISTER_UA = "com.phoenix.read/72232 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3)";
    /** 官方播放器的头形态：Android 12 / PGT-AN10，与 v5 签名里的设备描述一致。 */
    private static final String PLAYBACK_UA = "com.phoenix.read/73932 (Linux; U; Android 12; zh_CN_#Hans;"
            + " PGT-AN10; Build/V417IR;tt-ok/3.12.13.20)";
    private static final String VERSION_NAME = "7.4.3.32";
    private static final MediaType JSON = MediaType.get("application/json; charset=UTF-8");
    private static final MediaType OCTET = MediaType.get("application/octet-stream;tt-data=a");
    /** 与 ttEncrypt 同一个盐（客户端协议常量）。 */
    private static final byte[] KDF_SALT = HongguoSign551.hex(
            "4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524"
            + "f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58");
    private static final SecureRandom RANDOM = new SecureRandom();

    private static final OkHttpClient HTTP = new OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(10, TimeUnit.SECONDS)
            .callTimeout(16, TimeUnit.SECONDS)
            .build();

    private HongguoDirect() { }

    /** 注册到的匿名设备身份。 */
    private static final class Device {
        final String deviceId;
        final String iid;
        final String cdid;

        Device(String deviceId, String iid, String cdid) {
            this.deviceId = deviceId;
            this.iid = iid;
            this.cdid = cdid;
        }
    }

    /**
     * 取某集的播放地址。
     *
     * @param vid 分集 id（数字串）
     * @return 直链 + CENC 密钥 + 清晰度
     */
    static StreamInfo fetch(String vid) throws Exception {
        if (vid == null || !vid.matches("[0-9]{1,30}")) throw new IOException("分集编号无效");
        List<String> errors = new ArrayList<>();
        /* 注册失败单独成句，不要和「返回空正文」混在一起，否则实机只看到一个笼统的错。 */
        Device device;
        try {
            device = register();
        } catch (Exception error) {
            throw new IOException("匿名设备注册失败：" + describe(error));
        }
        try {
            StreamInfo info = fetchModel(vid, device);
            if (info != null) return info;
            errors.add("首台设备返回空正文");
        } catch (Exception error) {
            errors.add(describe(error));
        }
        /* 空正文多半是这台匿名身份被判重/风控，换一台再试一次。 */
        try {
            Device fresh = register();
            StreamInfo info = fetchModel(vid, fresh);
            if (info != null) return info;
            errors.add("换设备后仍为空正文");
        } catch (Exception error) {
            errors.add(describe(error));
        }
        throw new IOException("播放接口未返回片源（" + join(errors) + "）");
    }

    private static String describe(Exception error) {
        String text = error.getMessage();
        if (text == null || text.isEmpty()) text = error.getClass().getSimpleName();
        return text;
    }

    private static String join(List<String> parts) {
        StringBuilder sb = new StringBuilder();
        for (String part : parts) {
            if (sb.length() > 0) sb.append("；");
            sb.append(part);
        }
        return sb.toString();
    }

    // ---------------- 匿名设备注册（ttEncrypt） ----------------

    static Device register() throws IOException {
        long now = System.currentTimeMillis();
        String cdid = UUID.randomUUID().toString();
        byte[] body = buildRegisterBody(now, cdid);
        Request request = new Request.Builder()
                .url(REGISTER)
                .post(RequestBody.create(body, OCTET))
                .header("User-Agent", REGISTER_UA)
                .header("Accept", "application/json")
                .header("log-encode-type", "gzip")
                .header("x-ss-dp", "8662")
                .header("x-ss-req-ticket", String.valueOf(now))
                .header("x-vc-bdturing-sdk-version", "4.0.3.cn")
                .header("lc", "101")
                .header("sdk-version", "2")
                .header("passport-sdk-version", "5051452")
                .header("x-neptune", "-8|50:51:59:30:40:47:49:39")
                .header("x-ss-stub", HongguoSign551.hex(HongguoSign551.md5(body)).toUpperCase())
                .build();
        String text = execute(request);
        if (text.isEmpty()) throw new IOException("设备注册返回空正文");
        JSONObject json;
        try {
            json = new JSONObject(text);
        } catch (Exception error) {
            throw new IOException("设备注册响应解析失败");
        }
        String deviceId = responseId(json, "device_id");
        String iid = responseId(json, "install_id");
        if (deviceId.isEmpty() || iid.isEmpty()) throw new IOException("设备注册未返回有效身份");
        return new Device(deviceId, iid, cdid);
    }

    /** 注册响应没有 code 字段：缺省视为成功，只有显式非 0 才算被拒。 */
    private static String responseId(JSONObject json, String name) {
        String preferred = json.optString(name + "_str", "");
        String value = preferred.isEmpty() ? json.optString(name, "") : preferred;
        return value.matches("[0-9]{1,30}") && !value.matches("0+") ? value : "";
    }

    private static byte[] buildRegisterBody(long now, String cdid) throws IOException {
        JSONObject header = new JSONObject();
        try {
            header.put("display_name", "红果免费短剧");
            header.put("update_version_code", 73932);
            header.put("manifest_version_code", 73932);
            header.put("app_version_minor", "7.3.9.32");
            header.put("aid", 8662);
            header.put("channel", "update_64");
            header.put("package", "com.phoenix.read");
            header.put("app_version", "7.3.9.32");
            header.put("version_code", 73932);
            header.put("sdk_version", "3.7.0-rc.34-fanqie-xiaoshuo");
            header.put("sdk_target_version", 29);
            header.put("git_hash", "3a88f4e");
            header.put("os", "Android");
            header.put("os_version", "16");
            header.put("os_api", 36);
            header.put("device_model", "25053RT47C");
            header.put("device_brand", "Redmi");
            header.put("device_manufacturer", "Redmi");
            header.put("cpu_abi", "arm64-v8a");
            header.put("release_build", "b5e187f");
            header.put("density_dpi", 520);
            header.put("display_density", "mdpi");
            header.put("resolution", "1280x2772");
            header.put("language", "zh");
            header.put("timezone", 8);
            header.put("access", "wifi");
            header.put("not_request_sender", 0);
            header.put("carrier", "CHINA MOBILE");
            header.put("mcc_mnc", "46000");
            header.put("rom", "eng.root.20231116.160340");
            header.put("rom_version", "W528JS release-keys");
            header.put("cdid", cdid);
            header.put("sig_hash", "56a962410c494bbaf0b58dba20cae56f");
            header.put("openudid", HongguoSign551.hex(randomBytes(8)));
            header.put("clientudid", UUID.randomUUID().toString());
            header.put("ipv6_list", new JSONArray());
            header.put("region", "CN");
            header.put("tz_name", "Asia/Shanghai");
            header.put("tz_offset", 28800);
            header.put("sim_region", "cn");
            header.put("sim_serial_number", new JSONArray());
            header.put("oaid_may_support", false);
            header.put("req_id", UUID.randomUUID().toString());
            header.put("device_platform", "android");
            JSONObject custom = new JSONObject();
            custom.put("account_region_src", "fallback");
            custom.put("account_region", "cn");
            custom.put("host_bit", 64);
            custom.put("dragon_device_type", "phone");
            header.put("custom", custom);
            header.put("pre_installed_channel", "");
            header.put("apk_first_install_time", now);
            header.put("is_system_app", 0);
            header.put("sdk_flavor", "china");
            header.put("guest_mode", 0);
        } catch (Exception error) {
            throw new IOException("注册报文构造失败", error);
        }
        JSONObject payload = new JSONObject();
        try {
            payload.put("magic_tag", "ss_app_log");
            payload.put("header", header);
            payload.put("_gen_time", now);
        } catch (Exception error) {
            throw new IOException("注册报文构造失败", error);
        }
        byte[] compressed = gzip(payload.toString().getBytes(StandardCharsets.UTF_8));
        byte[] random = randomBytes(32);
        byte[] derived = HongguoSign551.sha512(HongguoSign551.concat(HongguoSign551.sha512(random), KDF_SALT));
        byte[] key = new byte[16];
        byte[] iv = new byte[16];
        System.arraycopy(derived, 0, key, 0, 16);
        System.arraycopy(derived, 16, iv, 0, 16);
        byte[] plain = HongguoSign551.concat(HongguoSign551.sha512(compressed), compressed);
        byte[] head = HongguoSign551.hex("746305100000");
        /* ttEncrypt 的正文是 PKCS#7 补齐后再 AES-CBC；漏了这步会直接抛块对齐异常。 */
        byte[] sealed = HongguoSign551.aesCbc(HongguoSign551.pad16(plain), key, iv);
        return HongguoSign551.concat(HongguoSign551.concat(head, random), sealed);
    }

    private static byte[] randomBytes(int size) {
        byte[] out = new byte[size];
        RANDOM.nextBytes(out);
        return out;
    }

    private static byte[] gzip(byte[] data) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        try (GZIPOutputStream gzip = new GZIPOutputStream(buffer)) {
            gzip.write(data);
        }
        return buffer.toByteArray();
    }

    private static byte[] gunzip(byte[] data) {
        try (GZIPInputStream gzip = new GZIPInputStream(new ByteArrayInputStream(data))) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int count;
            while ((count = gzip.read(chunk)) > 0) out.write(chunk, 0, count);
            return out.toByteArray();
        } catch (Exception error) {
            return data;
        }
    }

    // ---------------- 取址请求 ----------------

    /** v5 取址：注册身份 + v5 签名 + gzip 正文，单次请求。 */
    private static StreamInfo fetchModel(String vid, Device device) throws Exception {
        long now = System.currentTimeMillis();
        LinkedHashMap<String, String> values = new LinkedHashMap<>();
        values.put("aid", "8662");
        values.put("app_name", "novelread");
        values.put("version_code", "74332");
        values.put("version_name", VERSION_NAME);
        values.put("channel", "vivo_8662_64");
        values.put("device_platform", "android");
        values.put("device_type", "PGT-AN10");
        values.put("os_version", "12");
        values.put("update_version_code", "74332");
        values.put("iid", device.iid);
        values.put("cdid", device.cdid);
        values.put("device_id", device.deviceId);
        values.put("_rticket", String.valueOf(now));

        String payload = "{\"biz_param\":{\"detail_page_version\":0,\"device_level\":3,"
                + "\"disable_digg_stat\":false,\"disable_video_relate_book\":false,"
                + "\"need_all_video_definition\":true,\"need_mp4_align\":false,"
                + "\"use_os_player\":false,\"use_server_dns\":false,\"video_platform\":1024},"
                + "\"mixed_video_id_map\":{\"1004\":[\"" + vid + "\"]},\"dr_scene\":\"player\"}";
        byte[] body = gzip(payload.getBytes(StandardCharsets.UTF_8));

        HongguoV5.Signed signed = HongguoV5.signPlayback(PLAYER_MODEL, values, body, now);
        Request.Builder builder = new Request.Builder()
                .url(signed.url)
                .header("User-Agent", PLAYBACK_UA)
                .header("Accept", "application/json")
                .header("Content-Encoding", "gzip")
                .header("x-ss-stub", HongguoV5.hexText(HongguoV5.md5(body)).toUpperCase());
        for (Map.Entry<String, String> entry : signed.headers.entrySet()) {
            builder.header(entry.getKey(), entry.getValue());
        }
        return parse(execute(builder.post(RequestBody.create(body, JSON)).build()), vid);
    }

    /** 执行请求并返回正文；空正文原样返回空串，由调用方判断。 */
    private static String execute(Request request) throws IOException {
        try (Response response = HTTP.newCall(request).execute()) {
            if (response.body() == null) return "";
            byte[] raw = response.body().bytes();
            String encoding = response.header("Content-Encoding", "");
            if (encoding.contains("gzip")) raw = gunzip(raw);
            if (!response.isSuccessful()) {
                throw new IOException("HTTP " + response.code());
            }
            return new String(raw, StandardCharsets.UTF_8);
        }
    }

    // ---------------- 响应解析 ----------------

    private static StreamInfo parse(String text, String vid) throws IOException {
        if (text == null || text.trim().isEmpty()) return null;   // 空正文：上层换身份重试
        JSONObject json;
        try {
            json = new JSONObject(text);
        } catch (Exception error) {
            throw new IOException("接口返回格式异常");
        }
        int code = json.optInt("code", json.optInt("Code", 0));
        if (code != 0) throw new IOException("接口拒绝 code=" + code);
        JSONObject data = json.optJSONObject("data");
        if (data == null) return null;
        /* v5 把分集挂在 data["1004"][vid] 下；旧响应是 data[video_model_data][vid] 或直接 data[vid]。 */
        JSONObject entries = data.optJSONObject("1004");
        if (entries == null) entries = data.optJSONObject("video_model_data");
        if (entries == null) entries = data;
        JSONObject entry = entries.optJSONObject(vid);
        if (entry == null) return null;
        JSONObject model = asObject(entry.opt("video_model"));
        if (model == null) return null;

        JSONObject source = model;
        Object inline = model.opt("video_list");
        boolean hasInline = (inline instanceof JSONArray && ((JSONArray) inline).length() > 0)
                || (inline instanceof JSONObject && ((JSONObject) inline).length() > 0);
        if (!hasInline) {
            // 部分分集把片源藏在 fallback_api 指到的第二个地址里
            String fallback = model.optString("fallback_api", "");
            if (fallback.isEmpty()) return null;
            JSONObject outer;
            try {
                outer = new JSONObject(execute(new Request.Builder()
                        .url(fallback).header("User-Agent", PLAYBACK_UA).build()));
            } catch (Exception error) {
                throw new IOException("片源二次请求失败");
            }
            JSONObject info = outer.optJSONObject("video_info");
            if (info == null) return null;
            if (outer.optInt("Code", 0) != 0 || info.optInt("Code", 0) != 0) return null;
            source = info.optJSONObject("data");
            if (source == null) return null;
        }

        byte[] seed = null;
        String seedText = model.optString("key_seed", source.optString("key_seed", ""));
        if (!seedText.isEmpty()) {
            try { seed = Base64.decode(seedText, Base64.DEFAULT); } catch (Exception ignored) { }
        }

        List<JSONObject> rows = new ArrayList<>();
        Object list = source.opt("video_list");
        if (list instanceof JSONArray) {
            JSONArray array = (JSONArray) list;
            for (int i = 0; i < array.length(); i++) {
                JSONObject row = array.optJSONObject(i);
                if (row != null) rows.add(row);
            }
        } else if (list instanceof JSONObject) {
            JSONObject map = (JSONObject) list;
            Iterator<String> keys = map.keys();
            while (keys.hasNext()) {
                JSONObject row = map.optJSONObject(keys.next());
                if (row != null) rows.add(row);
            }
        }
        if (rows.isEmpty()) return null;

        JSONObject best = null;
        int bestScore = -1;
        for (JSONObject row : rows) {
            JSONObject meta = row.optJSONObject("video_meta");
            String codec = row.optString("codec_type",
                    meta == null ? "" : meta.optString("codec_type", "")).toLowerCase();
            if (codec.contains("bytevc2") || codec.contains("h266") || codec.contains("vvc")) continue;
            int height = meta == null ? 0 : meta.optInt("vheight", 0);
            if (height <= 0 && meta != null) height = meta.optInt("vwidth", 0);
            if (height <= 0) height = row.optInt("vheight", row.optInt("height", 0));
            int score = height * 10 + (codec.equals("h264") || codec.equals("avc") || codec.equals("avc1") ? 1 : 0);
            if (score > bestScore) { bestScore = score; best = row; }
        }
        if (best == null) return null;

        String url = firstUrl(best);
        if (url == null) return null;
        if (seed != null) {
            try { url = MediaCrypto.INSTANCE.decryptUrl(url, seed); } catch (Exception ignored) { }
        }
        String spade = best.optString("spade_a", "");
        if (spade.isEmpty()) {
            JSONObject encrypt = best.optJSONObject("encrypt_info");
            if (encrypt != null) spade = encrypt.optString("spade_a", "");
        }
        byte[] key = null;
        if (!spade.isEmpty()) {
            try { key = MediaCrypto.INSTANCE.deriveKey(spade); } catch (Exception ignored) { }
        }
        JSONObject meta = best.optJSONObject("video_meta");
        String quality = meta == null ? "" : meta.optString("definition", "");
        if (quality.isEmpty()) quality = best.optString("definition", "");
        String number = quality.replaceAll("[^0-9]", "");
        if (number.isEmpty() && meta != null) number = String.valueOf(meta.optInt("vheight", 0));
        return new StreamInfo(url, key, number);
    }

    /** video_model 有时是对象，有时是被序列化过一次的 JSON 字符串。 */
    private static JSONObject asObject(Object value) {
        if (value instanceof JSONObject) return (JSONObject) value;
        if (value instanceof String) {
            String text = ((String) value).trim();
            if (!text.startsWith("{")) {
                try { text = new String(Base64.decode(text, Base64.DEFAULT), StandardCharsets.UTF_8); }
                catch (Exception ignored) { }
            }
            try { return new JSONObject(text); } catch (Exception ignored) { return null; }
        }
        return null;
    }

    private static String firstUrl(JSONObject row) {
        String main = row.optString("main_url", "");
        if (main.startsWith("http")) return main;
        if (!main.isEmpty()) {
            try {
                String decoded = new String(Base64.decode(main, Base64.DEFAULT), StandardCharsets.UTF_8).trim();
                if (decoded.startsWith("http")) return decoded;
            } catch (Exception ignored) { }
        }
        String backup = row.optString("backup_url", "");
        if (backup.startsWith("http")) return backup;
        JSONArray list = row.optJSONArray("backup_url_list");
        if (list != null) {
            for (int i = 0; i < list.length(); i++) {
                String item = list.optString(i, "");
                if (item.startsWith("http")) return item;
            }
        }
        return null;
    }
}
