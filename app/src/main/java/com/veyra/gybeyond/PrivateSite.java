package com.veyra.gybeyond;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * 私密模式当前选中的源。
 *
 * 黄果（huangguo）走原来的 SiteRepository：端侧直连/代理/后端转发三通道不变。
 * 其余源（剧果、野果、帝果……）统一走后端网关，解析只有一份，四端共用。
 */
final class PrivateSite {
    private static final String PREFS = "veyra-private-site";
    private static final String KEY_ID = "id";
    private static final String KEY_NAME = "name";

    static final String HUANGGUO = "huangguo";

    private PrivateSite() {}

    static String get(Context context) {
        String id = prefs(context).getString(KEY_ID, "");
        return id == null || id.trim().isEmpty() ? HUANGGUO : id.trim();
    }

    static String name(Context context) {
        String name = prefs(context).getString(KEY_NAME, "");
        return name == null || name.trim().isEmpty() ? "黄果" : name.trim();
    }

    static boolean isBuiltin(Context context) {
        return HUANGGUO.equals(get(context));
    }

    static void set(Context context, String id, String name) {
        String clean = id == null ? "" : id.trim();
        prefs(context).edit()
                .putString(KEY_ID, clean.isEmpty() ? HUANGGUO : clean)
                .putString(KEY_NAME, name == null ? "" : name.trim())
                .apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
