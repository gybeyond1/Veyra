package com.veyra.gybeyond;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.provider.Settings;
import org.json.JSONArray;
import org.json.JSONObject;

import java.util.UUID;

/**
 * 设备上报 + 下载指令轮询：Web 管理台「下载到手机」的另一端。
 *
 * 只做三件事：上报设备信息（同时充当在线心跳）、领取指令、回执。
 * 真正的取流/下载/合并仍然走 DownloadManager 的本地逻辑，和手机上手动点下载完全一致。
 */
final class DeviceLink {
    private static final String PREFS = "veyra-device";
    private static final String KEY_ID = "deviceId";

    private final Context context;
    private final AccountService account;

    DeviceLink(Context context, AccountService account) {
        this.context = context.getApplicationContext();
        this.account = account;
    }

    /** 稳定设备标识：优先用 Android ID，换不到就用持久化随机串。 */
    static String deviceId(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String saved = prefs.getString(KEY_ID, "");
        if (saved != null && saved.matches("[A-Za-z0-9_-]{8,64}")) return saved;
        String seed = "";
        try {
            seed = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ANDROID_ID);
        } catch (Exception ignored) { }
        String id = "veyra" + String.valueOf(seed).replaceAll("[^A-Za-z0-9]", "");
        if (id.length() < 8) id = "veyra" + UUID.randomUUID().toString().replace("-", "");
        if (id.length() > 48) id = id.substring(0, 48);
        prefs.edit().putString(KEY_ID, id).apply();
        return id;
    }

    /** 展示名：厂商 + 型号（型号已含厂商时不重复）。 */
    private static String displayName() {
        String model = Build.MODEL == null ? "" : Build.MODEL.trim();
        String brand = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.trim();
        if (model.isEmpty()) return brand.isEmpty() ? "Android 设备" : brand;
        if (brand.isEmpty() || model.toLowerCase().startsWith(brand.toLowerCase())) return model;
        return brand + " " + model;
    }

    private String appVersion() {
        try {
            return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
        } catch (Exception ignored) {
            return "";
        }
    }

    JSONObject register() throws Exception {
        JSONObject body = new JSONObject()
                .put("id", deviceId(context))
                .put("name", displayName())
                .put("model", Build.MODEL == null ? "" : Build.MODEL)
                .put("brand", Build.MANUFACTURER == null ? "" : Build.MANUFACTURER)
                .put("platform", "android")
                .put("android", Build.VERSION.RELEASE == null ? "" : Build.VERSION.RELEASE)
                .put("appVersion", appVersion());
        return account.postJson("api/devices/register", body);
    }

    JSONArray poll() throws Exception {
        JSONObject result = account.postJson("api/devices/poll", new JSONObject().put("id", deviceId(context)));
        JSONArray commands = result.optJSONArray("commands");
        return commands == null ? new JSONArray() : commands;
    }

    void ack(String commandId, boolean ok, String error) {
        try {
            account.postJson("api/devices/ack", new JSONObject()
                    .put("deviceId", deviceId(context))
                    .put("id", commandId)
                    .put("ok", ok)
                    .put("error", error == null ? "" : error));
        } catch (Exception ignored) { }
    }
}
