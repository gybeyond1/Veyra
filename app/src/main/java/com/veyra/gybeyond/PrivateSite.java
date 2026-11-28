package com.veyra.gybeyond;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * 私密模式当前选中的源。
 *
 * 只有一份清单：{@code LocalSources.SITES}，与后端 providers 一一对应
 * （剧果 / 禁果短剧 / 黄果旧版 / 黄果 AI / 帝果）。历史上那个「黄果」伪源
 * （内部再分直连/代理/后端三通道）已经拆成具体源，不再是一个可选项 ——
 * 留着它就会出现「列表里没有、设置里却选中」的鬼状态。
 */
final class PrivateSite {
    private static final String PREFS = "veyra-private-site";
    private static final String KEY_ID = "id";
    private static final String KEY_NAME = "name";

    /** 首次进入私密模式默认用哪个源：与 WebUI 的默认一致（黄果 AI）。 */
    private static final String DEFAULT_SITE = "huangguoai";

    private PrivateSite() {}

    private static String[] defaultSite() {
        for (String[] row : com.veyra.gybeyond.localsrc.LocalSources.SITES) {
            if (DEFAULT_SITE.equals(row[0])) return row;
        }
        return com.veyra.gybeyond.localsrc.LocalSources.SITES[0];
    }

    static String get(Context context) {
        String id = prefs(context).getString(KEY_ID, "");
        String value = id == null ? "" : id.trim();
        /*
         * 空值、以及历史遗留的 huangguo / 黄豆 / 野果 / 禁果（已下架或已并入具体源）
         * 一律当场换成清单第一个并写回去。不自愈的话，进私密模式就是整页「加载失败」，
         * 用户只会以为整个私密模式坏了。
         */
        if (!com.veyra.gybeyond.localsrc.LocalSources.known(value)) {
            String[] fallback = defaultSite();
            set(context, fallback[0], fallback[1]);
            return fallback[0];
        }
        return value;
    }

    static String name(Context context) {
        String id = get(context);
        String local = com.veyra.gybeyond.localsrc.LocalSources.nameOf(id);
        if (!local.isEmpty()) return local;
        String name = prefs(context).getString(KEY_NAME, "");
        return name == null ? "" : name.trim();
    }

    static void set(Context context, String id, String name) {
        String clean = id == null ? "" : id.trim();
        String[] fallback = defaultSite();
        prefs(context).edit()
                .putString(KEY_ID, clean.isEmpty() ? fallback[0] : clean)
                .putString(KEY_NAME, name == null ? "" : name.trim())
                .apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
