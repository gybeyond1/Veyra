package com.veyra.gybeyond;

import android.content.Context;

/**
 * 电视主题的**空实现**（手机包里用这份）。
 *
 * <p>电视那套主题（黑金/暖白…）由 tv.js 管，落盘在本地，原生只负责把条目色值同步给
 * 状态栏与边框；手机端主题走 sunny-theme.css 的 CSS 变量，跟这个类无关。
 *
 * <p>真实现放在 {@code src/tv/java}，手机包只编进同名的空壳 —— 主壳里那处
 * {@code TvTheme.save(...)} 调用不用写 if，手机包也不会带电视主题那套色值与资源。
 */
final class TvTheme {
    private TvTheme() { }

    static void save(Context context, String key) { }

    static String current(Context context) { return ""; }

    static int accent(Context context) { return 0; }

    static int ink(Context context) { return 0; }
}
