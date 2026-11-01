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

    /** 电视盒子 / Android TV：有 Leanback 或电视硬件特性。 */
    static boolean isTv(Context context) {
        PackageManager pm = context.getPackageManager();
        return pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
                || pm.hasSystemFeature(PackageManager.FEATURE_TELEVISION);
    }

    /** 平板：最小宽度 ≥ 600dp（与 Material 断点一致）。 */
    static boolean isTablet(Context context) {
        Configuration config = context.getResources().getConfiguration();
        return config.smallestScreenWidthDp >= 600;
    }
}
