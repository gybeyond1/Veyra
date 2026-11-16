package com.veyra.gybeyond;

import android.content.Context;
import android.content.res.Configuration;

/**
 * 形态常量：phone / tablet / tv。
 *
 * <p>电视与手机是两个包，形态在<b>编译期</b>就定了（{@code BuildConfig.TV}），这里不再做任何探测。
 * 以前靠 Leanback 特性、uiMode、触摸屏、视口宽度一层层猜：海信、创维、TCL 那批机器什么特性都不声明，
 * 猜错就是「电视包跑手机界面」，而且一条链上任何一环变化都会把另一端的界面带歪。
 *
 * <p>手机包内部仍然区分 phone / tablet —— 那是同一个包要适配两种屏幕，按最小宽度分档，
 * 属于同一端的版式差异，不是「两个包共用一套形态」。
 */
final class DeviceProfile {
    static final String PHONE = "phone";
    static final String TABLET = "tablet";
    static final String TV = "tv";

    private DeviceProfile() { }

    static String type(Context context) {
        if (BuildConfig.TV) return TV;
        return isTablet(context) ? TABLET : PHONE;
    }

    /** 电视包。编译期常量，不存在判错的情况。 */
    static boolean isTv(Context context) {
        return BuildConfig.TV;
    }

    /** 是否按「电视角色」工作（投屏发现、指令轮询间隔、接不接投屏指令）。 */
    static boolean isTvRole(Context context) {
        return BuildConfig.TV;
    }

    /** 平板：最小宽度 ≥ 600dp（与 Material 断点一致）。只在手机包里有意义。 */
    static boolean isTablet(Context context) {
        Configuration config = context.getResources().getConfiguration();
        return config.smallestScreenWidthDp >= 600;
    }
}
