package com.veyra.gybeyond;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.text.TextPaint;
import android.view.View;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 时间轴弹幕覆盖层。
 *
 * 数据来自 commentapi 的 comment_type=20（每条带 offset_time 毫秒），按 30 秒一段向后取，
 * 播放时整段喂进来。绘制按「已过时间 / 横穿时长」算横向位置，车道在灌数据时一次分好，
 * 不同字号/区域改动会重排车道。
 *
 * 没有任何写接口：只读、匿名、不登录。
 */
final class DanmakuView extends View {
    static final class Item {
        final String text;
        final long timeMS;
        int lane;
        long laneFreeAt;

        Item(String text, long timeMS) {
            this.text = text;
            this.timeMS = timeMS;
        }
    }

    /** 一条弹幕从右侧进到左侧出所需的毫秒数。 */
    private static final long TRAVEL_MS = 9000L;

    private final List<Item> items = new ArrayList<>();
    private final TextPaint fill = new TextPaint(Paint.ANTI_ALIAS_FLAG);
    private final TextPaint stroke = new TextPaint(Paint.ANTI_ALIAS_FLAG);
    private final Paint.FontMetrics metrics = new Paint.FontMetrics();

    private final float density;
    private int fontSize = 22;
    private int fixedLanes = 0;
    private String area = "top";
    private int alphaPercent = 85;
    private boolean merge = true;
    private boolean enabled = true;

    long positionMS = 0L;
    private long baseAt = 0L;
    private boolean animating = false;
    private boolean relayoutPending = false;

    private int laneCount = 6;
    private float laneHeight = 0f;
    private float areaTop = 0f;
    private float areaBottom = 0f;

    DanmakuView(Context context) {
        super(context);
        density = context.getResources().getDisplayMetrics().density;
        fill.setColor(Color.WHITE);
        stroke.setColor(0xCC000000);
        stroke.setStyle(Paint.Style.STROKE);
        stroke.setStrokeWidth(Math.max(2f, 3.2f * density));
        applyStyle();
        setWillNotDraw(false);
    }

    /** 开关：关掉时整层隐藏，也不再去画。 */
    void setDanmakuEnabled(boolean value) {
        enabled = value;
        setVisibility(value ? VISIBLE : GONE);
        invalidate();
    }

    boolean danmakuEnabled() { return enabled; }

    void setFontSize(int sp) {
        fontSize = Math.max(12, Math.min(48, sp));
        applyStyle();
        relayout();
    }

    int fontSize() { return fontSize; }

    void setLanes(int value) {
        fixedLanes = Math.max(0, Math.min(20, value));
        relayout();
    }

    int lanes() { return fixedLanes; }

    void setArea(String value) {
        area = value == null ? "top" : value;
        relayout();
    }

    String area() { return area; }

    void setAlphaPercent(int value) {
        alphaPercent = Math.max(20, Math.min(100, value));
        applyStyle();
    }

    int alphaPercent() { return alphaPercent; }

    void setMerge(boolean value) {
        merge = value;
        relayout();
    }

    boolean merge() { return merge; }

    private void applyStyle() {
        fill.setTextSize(fontSize * density);
        stroke.setTextSize(fontSize * density);
        fill.setAlpha(Math.round(255 * alphaPercent / 100f));
        stroke.setAlpha(Math.round(255 * alphaPercent / 100f));
        fill.getFontMetrics(metrics);
    }

    /** 整段替换（同一集换集时用）。 */
    void setItems(List<Item> values) {
        items.clear();
        if (values != null) items.addAll(values);
        items.sort(Comparator.comparingLong(item -> item.timeMS));
        relayout();
        invalidate();
    }

    /** 追加下一段（30 秒一批）。 */
    void appendItems(List<Item> values) {
        if (values == null || values.isEmpty()) return;
        items.addAll(values);
        items.sort(Comparator.comparingLong(item -> item.timeMS));
        relayout();
        invalidate();
    }

    void clear() {
        items.clear();
        positionMS = 0L;
        baseAt = android.os.SystemClock.elapsedRealtime();
        invalidate();
    }

    /** 播放中开启：帧间自己按墙钟推算位置，滚动才连续。 */
    void setAnimating(boolean value) {
        long now = android.os.SystemClock.elapsedRealtime();
        positionMS = playhead();
        baseAt = now;
        animating = value;
        invalidate();
    }

    /** 当前播放位置：暂停时等于最后一次 setPosition，播放中按墙钟向前推。 */
    private long playhead() {
        if (!animating) return positionMS;
        return positionMS + Math.max(0L, android.os.SystemClock.elapsedRealtime() - baseAt);
    }

