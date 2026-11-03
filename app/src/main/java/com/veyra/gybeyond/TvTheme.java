package com.veyra.gybeyond;

import android.content.Context;

/**
 * 电视端主题的原生镜像。
 *
 * <p>主题本来只存在页面的 localStorage 里（tv.js 的 veyra.tv.theme），原生层读不到，
 * 所以页面每次切主题都顺手写一份到 SharedPreferences，播放器里的确认框、退出框
 * 才能取到当前主题的强调色，而不是永远一套金色。</p>
 */
final class TvTheme {
    private static final String PREFS = "veyra_tv_native";
    private static final String KEY = "theme";

    private TvTheme() { }

    static void save(Context context, String key) {
        if (context == null || key == null || key.isEmpty()) return;
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(KEY, key).apply();
    }

    static String current(Context context) {
        if (context == null) return "dark";
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(KEY, "dark");
    }

    /** 与 tv.js 的 THEMES 一一对应；主题黑没有彩色强调，退回原金色。 */
    static int accent(Context context) {
        switch (current(context)) {
            case "clean":  return 0xFF1F6FEB;
            case "pink":   return 0xFFFF6699;
            case "red":    return 0xFFF44336;
            case "yellow": return 0xFFFFC107;
            case "green":  return 0xFF8BC34A;
            case "blue":   return 0xFF2196F3;
            case "purple": return 0xFF9C27B0;
            default:       return 0xFFC89B3C;
        }
    }

    /** 强调色上的文字色。亮黄底必须用深棕，白字会糊成一片。 */
    static int ink(Context context) {
        return "yellow".equals(current(context)) ? 0xFF231A06 : 0xFF12161A;
    }
}
