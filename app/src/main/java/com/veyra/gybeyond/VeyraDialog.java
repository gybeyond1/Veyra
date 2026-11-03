package com.veyra.gybeyond;

import android.app.Dialog;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * 统一的自绘确认框。
 *
 * <p>系统那套 {@code Theme_Material_Dialog_Alert} 在纯黑播放画面里会顶出一个灰白
 * 直角卡片，一眼就是 Android 4.x 的东西。这里改成深色圆角玻璃面板、当前主题的强调色
 * 主按钮，遥控器方向键能在两个按钮之间走，焦点有白色描边。</p>
 */
final class VeyraDialog {
    private VeyraDialog() { }

    static Dialog confirm(Context context, String title, String message,
                          String positiveText, String negativeText, Runnable onPositive) {
        final float density = context.getResources().getDisplayMetrics().density;
        final int accent = TvTheme.accent(context);
        final int accentInk = TvTheme.ink(context);

        LinearLayout panel = new LinearLayout(context);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(px(density, 30), px(density, 26), px(density, 30), px(density, 22));
        GradientDrawable shell = new GradientDrawable();
        shell.setColor(0xF2181B1F);
        shell.setCornerRadius(px(density, 20));
        shell.setStroke(Math.max(1, px(density, 1)), 0x26FFFFFF);
        panel.setBackground(shell);

        TextView heading = new TextView(context);
        heading.setText(title);
        heading.setTextSize(20);
        heading.setTextColor(0xFFFFFFFF);
        heading.setTypeface(null, Typeface.BOLD);
        heading.setIncludeFontPadding(false);
        panel.addView(heading, new LinearLayout.LayoutParams(-1, -2));

        TextView body = new TextView(context);
        body.setText(message);
        body.setTextSize(15);
        body.setTextColor(0xFFB4BCC5);
        body.setLineSpacing(px(density, 6), 1f);
        LinearLayout.LayoutParams bodyParams = new LinearLayout.LayoutParams(-1, -2);
        bodyParams.topMargin = px(density, 12);
        panel.addView(body, bodyParams);

        LinearLayout row = new LinearLayout(context);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(-1, -2);
        rowParams.topMargin = px(density, 26);
        panel.addView(row, rowParams);

        /* 次级按钮：透明底 + 细边，聚焦时整块变白、字变深 */
        StateListDrawable ghostStates = new StateListDrawable();
        GradientDrawable ghostFocused = round(density, 0xFFFFFFFF);
        ghostFocused.setStroke(Math.max(1, px(density, 1)), 0x66FFFFFF);
        GradientDrawable ghostNormal = round(density, 0x14FFFFFF);
        ghostNormal.setStroke(Math.max(1, px(density, 1)), 0x33FFFFFF);
        ghostStates.addState(new int[]{android.R.attr.state_focused}, ghostFocused);
        ghostStates.addState(new int[]{}, ghostNormal);
        TextView negative = actionButton(context, density,
                negativeText == null ? "关闭" : negativeText, ghostStates, 0xFFFFFFFF, 0xFF12161A);

        /* 主按钮：强调色实心，聚焦时加一圈白边 */
        StateListDrawable primaryStates = new StateListDrawable();
        GradientDrawable primaryFocused = ring(density, accent, 0xFFFFFFFF);
        GradientDrawable primaryNormal = round(density, accent);
        primaryStates.addState(new int[]{android.R.attr.state_focused}, primaryFocused);
        primaryStates.addState(new int[]{}, primaryNormal);
        TextView positive = actionButton(context, density, positiveText,
                primaryStates, accentInk, accentInk);

        LinearLayout.LayoutParams negativeParams = new LinearLayout.LayoutParams(
                px(density, 124), px(density, 46));
        negativeParams.rightMargin = px(density, 12);
        row.addView(negative, negativeParams);
        row.addView(positive, new LinearLayout.LayoutParams(px(density, 124), px(density, 46)));

        final Dialog dialog = new Dialog(context,
                android.R.style.Theme_Translucent_NoTitleBar_Fullscreen);
        dialog.setContentView(panel);
        dialog.setCanceledOnTouchOutside(true);
        negative.setOnClickListener(view -> dialog.dismiss());
        positive.setOnClickListener(view -> {
            dialog.dismiss();
            if (onPositive != null) onPositive.run();
        });
        dialog.setOnShowListener(shown -> negative.requestFocus());

        Window window = dialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
            WindowManager.LayoutParams attrs = window.getAttributes();
            attrs.dimAmount = 0.58f;
            window.setAttributes(attrs);
            window.setGravity(Gravity.CENTER);
            window.setLayout(Math.min(px(density, 430),
                    context.getResources().getDisplayMetrics().widthPixels - px(density, 48)),
                    WindowManager.LayoutParams.WRAP_CONTENT);
        }
        return dialog;
    }

    private static TextView actionButton(Context context, float density, String text,
                                         StateListDrawable background,
                                         int normalText, int focusedText) {
        TextView view = new TextView(context);
        view.setText(text);
        view.setTextSize(15);
        view.setGravity(Gravity.CENTER);
        view.setTypeface(null, Typeface.BOLD);
        view.setIncludeFontPadding(false);
        view.setFocusable(true);
        view.setClickable(true);
        view.setBackground(background);
        view.setTextColor(new ColorStateList(
                new int[][]{new int[]{android.R.attr.state_focused}, new int[]{}},
                new int[]{focusedText, normalText}));
        return view;
    }

    private static GradientDrawable round(float density, int color) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(px(density, 12));
        return drawable;
    }

    /** 实心 + 外圈白描边：遥控器聚焦时一眼能看出停在哪颗按钮上。 */
    private static GradientDrawable ring(float density, int color, int strokeColor) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(px(density, 12));
        drawable.setStroke(px(density, 3), strokeColor);
        return drawable;
    }

    private static int px(float density, int value) {
        return Math.round(value * density);
    }
}
