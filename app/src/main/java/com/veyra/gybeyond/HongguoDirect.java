package com.veyra.gybeyond;

import android.content.Context;
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
 * 身份不再是一次性的：2026-11-20 起，站方对「刚注册就立刻取址的新设备」判得极严，
 * 每集都新注册一台再取址，大概率两台都拿到空正文 —— 这正是「播不了」的真正原因，
 * 不是用户网络。现在改成注册一台、落盘、长期复用（7 天），只有设备真的被拒才换；
 * 空正文时先在同一个身份上重试，再考虑换身份，并且连续全空后冷却几秒，
 * 避免把身份和出口 IP 一起打废。
 *
 * 近期成功过的地址也会留一份：确认还在有效期内时，空正文可以直接复用，
 * 不必再向上游要一次（重播同一集、退出再进都走这条）。
 *
 * 2026-11-23：站方把 device_level=3 的响应收窄成「只给 bytevc2 / 直接空正文」。
 * 改为 level 1 协商兼容档位，并补两层备用：video_tab GET（v5 签名 + 空字节摘要）
 * 与 b 域主接口 —— 取址链与 hongguoTV 0.16.13 对齐。
 */
final class HongguoDirect {
    /** 取址节点：a 不通/空正文时换 b，签名的 medusa 是按完整 URL 算的，换节点会重新签。 */
    private static final String[] HOSTS = {
            "https://api5-normal-sinfonlinea.fqnovel.com",
            "https://api5-normal-sinfonlineb.fqnovel.com",
    };
    private static final String PLAYER_PATH = "/novel/player/multi_video_model/player/v1";
    /** 备用取址：主接口空正文时，这条 GET 仍在服务。 */
    private static final String TAB_PATH = "/reading/bookapi/video_tab/multi_video_model/v1/";
    private static final String REGISTER = "https://log5-applog-lf.fqnovel.com/service/2/device_register/"
            + "?tt_data=a&cronet_version=8d40f833_2026-03-03&ttnet_version=4.2.243.31-douyin&use_store_region_cookie=1";
    private static final String REGISTER_UA = "com.phoenix.read/72232 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3)";
    /** 官方播放器的头形态：74532 / 25053RT47C，与 v5 签名里的设备描述一致。 */
    private static final String PLAYBACK_UA = "com.phoenix.read/74532 (Linux; U; Android 16; zh_CN; 25053RT47C;"
            + " Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)";
    /** video_tab 只认这台机型的头（与 hongguoTV 0.16.12 实网验证一致）。 */
    private static final String TAB_UA = "com.phoenix.read/73932 (Linux; U; Android 16; zh_CN; 25053RT47C;"
            + " Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)";
    /**
     * 2026-11-27：站方按 App 版本过滤，74332 的请求即使签名完全正确也只回 200 + 0 字节。
     * 74532 是当前线上版本，同样的 medusa 能正常返回模型（29 集样本实测）。
     */
    private static final String VERSION_NAME = "7.4.5.32";
    /**
     * 3 是官方 App 的档位，只下发 bytevc2（手机/TV 的 MediaCodec 都解不了），
     * 部分分集干脆回空正文。1 才是「协商兼容档位」，会正常给 h264/hevc。
     */
    private static final int PLAYER_LEVEL = 1;
    /** 74532 profile 的取模档位：4 = 官方客户端档，实测 1080p HEVC。 */
    private static final int MODEL_LEVEL = 4;
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
    /** 激活检查只是「让设备看起来被用过」，不能拖慢注册。 */
    private static final OkHttpClient QUICK = HTTP.newBuilder()
            .callTimeout(2, TimeUnit.SECONDS)
            .build();

    private HongguoDirect() { }

    // ---------------- 身份：落盘复用 ----------------

    private static final String PREFS = "hongguo-identity";
    private static final String KEY_DEVICE = "device_id";
    private static final String KEY_IID = "iid";
    private static final String KEY_CDID = "cdid";
    private static final String KEY_SAVED_AT = "saved_at";
    /** 最近一次真的取到地址的分集，只给「链路检测」选样例用。 */
    private static final String KEY_LAST_VID = "last_vid_ok";
    private static volatile String lastPersistedVid = "";
    /** 一台设备用一周。上游真正作废时会回 401/403，那时再换。 */
    private static final long IDENTITY_TTL_MS = 7L * 24 * 3600 * 1000;
    /** 连续全空之后静默几秒：这时候再请求只会让风控判得更死。 */
    private static final long EMPTY_COOLDOWN_MS = 6000L;
    /** 主接口近期整片空时，下一集先走 video_tab：省掉两次必然失败的主接口请求。 */
    private static final long PRIMARY_EMPTY_TTL_MS = 90_000L;
    private static volatile long primaryEmptyAt;
    private static final long RETRY_GAP_MS = 500L;
    /** 近期成功地址的保留时间，用于空正文时兜底复用。 */
    private static final long RECENT_TTL_MS = 30L * 60 * 1000;

