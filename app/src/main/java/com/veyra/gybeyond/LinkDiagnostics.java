package com.veyra.gybeyond;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/**
 * 设置页「链路检测」：点一次，把「取播放地址」涉及的每条链路分别打一遍，
 * 各自给出「通/不通 + 耗时 + 原因」。
 *
 * 为什么要单独做这个：取流失败时，用户看到的现象完全一样——点播放转圈然后报错。
 * 但成因可能是本地签名被拒、后端地址填错、后端挂了、出口 IP 被限流、CDN 不通，
 * 这几种的处理方式完全不同。把每条链路单独测一次，一眼就能看出卡在哪一段。
 *
 * 只读操作：不发任何写请求，不写缓存、不设冷却。代价是每次点都会真实打上游几次
 * （本地最多 3 次 + CDN 1 次 + 后端 2 次），所以做成手动触发，不自动跑。
 */
final class LinkDiagnostics {

    /** 后端探测用短超时：后端在同一局域网/公网直连，10 秒还没响应基本就是不通。 */
    private static final OkHttpClient HTTP = new OkHttpClient.Builder()
            .connectTimeout(6, TimeUnit.SECONDS)
            .readTimeout(10, TimeUnit.SECONDS)
            .callTimeout(14, TimeUnit.SECONDS)
            .followRedirects(true)
            .build();

    private LinkDiagnostics() { }

    /**
     * @param vid 想用来测试的分集；空或非法时自动挑一台
     * @return 见下方结构，JS 端按 group 分组渲染
     */
    static JSONObject run(Context context, String vid) {
        String sample = (vid != null && vid.matches("[0-9]{1,30}")) ? vid : HongguoDirect.diagnoseVid();
        JSONArray items = new JSONArray();

        long started = System.currentTimeMillis();
        // ---- 本地直连（APK 自己签名取址） ----
        JSONObject local = null;
        try {
            local = HongguoDirect.diagnoseLocalWithStream(sample);
        } catch (Throwable error) {
            items.put(row("local", "本地取址", false, System.currentTimeMillis() - started, shortText(error)));
        }
        if (local != null) {
            JSONArray layers = local.optJSONArray("layers");
            if (layers != null) {
                for (int i = 0; i < layers.length(); i++) {
                    JSONObject layer = layers.optJSONObject(i);
                    if (layer == null) continue;
                    items.put(row("local", layer.optString("name"), layer.optBoolean("ok"),
                            layer.optLong("ms"), layer.optString("detail")));
                }
            }
            JSONObject stream = local.optJSONObject("stream");
            if (stream != null) {
                items.put(row("stream", "视频流直连", stream.optBoolean("ok"),
                        stream.optLong("ms"), stream.optString("detail")));
            }
        }

        // ---- NAS 后端 ----
        String base = "";
        try {
            base = ServerConfig.get(context);
        } catch (Throwable ignored) {
            // 读不到配置就按「未配置」处理
        }
        if (base == null || base.trim().isEmpty()) {
            items.put(row("backend", "NAS 后端", false, 0L, "未配置服务器地址"));
        } else {
            String root = base.trim().replaceAll("/+$", "");
            items.put(probeHealth(root));
            items.put(probePlayDirect(root, sample));
        }

        JSONObject result = new JSONObject();
        try {
            result.put("vid", sample);
            result.put("base", base == null ? "" : base);
            result.put("items", items);
            result.put("at", System.currentTimeMillis());
        } catch (Throwable ignored) {
            // JSONObject.put 只有 key 为空才会抛，这里的 key 全是常量
        }
        return result;
    }

    /** 后端是否活着：任何 HTTP 响应都算「通」，状态码写进 detail。 */
    private static JSONObject probeHealth(String root) {
        String endpoint = root + "/api/health";
        long started = System.currentTimeMillis();
        try {
            Request request = new Request.Builder().url(endpoint).header("Accept", "*/*").get().build();
            try (Response response = HTTP.newCall(request).execute()) {
                long ms = System.currentTimeMillis() - started;
                boolean ok = response.isSuccessful();
                return row("backend", "后端可达", ok, ms,
                        "HTTP " + response.code() + (ok ? "" : "（服务在，但接口异常）"));
            }
        } catch (Exception error) {
            return row("backend", "后端可达", false, System.currentTimeMillis() - started, shortText(error));
        }
    }

    /** 后端能不能替这台设备取到播放地址。 */
    private static JSONObject probePlayDirect(String root, String vid) {
        String endpoint = root + "/api/hongguo/play-direct?vid=" + vid;
        long started = System.currentTimeMillis();
        try {
            Request request = new Request.Builder()
                    .url(endpoint)
                    .header("Accept", "application/json")
                    .get()
                    .build();
            try (Response response = HTTP.newCall(request).execute()) {
                long ms = System.currentTimeMillis() - started;
                if (response.body() == null) {
                    return row("backend", "后端取址", false, ms, "HTTP " + response.code() + " 无正文");
                }
                String text = response.body().string();
                if (!response.isSuccessful()) {
                    return row("backend", "后端取址", false, ms, "HTTP " + response.code());
                }
                JSONObject json = new JSONObject(text);
                String error = json.optString("error", "");
                if (!error.isEmpty()) return row("backend", "后端取址", false, ms, error);
                String main = json.optString("main_url", "");
                if (main.isEmpty()) return row("backend", "后端取址", false, ms, "返回里没有 main_url");
                return row("backend", "后端取址", true, ms, "命中 " + json.optString("definition", "未知清晰度"));
            }
        } catch (Exception error) {
            return row("backend", "后端取址", false, System.currentTimeMillis() - started, shortText(error));
        }
    }

    private static JSONObject row(String group, String name, boolean ok, long ms, String detail) {
        JSONObject item = new JSONObject();
        try {
            item.put("group", group);
            item.put("name", name);
            item.put("ok", ok);
            item.put("ms", ms);
            item.put("detail", detail == null ? "" : detail);
        } catch (Throwable ignored) {
            // 常量 key，实际不会抛
        }
        return item;
    }

    private static String shortText(Throwable error) {
        String text = error == null ? null : error.getMessage();
        if (text == null || text.isEmpty()) text = error == null ? "未知错误" : error.getClass().getSimpleName();
        // 弹窗里一行放不下长堆栈信息，只留首行
        int cut = text.indexOf('\n');
        if (cut > 0) text = text.substring(0, cut);
        return text.length() > 80 ? text.substring(0, 80) + "…" : text;
    }
}
