package com.veyra.gybeyond;

import android.app.Activity;
import android.os.Build;
import android.view.Display;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;

/** Requests up to 120 Hz for the browsing UI without changing the screen resolution. */
final class UiRefreshRate {
    private UiRefreshRate() {}

    static void apply(Activity activity, View content) {
        // Android 5.x 没有高刷，也没有 Display.getMode()（API 23）。老电视包直接跳过，
        // 别为了一个 60Hz 屏去调用 23 才有的方法。
        if (Build.VERSION.SDK_INT < 23) return;
        Display display = activity.getWindowManager().getDefaultDisplay();
        Display.Mode current = display.getMode();
        float preferred = 0f;
        for (Display.Mode mode : display.getSupportedModes()) {
            if (mode.getPhysicalWidth() == current.getPhysicalWidth()
                    && mode.getPhysicalHeight() == current.getPhysicalHeight()
                    && mode.getRefreshRate() <= 120.5f) {
                preferred = Math.max(preferred, mode.getRefreshRate());
            }
        }
        if (preferred == 0f) preferred = current.getRefreshRate();
        WindowManager.LayoutParams attributes = activity.getWindow().getAttributes();
        attributes.preferredRefreshRate = preferred;
        if (Build.VERSION.SDK_INT >= 35) attributes.setFrameRateBoostOnTouchEnabled(true);
        activity.getWindow().setAttributes(attributes);
        // Window preference alone does not override the default frame-rate category
        // of a View on Android 15+. Apply the explicit rate to the actual WebView too.
        if (Build.VERSION.SDK_INT >= 36 && content instanceof ViewGroup) {
            ((ViewGroup) content).propagateRequestedFrameRate(preferred, true);
        } else if (Build.VERSION.SDK_INT >= 35) {
            content.setRequestedFrameRate(preferred);
        }
    }
}