    void setPosition(long ms) {
        long now = android.os.SystemClock.elapsedRealtime();
        long value = Math.max(0L, ms);
        if (value == positionMS && animating) return;
        positionMS = value;
        baseAt = now;
        if (enabled) invalidate();
    }

    /** 车道与区域：字号/密度变化后重排，避免叠字。 */
    private void relayout() {
        if (getHeight() == 0 || getWidth() == 0) {
            /* 还没量到尺寸（或当前是 GONE）：等下一次布局，别排一串 post 空转。 */
            if (!relayoutPending && getVisibility() == VISIBLE && getWidth() == 0) {
                relayoutPending = true;
                post(() -> { relayoutPending = false; relayout(); });
            }
            return;
        }
        laneHeight = (fontSize * density) * 1.55f;
        float height = getHeight();
        switch (area == null ? "top" : area) {
            case "middle":
                areaTop = height * 0.30f;
                areaBottom = height * 0.72f;
                break;
            case "bottom":
                areaTop = height * 0.55f;
                areaBottom = height * 0.94f;
                break;
            case "full":
                areaTop = height * 0.04f;
                areaBottom = height * 0.94f;
                break;
            default:
                areaTop = height * 0.06f;
                areaBottom = height * 0.46f;
                break;
        }
        int fit = Math.max(1, (int) ((areaBottom - areaTop) / laneHeight));
        laneCount = fixedLanes > 0 ? Math.min(fixedLanes, fit) : Math.min(fit, 8);

        /* 每条弹幕占一条车道，直到这条车道上一条已经走完。 */
        List<Long> freeAt = new ArrayList<>();
        for (int i = 0; i < laneCount; i++) freeAt.add(0L);
        Map<String, Integer> merged = new HashMap<>();
        List<Item> source = new ArrayList<>(items);
        items.clear();
        for (Item item : source) {
            Item target = item;
            if (merge) {
                Integer seen = merged.get(item.text);
                if (seen != null) {
                    /* 相同内容合并成一条并标注次数，避免整屏重复。 */
                    String label = item.text + " ×" + (seen + 1);
                    boolean exists = false;
                    for (int i = items.size() - 1; i >= 0 && i >= items.size() - 40; i--) {
                        if (items.get(i).text.startsWith(item.text)) { exists = true; break; }
                    }
                    if (exists) { merged.put(item.text, seen + 1); continue; }
                    target = new Item(label, item.timeMS);
                }
                merged.put(item.text, 1);
            }
            int lane = -1;
            for (int i = 0; i < laneCount; i++) {
                if (freeAt.get(i) <= target.timeMS) { lane = i; break; }
            }
            if (lane < 0) {
                /* 全满就放到最早空出来的那条，宁可稀疏一点也不叠。 */
                lane = 0;
                long earliest = Long.MAX_VALUE;
                for (int i = 0; i < laneCount; i++) {
                    if (freeAt.get(i) < earliest) { earliest = freeAt.get(i); lane = i; }
                }
            }
            target.lane = lane;
            freeAt.set(lane, target.timeMS + TRAVEL_MS);
            items.add(target);
        }
        items.sort(Comparator.comparingLong(item -> item.timeMS));
        invalidate();
    }

    @Override
    protected void onSizeChanged(int width, int height, int oldWidth, int oldHeight) {
        super.onSizeChanged(width, height, oldWidth, oldHeight);
        relayout();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        if (!enabled || getWidth() == 0) return;
        int alpha = Math.round(255 * alphaPercent / 100f);
        fill.setAlpha(alpha);
        stroke.setAlpha(alpha);
        long now = playhead();
        if (!items.isEmpty()) {
            long from = now - TRAVEL_MS;
            int start = lowerBound(from);
            float width = getWidth();
            for (int i = start; i < items.size(); i++) {
                Item item = items.get(i);
                long elapsed = now - item.timeMS;
                if (elapsed < 0) break;
                if (elapsed > TRAVEL_MS) continue;
                float textWidth = fill.measureText(item.text);
                float travel = width + textWidth;
                float x = width - travel * (elapsed / (float) TRAVEL_MS);
                float baseline = areaTop + item.lane * laneHeight
                        - metrics.ascent + (laneHeight - (metrics.descent - metrics.ascent)) / 2f;
                canvas.drawText(item.text, x, baseline, stroke);
                canvas.drawText(item.text, x, baseline, fill);
            }
        }
        if (animating) postInvalidateOnAnimation();
    }

    private int lowerBound(long timeMS) {
        int low = 0, high = items.size() - 1, answer = items.size();
        while (low <= high) {
            int mid = (low + high) >>> 1;
            if (items.get(mid).timeMS >= timeMS) { answer = mid; high = mid - 1; }
            else low = mid + 1;
        }
        return answer;
    }
}