    private static volatile Context appContext;
    private static Device cached;
    private static long cachedAt;
    private static volatile long lastAllEmptyAt;
    private static int consecutiveEmpty;

    private static final Map<String, Object[]> RECENT = new java.util.concurrent.ConcurrentHashMap<>();
    /** 最近一次取址的形态（状态码/正文长度），只进错误文案，不含地址与凭据。 */
    private static final ThreadLocal<String> LAST_PROBE = new ThreadLocal<>();
    /** 后端这次失败的原因（HTTP 码 / 空正文 / 后端自述的路由结果），单独记，避免和本地的混在一起。 */
    private static final ThreadLocal<String> BACKEND_NOTE = new ThreadLocal<>();

    static void init(Context context) {
        appContext = context == null ? null : context.getApplicationContext();
        synchronized (HongguoDirect.class) {
            if (cached == null) {
                cached = loadIdentity();
                if (cached != null) cachedAt = savedAt();
            }
        }
    }

    /** 应用上下文：详情兜底问后端时要用它读服务器地址。 */
    static Context context() { return appContext; }

    private static synchronized Device loadIdentity() {
        if (appContext == null) return null;
        try {
            android.content.SharedPreferences prefs =
                    appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String deviceId = prefs.getString(KEY_DEVICE, "");
            String iid = prefs.getString(KEY_IID, "");
            String cdid = prefs.getString(KEY_CDID, "");
            if (deviceId == null || iid == null || !deviceId.matches("[0-9]{1,30}") || !iid.matches("[0-9]{1,30}"))
                return null;
            if (System.currentTimeMillis() - prefs.getLong(KEY_SAVED_AT, 0L) >= IDENTITY_TTL_MS) return null;
            return new Device(deviceId, iid, cdid == null ? "" : cdid);
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static synchronized long savedAt() {
        if (appContext == null) return 0L;
        try {
            return appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(KEY_SAVED_AT, 0L);
        } catch (Throwable ignored) {
            return 0L;
        }
    }

    private static synchronized void persist(Device device) {
        cached = device;
        cachedAt = System.currentTimeMillis();
        if (appContext == null) return;
        try {
            appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putString(KEY_DEVICE, device.deviceId)
                    .putString(KEY_IID, device.iid)
                    .putString(KEY_CDID, device.cdid)
                    .putLong(KEY_SAVED_AT, cachedAt)
                    .apply();
        } catch (Throwable ignored) {
        }
    }

    /** 现用身份；没有或过期的注册一台并落盘。内容接口（搜索/详情）共用同一台。 */
    static synchronized Device identity() throws IOException {
        long now = System.currentTimeMillis();
        if (cached != null && now - cachedAt < IDENTITY_TTL_MS) return cached;
        Device fresh = register();
        persist(fresh);
        return fresh;
    }

    /** 设备被明确拒绝时才调用：清掉持久身份，下一轮重新注册。 */
    private static synchronized void dropIdentity() {
        cached = null;
        cachedAt = 0L;
        if (appContext == null) return;
        try {
            appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
        } catch (Throwable ignored) {
        }
    }

    /** 注册到的匿名设备身份。 */
    static final class Device {
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
        return fetch(vid, false, false);
    }

    /**
     * @param background 详情页预热走的取址。失败不设冷却、不换身份、不重试 ——
     *                   预热把请求打光了，用户真正点播放时反而只能吃「稍后再试」。
     */
    static StreamInfo fetch(String vid, boolean background) throws Exception {
        return fetch(vid, background, false);
    }

    /**
     * @param album 这一集属于 UGC 合集（个人创作者上传的多集视频）。
     *              这类分集要后端按 PUGC 分组（1001）取址，按普通短剧语义只会回空。
     */
    static StreamInfo fetch(String vid, boolean background, boolean album) throws Exception {
        if (vid == null || !vid.matches("[0-9]{1,30}")) throw new IOException("分集编号无效");

        /* 刚刚连续吃空正文：现在再打只会让上游把身份和出口 IP 一起判死，
           直接告诉用户几秒后再点，比硬撞更容易恢复。 */
        long cooling = lastAllEmptyAt;
        if (cooling > 0 && System.currentTimeMillis() - cooling < EMPTY_COOLDOWN_MS) {
            if (background) throw new IOException("上游刚返回空片源，跳过预热");
            /* 上游刚空，本地这套签名注定拿不到；冷却期内先问后端（walk 真实 so 签名）。 */
            StreamInfo remoteCooling = fetchFromBackend(vid, album);
            if (remoteCooling != null) {
                lastAllEmptyAt = 0L;
                consecutiveEmpty = 0;
                remember(vid, remoteCooling);
                return remoteCooling;
            }
            long wait = Math.max(1, (EMPTY_COOLDOWN_MS - (System.currentTimeMillis() - cooling) + 999) / 1000);
            String coolingNote = BACKEND_NOTE.get();
            throw new IOException("上游刚连续返回空片源，请 " + wait + " 秒后再试"
                    + (coolingNote == null ? "" : "（后端 " + coolingNote + "）"));
        }

        List<String> errors = new ArrayList<>();
        Device device;
        try {
            device = identity();
        } catch (Exception error) {
            throw new IOException("匿名设备注册失败：" + describe(error));
        }

        /* 同一身份先重试一次。空正文大多是瞬时判定，同一台设备隔半秒再问一次
           往往就有 —— 立刻换新设备反而两台一起判，这是之前最常见的失败形态。 */
        int attempts = background ? 1 : 2;
        for (int attempt = 0; attempt < attempts; attempt++) {
            try {
                /* 三层取址（对齐 hongguoTV 0.16.12/0.16.13）：
                   1) 主接口 player/v1（level 1，协商兼容档位）；
                   2) 主接口空正文 → video_tab GET（同样要 v5 签名）；
                   3) 仍只有 bytevc2 / 无档位 → 换 b 域主接口再问一次。
                   预热只打第一层，别把请求预算烧光。
                   主接口刚整片空过就先走第 2 层：省两次注定空的请求，也少一次风控暴露。 */
                boolean preferTab = !background
                        && System.currentTimeMillis() - primaryEmptyAt < PRIMARY_EMPTY_TTL_MS;
                StreamInfo info = preferTab ? null : fetchModel(vid, device, album);
                if (info == null && !background) {
                    if (!preferTab) primaryEmptyAt = System.currentTimeMillis();
                    /* 备用层各自兜住异常：tab 打不通不能把「换 b 域」这条也一起掐死。 */
                    try {
                        info = fetchTab(vid, device);
                    } catch (Exception tabError) {
                        errors.add("备用 video_tab：" + describe(tabError));
                    }
                }
                if (info == null && !background && preferTab) {
                    /* 刚才只是「近期主接口空」，仍要给它一次机会：可能已经恢复。 */
                    try {
                        info = fetchModel(vid, device, album);
                    } catch (Exception primaryError) {
                        errors.add("主接口重试：" + describe(primaryError));
                    }
                }
                if (info == null && !background) {
                    try {
                        info = fetchModelFrom(HOSTS[1], vid, device, album);
                    } catch (Exception altError) {
                        errors.add("备用域名：" + describe(altError));
                    }
                }
                if (info != null) {
                    lastAllEmptyAt = 0L;
                    consecutiveEmpty = 0;
                    remember(vid, info);
                    return info;
                }
                String probe = LAST_PROBE.get();
                errors.add((attempt == 0 ? "首轮三层均为空片源" : "同一身份重试仍为空片源")
                        + (probe == null ? "" : "[" + probe + "]"));
            } catch (Exception error) {
                errors.add(describe(error));
            }
            if (attempt + 1 < attempts) pause(RETRY_GAP_MS);
        }
        if (background) throw new IOException("播放接口未返回片源（" + join(errors) + "）");

        /* 同一身份两次都空：先冷却，不再当场注册新设备。
           以前失败一次就换一台，用户点两下就是四台「刚出生就取址」的设备，
           上游看出来之后连老设备一起拒 —— 越修越坏就是这么来的。
           连续三轮全空才算这台设备真的废了，标记掉，下一轮重新注册。 */
        lastAllEmptyAt = System.currentTimeMillis();
        if (++consecutiveEmpty >= 3) dropIdentity();

        /* 本地三层全空：交给 Veyra 后端兜底。
           2026-11-27 起本地签名已能取到模型（74532 profile + 完整设备信封），
           正常情况下走不到这里；只有上游临时封禁 / 出口 IP 被限流时才靠后端。 */
        StreamInfo remote = fetchFromBackend(vid, album);
        if (remote != null) {
            lastAllEmptyAt = 0L;
            consecutiveEmpty = 0;
            remember(vid, remote);
            return remote;
        }

        String backendNote = BACKEND_NOTE.get();
        if (backendNote != null) errors.add("后端 " + backendNote);

        /* 兜底：这一集最近成功播过，地址还在有效期内，就直接复用
           （hongguoTV 0.16.11 的同一做法：新请求只用来验证，不为拿地址再撞一次接口）。 */
        StreamInfo recent = recall(vid);
        if (recent != null) return recent;


        throw new IOException("播放接口未返回片源（" + join(errors) + "）");
    }

    /**
     * 兜底取址：问 Veyra 后端要直链与内容密钥。
     *
     * 正常顺序是本地签名优先（74532 profile + 完整设备信封，实测 1080p bytevc1 可取）。
     * 只有在本地三层全空、或本地刚被上游连续判空时才走这里：
     * 后端的取流二进制跑在 NAS 出口上，和手机的 IP / 设备画像不同，
     * 本地被限流时它往往还能拿到地址。后端没配、连不上或返回异常都返回 null，
     * 不改变原有失败文案。
     */
    private static StreamInfo fetchFromBackend(String vid, boolean album) {
        if (appContext == null) return null;
        String base;
        try {
            base = ServerConfig.get(appContext);
        } catch (Throwable ignored) {
            return null;
        }
        if (base == null || base.trim().isEmpty()) return null;
        String endpoint = base.trim().replaceAll("/+$", "") + "/api/hongguo/play-direct?vid=" + vid + (album ? "&album=1" : "");
        BACKEND_NOTE.remove();
        StreamInfo info = backendStream(QUICK, endpoint);
        if (info == null) info = backendStream(HTTP, endpoint);
        return info;
    }

    private static StreamInfo backendStream(OkHttpClient client, String endpoint) {
        try {
            Request request = new Request.Builder()
                    .url(endpoint)
                    .header("Accept", "application/json")
                    .get()
                    .build();
            try (Response response = client.newCall(request).execute()) {
                if (!response.isSuccessful() || response.body() == null) {
                    LAST_PROBE.set("backend/HTTP " + response.code());
                    BACKEND_NOTE.set("HTTP " + response.code());
                    return null;
                }
                String text = new String(response.body().bytes(), StandardCharsets.UTF_8);
                if (text.trim().isEmpty()) {
                    LAST_PROBE.set("backend/200-0B");
                    BACKEND_NOTE.set("200 空正文");
                    return null;
                }
                JSONObject json = new JSONObject(text);
                String main = json.optString("main_url", "");
                if (main.isEmpty()) {
                    /* 后端的错误文案比本地这三层有用得多：它知道自己是哪条路由空的
                       （V5/1001、播放器入口、旧接口），会写在 error 字段里。 */
                    String error = json.optString("error", "");
                    LAST_PROBE.set("backend/" + (error.isEmpty() ? "无直链" : clip(error)));
                    BACKEND_NOTE.set(error.isEmpty() ? "返回里没有直链" : clip(error));
                    return null;
                }
                JSONObject encrypt = json.optJSONObject("encrypt");
                String hexKey = encrypt == null ? "" : encrypt.optString("key", "");
                /* encrypt 为 null 是合法返回：UGC 合集与部分片源是明文 mp4，没有 CENC 密钥。
                   以前这里一律要求 32~64 位 hex，明文流被当成「后端没给密钥」丢掉 ——
                   表现就是普通短剧能播、个人创作者上传的合集一集都播不了。
                   MediaCrypto 对 key=null 本来就是明文直通（prepare/decrypt 都直接返回原数据）。 */
                byte[] key = null;
                if (encrypt != null) {
                    if (!hexKey.matches("[0-9a-fA-F]{32,64}")) {
                        LAST_PROBE.set("backend/缺密钥");
                        BACKEND_NOTE.set("返回里没有内容密钥");
                        return null;
                    }
                    key = HongguoSign551.hex(hexKey);
                }
                return new StreamInfo(main, key, json.optString("definition", ""));
            }
        } catch (Throwable error) {
            LAST_PROBE.set("backend/不可达");
            BACKEND_NOTE.set("连不上（服务器地址填错 / 后端没起来）");
            return null;
        }
    }

    /** 后端错误文案截断：气泡里放不下整段，取前 60 个字够定位。 */
    private static String clip(String text) {
        String one = text.replace('\n', ' ').trim();
        return one.length() <= 60 ? one : one.substring(0, 60) + "…";
    }

    private static void pause(long millis) throws IOException {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IOException("取址被取消");
        }
    }

    // ---------------- 近期地址（空正文时复用） ----------------

    private static void remember(String vid, StreamInfo info) {
        if (vid == null || info == null || info.getUrl() == null) return;
        RECENT.put(vid, new Object[]{info, System.currentTimeMillis()});
        /* 顺手记下最近一次真的取到地址的分集：诊断拿它当样例最可靠 ——
           用它测出来的结果才代表「用户正在看的这批内容能不能播」。 */
        if (appContext != null && !vid.equals(lastPersistedVid)) {
            lastPersistedVid = vid;
            try {
                appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                        .edit().putString(KEY_LAST_VID, vid).apply();
            } catch (Throwable ignored) {
                // 落盘失败不影响取址
            }
        }
        if (RECENT.size() > 12) {
            String oldest = null;
            long oldestAt = Long.MAX_VALUE;
            for (Map.Entry<String, Object[]> entry : RECENT.entrySet()) {
                long at = (Long) entry.getValue()[1];
                if (at < oldestAt) { oldestAt = at; oldest = entry.getKey(); }
            }
            if (oldest != null && !oldest.equals(vid)) RECENT.remove(oldest);
        }
    }

    /** 近期地址还能用吗：一次 1 字节的 Range 请求，200/206 且拿得到字节才算数。 */
    private static StreamInfo recall(String vid) {
        Object[] row = RECENT.get(vid);
        if (row == null) return null;
        long age = System.currentTimeMillis() - (Long) row[1];
        if (age < 0 || age > RECENT_TTL_MS) { RECENT.remove(vid); return null; }
        StreamInfo info = (StreamInfo) row[0];
        try {
            Request request = new Request.Builder()
                    .url(info.getUrl())
                    .header("User-Agent", PLAYBACK_UA)
                    .header("Referer", "https://novel.snssdk.com/")
                    .header("Range", "bytes=0-0")
                    .build();
            try (Response response = HTTP.newCall(request).execute()) {
                if (response.code() != 200 && response.code() != 206) {
                    RECENT.remove(vid);
                    return null;
                }
                if (response.body() != null) response.body().close();
            }
            return info;
        } catch (Exception error) {
            return null;
        }
    }

    // ---------------- 链路诊断（设置页「链路检测」用） ----------------

    /** 诊断样例：优先挑一台最近真的取到过地址的分集，没有就用内置样例。 */
    private static final String SAMPLE_VID = "7704580168144129086";

    static String diagnoseVid() {
        for (Map.Entry<String, Object[]> entry : RECENT.entrySet()) {
            Object[] row = entry.getValue();
            if (row != null && row[0] != null) return entry.getKey();
        }
        // 进程刚起来时 RECENT 是空的，读上一次真正取到地址的分集（比内置样例可靠）
        if (appContext != null) {
            try {
                String saved = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                        .getString(KEY_LAST_VID, "");
                if (saved != null && saved.matches("[0-9]{1,30}")) return saved;
            } catch (Throwable ignored) {
                // 读不到就用样例
            }
        }
        return SAMPLE_VID;
    }

    /**
     * 逐层测本地取址链路，并把第一层拿到的地址顺手探一下 CDN。
     *
     * 跟 {@link #fetch(String)} 的区别：不读近期地址缓存、不写冷却、不做多轮重试 ——
     * 诊断要回答的是「此刻这一层通不通、花了多久」，不是「最终能不能拿到地址」。
     * 三层各打一次，不重复请求：同一轮里能拿到的地址直接留给 CDN 探测用。
     */
    static JSONObject diagnoseLocalWithStream(String vid) {
        JSONArray layers = new JSONArray();
        JSONObject result = new JSONObject();
        if (vid == null || !vid.matches("[0-9]{1,30}")) {
            layers.put(probeRow("本地取址", false, 0L, "分集编号无效"));
            putJson(result, "layers", layers);
            putJson(result, "stream", probeRow("视频流直连", false, 0L, "没有可用地址"));
            return result;
        }
        long started = System.currentTimeMillis();
        Device device;
        try {
            device = identity();
            layers.put(probeRow("匿名设备", true, System.currentTimeMillis() - started,
                    "device …" + tail(device.deviceId, 6)));
        } catch (Exception error) {
            layers.put(probeRow("匿名设备", false, System.currentTimeMillis() - started, describe(error)));
            putJson(result, "layers", layers);
            putJson(result, "stream", probeRow("视频流直连", false, 0L, "设备注册失败，没有地址可探"));
            return result;
        }
        String url = "";
        for (Object[] layer : new Object[][]{
                {"本地主接口 v5", (LayerTask) () -> fetchModel(vid, device, false)},
                {"本地 video_tab", (LayerTask) () -> fetchTab(vid, device)},
                {"本地备用域名", (LayerTask) () -> fetchModelFrom(HOSTS[1], vid, device, false)}}) {
            JSONObject row = probeLayer((String) layer[0], (LayerTask) layer[1]);
            layers.put(row);
            if (url.isEmpty() && row.optBoolean("ok")) url = row.optString("url", "");
        }
        putJson(result, "layers", layers);
        putJson(result, "stream", probeCdn(url));
        return result;
    }

    private interface LayerTask {
        StreamInfo run() throws Exception;
    }

    private static JSONObject probeLayer(String name, LayerTask task) {
        long started = System.currentTimeMillis();
        try {
            StreamInfo info = task.run();
            long ms = System.currentTimeMillis() - started;
            if (info == null || info.getUrl() == null || info.getUrl().isEmpty()) {
                String probe = LAST_PROBE.get();
                return probeRow(name, false, ms, probe == null || probe.isEmpty() ? "返回空正文" : probe);
            }
            // url 只在这一层内部流转给 CDN 探测，不进 UI
            JSONObject row = probeRow(name, true, ms, "命中 " + info.getQuality());
            putJson(row, "url", info.getUrl());
            return row;
        } catch (Exception error) {
            return probeRow(name, false, System.currentTimeMillis() - started, describe(error));
        }
    }

    /** org.json 的 put 会抛受检异常，而这里所有 key 都是常量、值都可序列化，包一层省得每处都写 try。 */
    private static void putJson(JSONObject target, String key, Object value) {
        try {
            target.put(key, value);
        } catch (Exception ignored) {
            // 常量 key + 可序列化值，实际不会抛
        }
    }

    private static JSONObject probeRow(String name, boolean ok, long ms, String detail) {
        JSONObject row = new JSONObject();
        putJson(row, "name", name);
        putJson(row, "ok", ok);
        putJson(row, "ms", ms);
        putJson(row, "detail", detail == null ? "" : detail);
        return row;
    }

    private static String tail(String text, int count) {
        if (text == null) return "";
        return text.length() <= count ? text : text.substring(text.length() - count);
    }

    /** 给诊断用的 CDN 探测：取到地址后真正拉一小段，确认视频流不是死的。 */
    static JSONObject probeCdn(String url) {
        if (url == null || url.isEmpty()) return probeRow("视频流直连", false, 0L, "没有可用地址");
        /* 红果 CDN 对 Referer 的态度在不同域名上不一致：有的带 Referer 直接 403。
           所以先按播放器的真实形态（只带 UA）拉一次，被拒了再退回带 Referer 的老写法，
           免得把「能播」误报成「打不通」。 */
        JSONObject plain = pullHead(url, false);
        if (plain.optBoolean("ok")) return plain;
        JSONObject withReferer = pullHead(url, true);
        return withReferer.optBoolean("ok") ? withReferer : plain;
    }

    private static JSONObject pullHead(String url, boolean referer) {
        long started = System.currentTimeMillis();
        Request.Builder builder = new Request.Builder()
                .url(url)
                .header("User-Agent", PLAYBACK_UA)
                .header("Range", "bytes=0-262143");
        if (referer) builder.header("Referer", "https://novel.snssdk.com/");
        try (Response response = HTTP.newCall(builder.build()).execute()) {
            if (response.code() != 200 && response.code() != 206) {
                return probeRow("视频流直连", false, System.currentTimeMillis() - started,
                        "HTTP " + response.code() + (referer ? "（带 Referer 也不行）" : ""));
            }
            long firstByte = System.currentTimeMillis() - started;
            long total = 0;
            if (response.body() != null) {
                byte[] buffer = new byte[16 * 1024];
                int read;
                while ((read = response.body().byteStream().read(buffer)) > 0) {
                    total += read;
                    if (total >= 262144) break;
                }
                response.body().close();
            }
            long elapsed = Math.max(1L, System.currentTimeMillis() - started);
            long kbps = total * 8 / elapsed;   // Kbps ≈ 字节*8/毫秒
            return probeRow("视频流直连", total > 0, elapsed,
                    (total > 0 ? (total / 1024) + "KB / " + kbps + "Kbps" : "无数据")
                            + "，首包 " + firstByte + "ms");
        } catch (Exception error) {
            return probeRow("视频流直连", false, System.currentTimeMillis() - started, describe(error));
        }
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
        Device device = new Device(deviceId, iid, cdid);
        activate(device);
        return device;
    }

    /**
     * 注册完补一次 app_alert_check。
     *
     * 上游看到的行为是「这台设备注册完就直奔 player 接口」，中间没有任何正常客户端
     * 会有的动作，判起来非常容易。hongguoTV 的注册流程里一直有这一步（1 秒预算、
     * 失败不影响注册），Veyra 之前没有 —— 补上，让设备至少走完一次激活。
     * 接口吃不下就静默跳过，绝不因为这一步拖慢或阻断取址。
     */
    private static void activate(Device device) {
        try {
            long now = System.currentTimeMillis();
            StringBuilder query = new StringBuilder();
            append(query, "tt_data", "a");
            append(query, "os_api", "29");
            append(query, "device_type", "PGT-AN10");
            append(query, "ssmix", "a");
            append(query, "manifest_version_code", "73932");
            append(query, "dpi", "520");
            append(query, "version_name", VERSION_NAME);
            append(query, "ts", String.valueOf(now / 1000));
            append(query, "cpu_support64", "true");
            append(query, "app_type", "normal");
            append(query, "appTheme", "light");
            append(query, "ac", "wifi");
            append(query, "host_abi", "arm64-v8a");
            append(query, "update_version_code", "73932");
            append(query, "channel", "update_64");
            append(query, "_rticket", String.valueOf(now));
            append(query, "device_platform", "android");
            append(query, "version_code", "73932");
            append(query, "cdid", device.cdid);
            append(query, "os", "android");
            append(query, "is_android_pad", "0");
            append(query, "package", "com.phoenix.read");
            append(query, "resolution", "1280*2772");
            append(query, "os_version", "12");
            append(query, "language", "zh");
            append(query, "device_brand", "Redmi");
            append(query, "need_personal_recommend", "1");
            append(query, "aid", "8662");
            append(query, "minor_status", "0");
            append(query, "app_name", "novel");
            append(query, "mcc_mnc", "46000");
            append(query, "device_id", device.deviceId);
            append(query, "iid", device.iid);
            Request request = new Request.Builder()
                    .url("https://ichannel.snssdk.com/service/2/app_alert_check/?" + query)
                    .header("content-type", "application/octet-stream;tt-data=a")
                    .header("log-encode-type", "gzip")
                    .header("x-ss-req-ticket", String.valueOf(now))
                    .header("sdk-version", "2")
                    .header("passport-sdk-version", "73932")
                    .header("user-agent", REGISTER_UA)
                    .build();
            try (Response response = QUICK.newCall(request).execute()) {
                if (response.body() != null) response.body().close();
            }
        } catch (Throwable ignored) {
            // 激活只是让设备更像真机，失败不影响后面取址
        }
    }

    private static void append(StringBuilder query, String key, String value) {
        if (query.length() > 0) query.append('&');
        query.append(key).append('=').append(value);
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
    private static StreamInfo fetchModel(String vid, Device device, boolean album) throws Exception {
        try {
            return fetchModelFrom(HOSTS[0], vid, device, album);
        } catch (IOException network) {
            /* a 节点连不上或回了 HTTP 错误才换 b。空正文（返回 null）属于身份判定，
               换节点一样空，白多一次请求只会加重风控。 */
            if (HOSTS.length < 2) throw network;
            return fetchModelFrom(HOSTS[1], vid, device, album);
        }
    }

    /** 移动端公共参数：player 与 video_tab 共用，签名必须与实际发送的一致。 */
    private static LinkedHashMap<String, String> deviceQuery(Device device) {
        LinkedHashMap<String, String> values = new LinkedHashMap<>();
        values.put("aid", "8662");
        values.put("app_name", "novelread");
        values.put("version_code", "74532");
        values.put("version_name", VERSION_NAME);
        values.put("channel", "update_64");
        values.put("device_platform", "android");
        values.put("device_type", "25053RT47C");
        values.put("device_brand", "Redmi");
        values.put("os_version", "16");
        values.put("os_api", "36");
        values.put("update_version_code", "74532");
        values.put("iid", device.iid);
        values.put("cdid", device.cdid);
        values.put("device_id", device.deviceId);
        return values;
    }

    /**
     * 取模接口的完整参数集：服务端会校验集合是否齐全，少一项就静默回空正文。
     * 顺序照客户端原样排，签名按这个顺序算，任何一项缺失都会让签名和正文对不上。
     */
    private static LinkedHashMap<String, String> playerQuery(Device device, long now) {
        LinkedHashMap<String, String> values = new LinkedHashMap<>();
        values.put("device_platform", "android");
        values.put("os", "android");
        values.put("ssmix", "a");
        values.put("_rticket", String.valueOf(now));
        values.put("cdid", device.cdid);
        values.put("channel", "update_64");
        values.put("aid", "8662");
        values.put("app_name", "novelread");
        values.put("version_code", "74532");
        values.put("version_name", VERSION_NAME);
        values.put("manifest_version_code", "74532");
        values.put("update_version_code", "74532");
        values.put("resolution", "1280*2772");
        values.put("dpi", "520");
        values.put("device_type", "25053RT47C");
        values.put("device_brand", "Redmi");
        values.put("language", "zh");
        values.put("os_api", "36");
        values.put("os_version", "16");
        values.put("ac", "wifi");
        values.put("host_abi", "arm64-v8a");
        values.put("dragon_device_type", "phone");
        values.put("pv_player", "74532");
        values.put("compliance_status", "0");
        values.put("need_personal_recommend", "1");
        values.put("player_so_load", "1");
        values.put("is_android_pad_screen", "0");
        values.put("iid", device.iid);
        values.put("device_id", device.deviceId);
        return values;
    }

    private static StreamInfo fetchModelFrom(String host, String vid, Device device, boolean album) throws Exception {
        String endpoint = host + PLAYER_PATH;
        long now = System.currentTimeMillis();
        LinkedHashMap<String, String> values = playerQuery(device, now);

        /* 分组按内容类型走：普通短剧 1004，UGC 合集 1001（PUGC）。
           合集用 1004 只会回空正文或 101000，本地取流一直卡在这一步。 */
        String group = album ? "1001" : "1004";
        String payload = "{\"biz_param\":{\"detail_page_version\":0,\"device_level\":" + MODEL_LEVEL + ","
                + "\"disable_digg_stat\":false,\"disable_video_relate_book\":false,"
                + "\"need_all_video_definition\":true,\"need_mp4_align\":false,"
                + "\"use_os_player\":false,\"use_server_dns\":false,\"video_platform\":1024},"
                + "\"mixed_video_id_map\":{\"" + group + "\":[\"" + vid + "\"]},\"dr_scene\":\"player\"}";
        byte[] body = gzip(payload.getBytes(StandardCharsets.UTF_8));

        HongguoV5.Signed signed = HongguoV5.signPlayback(endpoint, values, body, now);
        Request.Builder builder = new Request.Builder()
                .url(signed.url)
                .header("User-Agent", PLAYBACK_UA)
                .header("x-ss-dp", "8662")
                .header("Accept", "application/json; charset=utf-8,application/x-protobuf")
                .header("Content-Type", "application/json; charset=utf-8")
                .header("Content-Encoding", "gzip")
                .header("x-ss-stub", HongguoV5.hexText(HongguoV5.md5(body)).toUpperCase())
                .header("lc", "101")
                .header("x-reading-request", now + "-" + Math.abs(RANDOM.nextInt(1000000000)))
                .header("x-xs-from-web", "0");
        for (Map.Entry<String, String> entry : signed.headers.entrySet()) {
            builder.header(entry.getKey(), entry.getValue());
        }
        String text = execute(builder.post(RequestBody.create(body, JSON)).build());
        StreamInfo info = parse(text, vid);
        if (info == null) {
            int length = text == null ? 0 : text.trim().length();
            boolean onlyBytevc2 = text != null && text.contains("bytevc2")
                    && !text.contains("\"h264\"") && !text.contains("\"hevc\"");
            LAST_PROBE.set(length == 0 ? "200/0B"
                    : "200/" + length + "B " + (onlyBytevc2 ? "仅bytevc2" : "无兼容片源"));
        }
        return info;
    }

    /**
     * 备用取址：{@code video_tab} GET。
     *
     * 主接口回 200 空正文时它仍在服务，但 v5 之后这条 GET 也要签名：
     * 签名输入是「最终 query + 空字节的 MD5」，且必须删掉 POST 专用的
     * {@code x-ss-stub / Content-Type / Content-Encoding} —— 带上就回空包。
     */
    private static StreamInfo fetchTab(String vid, Device device) throws Exception {
        long now = System.currentTimeMillis();
        String endpoint = HOSTS[0] + TAB_PATH;
        LinkedHashMap<String, String> values = deviceQuery(device);
        values.put("video_id", vid);
        values.put("video_id_type", "0");
        values.put("device_level", String.valueOf(PLAYER_LEVEL));
        values.put("need_all_video_definition", "1");
        values.put("need_mp4_align", "0");
        values.put("use_os_player", "0");
        values.put("video_platform", "1024");
        values.put("source", "0");
        values.put("from_video_id", "");
        values.put("_rticket", String.valueOf(now));

        HongguoV5.Signed signed = HongguoV5.signPlayback(endpoint, values, new byte[0], now);
        Request.Builder builder = new Request.Builder()
                .url(signed.url)
                .get()
                .header("User-Agent", TAB_UA)
                .header("Accept", "application/json; charset=utf-8")
                .header("Accept-Language", "zh-CN,zh;q=0.9");
        for (Map.Entry<String, String> entry : signed.headers.entrySet()) {
            builder.header(entry.getKey(), entry.getValue());
        }
        String text = execute(builder.build());
        StreamInfo info = parse(text, vid);
        if (info == null) {
            int length = text == null ? 0 : text.trim().length();
            boolean onlyBytevc2 = text != null && text.contains("bytevc2")
                    && !text.contains("\"h264\"") && !text.contains("\"hevc\"");
            LAST_PROBE.set(length == 0 ? "tab/200-0B"
                    : "tab/200-" + length + "B " + (onlyBytevc2 ? "仅bytevc2" : "无兼容片源"));
        }
        return info;
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
