package com.veyra.gybeyond;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.view.View;

import java.util.ArrayList;
import java.util.List;

/**
 * 刷剧页「真玻璃」底板。
 *
 * 为什么需要它：刷剧态 WebView 是整页透明的，视频由原生层垫在后面。CSS 的 backdrop-filter
 * 只能采样 WebView 自己那一层的内容，采不到后面那块原生视频 —— 所以底栏 / 悬浮按钮 / 详情卡的
 * 玻璃一直是「半透明实底」，看着像塑料板。
 *
 * 这里的做法：把原生视频帧缩小十几倍再做盒式模糊，然后按 WebView 传上来的圆角矩形逐块裁切绘制。
 * WebView 里的玻璃板只负责很低的底色 + 边缘高光 + 折射描边，两者叠起来才是真的「透过去看到
 * 被模糊的视频」。模糊在 GPU 代价极高的前提下退化成「超小图 + 双线性放大」，视觉上等价，开销可忽略。
 */
public class BingeGlass extends View {

    /** 视频帧缩到这个比例再模糊：1/12 已经足够糊，且每次只有几百个像素要处理。 */
    private static final int DOWNSCALE = 12;

    private final List<float[]> rects = new ArrayList<>();   // {x, y, w, h, radius}，单位 device px
    private final Paint bitmapPaint = new Paint(Paint.FILTER_BITMAP_FLAG | Paint.DITHER_FLAG);
    private final Paint dimPaint = new Paint();
    private final Path clip = new Path();
    private final RectF dst = new RectF();
    private final RectF src = new RectF();

    private Bitmap blurred;
    private int[] pixels;
    private int[] scratch;
    private int dimAlpha = 54;    // 压暗一档：亮画面上的白字也能读

    public BingeGlass(Context context) {
        super(context);
        dimPaint.setStyle(Paint.Style.FILL);
    }

    /** WebView 每次布局变化就把底栏/悬浮按钮/卡片的位置按圆角矩形报上来。 */
    public void setRects(List<float[]> next) {
        rects.clear();
        if (next != null) rects.addAll(next);
        invalidate();
    }

    public void setDimAlpha(int alpha) {
        dimAlpha = Math.max(0, Math.min(160, alpha));
        invalidate();
    }

    /** 送入一帧缩小后的视频画面（直接消费像素，调用方可以复用自己的 Bitmap）。 */
    public void pushFrame(Bitmap frame) {
        if (frame == null || frame.isRecycled()) return;
        int w = frame.getWidth(), h = frame.getHeight();
        if (w < 2 || h < 2) return;
        int count = w * h;
        if (pixels == null || pixels.length != count) {
            pixels = new int[count];
            scratch = new int[count];
        }
        try {
            frame.getPixels(pixels, 0, w, 0, 0, w, h);
        } catch (Throwable error) {
            return;
        }
        // 两遍盒式模糊：小图上跑，成本可以忽略，但把放大后残留的块状感抹掉
        boxPass(pixels, scratch, w, h, 2, true);
        boxPass(scratch, pixels, w, h, 2, false);
        boxPass(pixels, scratch, w, h, 2, true);
        boxPass(scratch, pixels, w, h, 2, false);
        if (blurred == null || blurred.isRecycled()
                || blurred.getWidth() != w || blurred.getHeight() != h) {
            blurred = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        }
        blurred.setPixels(pixels, 0, w, 0, 0, w, h);
        invalidate();
    }

    public void clear() {
        if (blurred != null && !blurred.isRecycled()) blurred.recycle();
        blurred = null;
        rects.clear();
        invalidate();
    }

    @Override protected void onDraw(Canvas canvas) {
        Bitmap source = blurred;
        if (source == null || source.isRecycled() || rects.isEmpty()) return;
        int viewW = getWidth(), viewH = getHeight();
        if (viewW <= 0 || viewH <= 0) return;
        float bw = source.getWidth(), bh = source.getHeight();
        for (int i = 0; i < rects.size(); i++) {
            float[] r = rects.get(i);
            float x = r[0], y = r[1], w = r[2], h = r[3], radius = r[4];
            if (w < 2f || h < 2f) continue;
            clip.reset();
            clip.addRoundRect(x, y, x + w, y + h, Math.max(0f, radius), Math.max(0f, radius),
                    Path.Direction.CW);
            canvas.save();
            canvas.clipPath(clip);
            src.set(x / viewW * bw, y / viewH * bh, (x + w) / viewW * bw, (y + h) / viewH * bh);
            dst.set(x, y, x + w, y + h);
            canvas.drawBitmap(source, src, dst, bitmapPaint);
            if (dimAlpha > 0) {
                dimPaint.setColor(Color.argb(dimAlpha, 0, 0, 0));
                canvas.drawRect(dst, dimPaint);
            }
            canvas.restore();
        }
    }

    private static void boxPass(int[] in, int[] out, int w, int h, int radius, boolean horizontal) {
        int r = Math.max(1, radius);
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int sumR = 0, sumG = 0, sumB = 0, count = 0;
                for (int k = -r; k <= r; k++) {
                    int cx = horizontal ? clamp(x + k, 0, w - 1) : x;
                    int cy = horizontal ? y : clamp(y + k, 0, h - 1);
                    int c = in[cy * w + cx];
                    sumR += (c >> 16) & 0xff;
                    sumG += (c >> 8) & 0xff;
                    sumB += c & 0xff;
                    count++;
                }
                out[y * w + x] = 0xff000000 | ((sumR / count) << 16) | ((sumG / count) << 8) | (sumB / count);
            }
        }
    }

    private static int clamp(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }
}
