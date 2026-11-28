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
        String value = id == null ? "" : id.trim();
        if (value.isEmpty() || HUANGGUO.equals(value)) return HUANGGUO;
        /*
         * 下架掉的源（黄豆没 DNS、野果只认手机出口、禁果正片要 VIP）留在设置里
         * 会让整个私密模式「加载失败」。这里当场换成清单里第一个，并把选择写回去 ——
         * 用户下次进私密模式就不用再手动切一次。
         */
        if (!com.veyra.gybeyond.localsrc.LocalSources.known(value)) {
            String[] first = com.veyra.gybeyond.localsrc.LocalSources.SITES[0];
            set(context, first[0], first[1]);
            return first[0];
        }
        return value;
    }

    static String name(Context context) {
        String id = get(context);
        String name = prefs(context).getString(KEY_NAME, "");
        if (!com.veyra.gybeyond.localsrc.LocalSources.known(id)) {
            return name == null || name.trim().isEmpty() ? "黄果" : name.trim();
        }
        // 清单里的源用本地清单的名字：历史设置里存的旧名字（比如改过名的）不再生效
        String local = com.veyra.gybeyond.localsrc.LocalSources.nameOf(id);
        return local.isEmpty() ? (name == null ? "" : name.trim()) : local;
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
