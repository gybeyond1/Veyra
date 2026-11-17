package com.veyra.gybeyond;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 界面上的小图不需要原图那么大。
 *
 * 电视盒子只有 2.6GB 内存、Java 堆上限 48MB，一张 400×560 的 JPEG 解成位图就是
 * 900KB；一屏一百张海报直接把图形内存打满，系统只能不停丢位图再重解 ——
 * 表现就是「封面一多、按得快就卡，滚动时海报闪一下又出来」。
 *
 * 这里在原生侧按目标宽度降采样后压回 JPEG，单张位图从 900KB 降到 200KB 上下。
 * 手机端不传 w 参数，走的还是原图，完全不受影响。
 */
final class CoverShrink {

    private static final String TAG = "VeyraCover";
    private static final int MAX_CACHE = 120;
    private static final int QUALITY = 82;

    /* 同一个小图会被反复要（翻页回来、重进详情），缓存住免得重复解码压缩 */
    private static final Map<String, String> CACHE =
            new LinkedHashMap<String, String>(32, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, String> eldest) {
                    return size() > MAX_CACHE;
                }
            };

    private CoverShrink() {
    }

    static String fit(String dataUrl, int targetW) {
        if (dataUrl == null || targetW < 64 || !dataUrl.startsWith("data:image/")) return dataUrl;
        int comma = dataUrl.indexOf(',');
        if (comma < 0) return dataUrl;
        String key = targetW + ":" + dataUrl.length() + ":" + dataUrl.hashCode();
        synchronized (CACHE) {
            String hit = CACHE.get(key);
            if (hit != null) return hit;
        }
        try {
            byte[] raw = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT);
            byte[] small = shrink(raw, targetW);
            if (small == null || small.length == 0) return dataUrl;
            String out = "data:image/jpeg;base64," + Base64.encodeToString(small, Base64.NO_WRAP);
            synchronized (CACHE) {
                CACHE.put(key, out);
            }
            return out;
        } catch (Throwable error) {
            /* 缩不了就用原图：宁可多占点内存，也不能让封面空着 */
            Log.w(TAG, "封面缩放失败，退回原图", error);
            return dataUrl;
        }
    }

    private static byte[] shrink(byte[] raw, int targetW) {
        BitmapFactory.Options probe = new BitmapFactory.Options();
        probe.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(raw, 0, raw.length, probe);
        int srcW = probe.outWidth;
        if (srcW <= 0) return null;
        /* 本来就不大：重压一次只会更糊，还白花 CPU */
        if (srcW <= targetW + targetW / 8) return null;

        int sample = 1;
        while (srcW / (sample * 2) >= targetW) sample *= 2;

        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inSampleSize = sample;
        /* 封面都是实色照片，没有透明通道；565 比 8888 再省一半内存 */
        opts.inPreferredConfig = Bitmap.Config.RGB_565;
        Bitmap bitmap = BitmapFactory.decodeByteArray(raw, 0, raw.length, opts);
        if (bitmap == null) return null;

        Bitmap scaled = bitmap;
        try {
            int w = bitmap.getWidth();
            if (w > targetW) {
                int h = Math.max(1, Math.round(bitmap.getHeight() * (targetW / (float) w)));
                scaled = Bitmap.createScaledBitmap(bitmap, targetW, h, true);
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream(raw.length / 2 + 1024);
            if (!scaled.compress(Bitmap.CompressFormat.JPEG, QUALITY, out)) return null;
            return out.toByteArray();
        } finally {
            if (scaled != bitmap) scaled.recycle();
            bitmap.recycle();
        }
    }
}
