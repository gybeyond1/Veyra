package com.veyra.gybeyond;

import android.content.Context;

import java.io.File;
import java.io.IOException;

/**
 * 电视自定义背景的**空实现**（手机包里用这份）。
 *
 * <p>电视背景图是"手机扫 TV 上的码 → 传一张图 → TV 铺在首页后面"，
 * 手机端没有这个闭环（它本身就是传图那一端），所以真实现只在 {@code src/tv/java}。
 *
 * <p>主壳 {@link MainActivity} 里三处调用（tv-bg-load / tv-bg-clear / 收图后保存）
 * 都落在空壳上：返回空串与 false，页面拿到空背景照常渲染首页。
 */
final class TvBackground {
    private TvBackground() { }

    static File file(Context context) { return null; }

    static boolean has(Context context) { return false; }

    static void clear(Context context) { }

    static String dataUrl(Context context) { return ""; }

    static String save(Context context, File source) throws IOException { return ""; }
}
