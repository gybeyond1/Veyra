package com.veyra.gybeyond;

import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 分集评论面板：右侧滑出的只读列表，20 条一页，用服务端下发的 cursor 续读。
 *
 * 只读匿名接口，没有发送/点赞，所以界面上也不给这些按钮 —— 免得点了没反应。
 */
final class CommentPanel extends LinearLayout {
    private final DualContentRepository repository;
    private final String seriesId;
    private final String episodeId;
    private final int episodeNumber;
    private final Runnable onClose;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "comment-panel");
        thread.setDaemon(true);
        return thread;
    });

    private final LinearLayout list;
    private final TextView status;
    private final TextView more;
    private String cursor = "";
    private boolean busy = false;
    private boolean finished = false;
    private int loaded = 0;

    CommentPanel(Context context, DualContentRepository repository, String seriesId,
                 String episodeId, int episodeNumber, Runnable onClose) {
        super(context);
        this.repository = repository;
        this.seriesId = seriesId;
        this.episodeId = episodeId;
        this.episodeNumber = episodeNumber;
        this.onClose = onClose;
        setOrientation(VERTICAL);
        setPadding(dp(16), dp(14), dp(16), dp(12));
        GradientDrawable background = new GradientDrawable();
        background.setColor(0xF2141519);
        background.setCornerRadius(dp(18));
        setBackground(background);

        LinearLayout header = new LinearLayout(context);
        header.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = new TextView(context);
        title.setText("评论 · 第 " + episodeNumber + " 集");
        title.setTextSize(17);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        title.setTextColor(Color.WHITE);
        header.addView(title, new LayoutParams(0, -2, 1));
        TextView close = new TextView(context);
        close.setText("关闭");
        close.setTextSize(13);
        close.setTextColor(0xFFB9BCC4);
        close.setPadding(dp(12), dp(8), dp(4), dp(8));
        close.setOnClickListener(view -> { if (onClose != null) onClose.run(); });
        header.addView(close);
        addView(header, new LayoutParams(-1, -2));

        status = new TextView(context);
        status.setTextSize(12);
        status.setTextColor(0xFF9AA0AA);
        status.setPadding(0, dp(6), 0, dp(8));
        status.setText("正在读取…");
        addView(status, new LayoutParams(-1, -2));

        list = new LinearLayout(context);
        list.setOrientation(VERTICAL);
        ScrollView scroll = new ScrollView(context);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.addView(list, new LayoutParams(-1, -2));
        addView(scroll, new LayoutParams(-1, 0, 1f));

        more = new TextView(context);
        more.setTextSize(13);
        more.setGravity(Gravity.CENTER);
        more.setTextColor(Color.WHITE);
        GradientDrawable button = new GradientDrawable();
        button.setColor(0xFF262A31);
        button.setCornerRadius(dp(12));
        more.setBackground(button);
        more.setPadding(dp(12), dp(10), dp(12), dp(10));
        more.setText("加载更多");
        more.setVisibility(GONE);
        more.setOnClickListener(view -> load());
        addView(more, new LayoutParams(-1, -2));

        load();
    }

    void destroy() {
        worker.shutdownNow();
        main.removeCallbacksAndMessages(null);
    }

    private void load() {
        if (busy || finished || episodeId == null || episodeId.isEmpty()) return;
        busy = true;
        more.setText("正在读取…");
        more.setEnabled(false);
        final String requestCursor = cursor;
        worker.execute(() -> {
            JSONObject result = null;
            String failure = null;
            try {
                result = repository.comments(seriesId, episodeId, requestCursor);
            } catch (Exception error) {
                failure = error.getMessage();
            }
            final JSONObject data = result;
            final String error = failure;
            main.post(() -> {
                busy = false;
                more.setEnabled(true);
                if (data == null) {
                    status.setText(error == null ? "评论暂时无法读取" : error);
                    more.setText("重试");
                    more.setVisibility(VISIBLE);
                    return;
                }
                JSONArray items = data.optJSONArray("items");
                for (int i = 0; items != null && i < items.length(); i++) {
                    JSONObject item = items.optJSONObject(i);
                    if (item != null) addRow(item);
                    loaded += 1;
                }
                String next = data.optString("nextCursor", "");
                boolean hasMore = data.optBoolean("hasMore", false) && !next.isEmpty();
                cursor = next;
                finished = !hasMore;
                long total = data.optLong("total", 0);
                status.setText(loaded == 0 ? "这一集还没有评论"
                        : (total > 0 ? "共 " + total + " 条 · 已显示 " + loaded + " 条" : "已显示 " + loaded + " 条"));
                more.setText(finished ? "已经到底了" : "加载更多");
                more.setVisibility(finished && loaded > 0 ? GONE : VISIBLE);
                if (finished && loaded == 0) more.setVisibility(GONE);
            });
        });
    }

    private void addRow(JSONObject item) {
        LinearLayout row = new LinearLayout(getContext());
        row.setOrientation(VERTICAL);
        row.setPadding(dp(12), dp(10), dp(12), dp(10));
        GradientDrawable card = new GradientDrawable();
        card.setColor(0xFF1D2027);
        card.setCornerRadius(dp(12));
        row.setBackground(card);

        LinearLayout head = new LinearLayout(getContext());
        head.setGravity(Gravity.CENTER_VERTICAL);
        TextView author = new TextView(getContext());
        author.setText(item.optString("author", "匿名用户"));
        author.setTextSize(12);
        author.setTextColor(0xFFFFD45B);
        head.addView(author, new LayoutParams(0, -2, 1));
        TextView when = new TextView(getContext());
        when.setText(relative(item.optLong("created", 0)));
        when.setTextSize(11);
        when.setTextColor(0xFF8A9099);
        head.addView(when);
        row.addView(head, new LayoutParams(-1, -2));

        TextView content = new TextView(getContext());
        content.setText(item.optString("content", ""));
        content.setTextSize(13);
        content.setTextColor(0xFFE6E8EC);
        content.setLineSpacing(dp(2), 1f);
        content.setPadding(0, dp(5), 0, 0);
        row.addView(content, new LayoutParams(-1, -2));

        int likes = item.optInt("likes", 0);
        if (likes > 0) {
            TextView digg = new TextView(getContext());
            digg.setText("赞 " + likes);
            digg.setTextSize(11);
            digg.setTextColor(0xFF8A9099);
            digg.setPadding(0, dp(4), 0, 0);
            row.addView(digg, new LayoutParams(-1, -2));
        }

        LayoutParams params = new LayoutParams(-1, -2);
        params.bottomMargin = dp(8);
        list.addView(row, params);
    }

    private static String relative(long seconds) {
        if (seconds <= 0) return "";
        long at = seconds > 1_000_000_000_000L ? seconds : seconds * 1000L;
        long diff = System.currentTimeMillis() - at;
        if (diff < 0) return "";
        long minute = 60_000L, hour = 60 * minute, day = 24 * hour;
        if (diff < hour) return Math.max(1, diff / minute) + " 分钟前";
        if (diff < day) return (diff / hour) + " 小时前";
        if (diff < 30 * day) return (diff / day) + " 天前";
        java.text.SimpleDateFormat format = new java.text.SimpleDateFormat("M 月 d 日");
        return format.format(new java.util.Date(at));
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
