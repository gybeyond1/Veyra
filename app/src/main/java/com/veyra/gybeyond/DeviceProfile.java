package com.veyra.gybeyond;

import android.content.Context;
import android.content.pm.PackageManager;
import android.content.res.Configuration;

/**
 * 设备形态判定：手机 / 平板 / 电视。
 *
 * 只做判定，不改任何既有行为。判定结果通过 {@link MainActivity.Bridge#deviceProfile()}
 * 同步给页面，页面据此加 html[data-device]，大屏样式表和遥控焦点都以此为唯一开关，
 * 手机路径（data-device=phone）不命中任何新规则，等价于改动前。
 */
final class DeviceProfile {
    static final String PHONE = "phone";
    static final String TABLET = "tablet";
    static final String TV = "tv";

    private DeviceProfile() { }

    static String type(Context context) {
        if (isTv(context)) return TV;
        return isTablet(context) ? TABLET : PHONE;
    }

    /**
     * 电视 / 电视盒子。
     *
     * 三条判据，命中一条就算：
     * 1. Leanback / Television 硬件特性 —— 标准 Android TV；
     * 2. {@code uiMode} 报的是电视 —— 一部分国产电视系统把特性表删了，但 uiMode 还是对的；
     * 3. TV 独立包 + 没有触摸屏 —— 海信、创维、TCL 那批机器经常什么特性都不声明，
     *    只靠 1、2 会把它当手机，整台电视就渲染成手机那套小字号界面。
     *
     * 第 3 条要求「无触摸屏」，所以 TV 包装在有触摸屏的平板/手机上仍按原来的形态走。
     */
    static boolean isTv(Context context) {
        PackageManager pm = context.getPackageManager();
        if (pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
                || pm.hasSystemFeature(PackageManager.FEATURE_TELEVISION)) return true;
        Configuration config = context.getResources().getConfiguration();
        int mode = config.uiMode & Configuration.UI_MODE_TYPE_MASK;
        if (mode == Configuration.UI_MODE_TYPE_TELEVISION) return true;
        return litePackage(context) && !pm.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN);
    }

    /** TV 独立包（flavor tv 里 R.bool.veyra_lite 为 true），与屏幕形态无关。 */
    private static boolean litePackage(Context context) {
        try {
            return context.getResources().getBoolean(R.bool.veyra_lite);
        } catch (Exception ignored) {
            return false;
        }
    }

    /**
     * 是否按「电视角色」工作。
     *
     * TV 独立包（flavor tv 打进来的 R.bool.veyra_lite）装在任何设备上都算电视 ——
     * 把 TV 包装在平板上用的人不少，那时 isTv() 是 false（平板没有 Leanback），
     * 设备上报就成了 android，手机投屏列表只挑 tv/desktop，于是「明明在线却搜不到」。
     *
     * 与 {@link #type(Context)} 的分工：type 描述屏幕形态（平板装 TV 包仍算 tablet，
     * 界面留白/列数照旧），这里回答的是这台机器在账号里承担的角色 ——
     * 投屏发现、指令轮询间隔、接不接投屏指令都按这个判。
     */
    static boolean isTvRole(Context context) {
        if (litePackage(context)) return true;
        return isTv(context);
    }

    /** 平板：最小宽度 ≥ 600dp（与 Material 断点一致）。 */
    static boolean isTablet(Context context) {
        Configuration config = context.getResources().getConfiguration();
        return config.smallestScreenWidthDp >= 600;
    }
}
