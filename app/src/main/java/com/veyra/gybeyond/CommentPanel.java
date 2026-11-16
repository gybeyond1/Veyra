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
    /** 电视端：三米外看，字号和行距都要放大，操作全交给遥控器。 */
    private final boolean tv;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "comment-panel");
        thread.setDaemon(true);
        return thread;
    });

    private final LinearLayout list;
    private final TextView status;
    private final TextView more;
    private View firstRow;
    private String cursor = "";
    private boolean busy = false;
    private boolean finished = false;
    private int loaded = 0;

    CommentPanel(Context context, DualContentRepository repository, String seriesId,
                 String episodeId, int episodeNumber, boolean tv) {
        super(context);
        this.repository = repository;
        this.seriesId = seriesId;
        this.episodeId = episodeId;
        this.episodeNumber = episodeNumber;
        this.tv = tv;
        setOrientation(VERTICAL);
        setPadding(dp(tv ? 32 : 16), dp(tv ? 28 : 14), dp(tv ? 32 : 16), dp(tv ? 22 : 12));
        GradientDrawable background = new GradientDrawable();
        background.setColor(tv ? 0xFF121316 : 0xF2141519);
        background.setCornerRadius(dp(tv ? 22 : 18));
        if (tv) background.setStroke(dp(2), 0xFF796D53);
        setBackground(background);

        LinearLayout header = new LinearLayout(context);
        header.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = new TextView(context);
        title.setText("评论 · 第 " + episodeNumber + " 集");
        title.setTextSize(tv ? 26 : 17);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        title.setTextColor(Color.WHITE);
        header.addView(title, new LayoutParams(0, -2, 1));
        /* 不给关闭按钮：手机上点评论外面就收，电视上按返回就收。
           三米外多一颗只能靠遥控器挪过去点的按钮，纯粹是负担。 */
        addView(header, new LayoutParams(-1, -2));

        status = new TextView(context);
        status.setTextSize(tv ? 16 : 12);
        status.setTextColor(0xFF9AA0AA);
        status.setPadding(0, dp(tv ? 12 : 6), 0, dp(tv ? 14 : 8));
        status.setText("正在读取…");
        addView(status, new LayoutParams(-1, -2));

        list = new LinearLayout(context);
        list.setOrientation(VERTICAL);
        ScrollView scroll = new ScrollView(context);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.setClipToPadding(false);
        scroll.addView(list, new LayoutParams(-1, -2));
        addView(scroll, new LayoutParams(-1, 0, 1f));

        more = new TextView(context);
        more.setTextSize(tv ? 19 : 13);
        more.setGravity(Gravity.CENTER);
        more.setTextColor(Color.WHITE);
        GradientDrawable button = new GradientDrawable();
        button.setColor(0xFF262A31);
        button.setCornerRadius(dp(tv ? 16 : 12));
        more.setBackground(button);
        more.setPadding(dp(12), dp(tv ? 18 : 10), dp(12), dp(tv ? 18 : 10));
        more.setText("加载更多");
        more.setVisibility(GONE);
        if (tv) {
            more.setFocusable(true);
            more.setFocusableInTouchMode(false);
            more.setOnFocusChangeListener((view, hasFocus) -> {
                GradientDrawable face = new GradientDrawable();
                face.setColor(hasFocus ? 0xFF3A4048 : 0xFF262A31);
                face.setCornerRadius(dp(16));
                if (hasFocus) face.setStroke(dp(2), 0xFFFFD45B);
                view.setBackground(face);
            });
        }
        more.setOnClickListener(view -> load());
        addView(more, new LayoutParams(-1, -2));

        load();
    }

    /** 打开面板时把遥控器焦点放到第一条评论上；一条都没有就落到「加载更多/重试」。 */
    void focusDefault() {
        if (firstRow != null && firstRow.isAttachedToWindow()) { firstRow.requestFocus(); return; }
        if (more != null && more.getVisibility() == VISIBLE) more.requestFocus();
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
        row.setPadding(dp(tv ? 20 : 12), dp(tv ? 16 : 10), dp(tv ? 20 : 12), dp(tv ? 16 : 10));
        GradientDrawable card = new GradientDrawable();
        card.setColor(0xFF1D2027);
        card.setCornerRadius(dp(tv ? 16 : 12));
        row.setBackground(card);
        /* 电视端没有手指，只能靠遥控器上下走：每条评论自己可聚焦，ScrollView 才会自动滚。 */
        row.setFocusable(tv);
        row.setFocusableInTouchMode(false);
        GradientDrawable focused = new GradientDrawable();
        focused.setColor(0xFF262B33);
        focused.setCornerRadius(dp(tv ? 16 : 12));
        focused.setStroke(dp(tv ? 3 : 2), 0xFFFFD45B);
        row.setOnFocusChangeListener((view, hasFocus) -> view.setBackground(hasFocus ? focused : card));

        LinearLayout head = new LinearLayout(getContext());
        head.setGravity(Gravity.CENTER_VERTICAL);
        TextView author = new TextView(getContext());
        author.setText(item.optString("author", "匿名用户"));
        author.setTextSize(tv ? 18 : 12);
        author.setTextColor(0xFFFFD45B);
        head.addView(author, new LayoutParams(0, -2, 1));
        TextView when = new TextView(getContext());
        when.setText(relative(item.optLong("created", 0)));
        when.setTextSize(tv ? 14 : 11);
        when.setTextColor(0xFF8A9099);
        head.addView(when);
        row.addView(head, new LayoutParams(-1, -2));

        TextView content = new TextView(getContext());
        content.setText(item.optString("content", ""));
        content.setTextSize(tv ? 19 : 13);
        content.setTextColor(0xFFE6E8EC);
        content.setLineSpacing(dp(tv ? 5 : 2), 1f);
        content.setPadding(0, dp(tv ? 9 : 5), 0, 0);
        row.addView(content, new LayoutParams(-1, -2));

        int likes = item.optInt("likes", 0);
        if (likes > 0) {
            TextView digg = new TextView(getContext());
            digg.setText("赞 " + likes);
            digg.setTextSize(tv ? 14 : 11);
            digg.setTextColor(0xFF8A9099);
            digg.setPadding(0, dp(tv ? 7 : 4), 0, 0);
            row.addView(digg, new LayoutParams(-1, -2));
        }

        if (tv && firstRow == null) firstRow = row;
        LayoutParams params = new LayoutParams(-1, -2);
        params.bottomMargin = dp(tv ? 14 : 8);
        list.addView(row, params);
        if (tv && firstRow == row) {
            /* 面板先开、评论后到：数据回来时把焦点从「正在读取」挪到第一条评论上 */
            View current = getRootView().findFocus();
            if (current == null || current == more) row.post(row::requestFocus);
        }
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
