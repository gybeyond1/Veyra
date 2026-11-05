package com.veyra.gybeyond;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.util.Base64;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;

/**
 * 电视首页自定义背景。
 *
 * <p>用户在手机上选一张图，经局域网通道传上来（限的是通道，不是图片 —— 上传多大都收），
 * 这里负责把它转成页面能直接用的东西：先按长边缩到 1920，再压成 JPEG 存盘，
 * 最后给出 data URL。电视盒子的 WebView 不能跨域读本地文件，data URL 最稳，
 * 也避免为了一个背景再开一条 file:// 通道。</p>
 *
 * <p>只留一份文件（tv-bg.jpg），换图直接覆盖：用户要的是「现在这张」，
 * 不需要历史版本，也不会把电视那点存储慢慢吃满。</p>
 */
final class TvBackground {
    private static final String TAG = "VeyraTvBg";
    private static final String FILE_NAME = "tv-bg.jpg";
    private static final int MAX_EDGE = 1920;
    private static final int JPEG_QUALITY = 88;

    private TvBackground() { }

    static File file(Context context) {
        return new File(context.getFilesDir(), FILE_NAME);
    }

    static boolean has(Context context) {
        File file = file(context);
        return file.isFile() && file.length() > 0;
    }

    static void clear(Context context) {
        try {
            File file = file(context);
            if (file.exists() && !file.delete()) Log.w(TAG, "旧背景删不掉");
        } catch (Exception ignored) { }
    }

    /** 页面要的 data URL；没有图时返回空串。 */
    static String dataUrl(Context context) {
        File file = file(context);
        if (!file.isFile() || file.length() <= 0) return "";
        FileInputStream input = null;
        try {
            input = new FileInputStream(file);
            ByteArrayOutputStream buffer = new ByteArrayOutputStream((int) Math.max(1024, file.length()));
            byte[] chunk = new byte[64 * 1024];
            int read;
            while ((read = input.read(chunk)) > 0) buffer.write(chunk, 0, read);
            return "data:image/jpeg;base64," + Base64.encodeToString(buffer.toByteArray(), Base64.NO_WRAP);
        } catch (Exception error) {
            Log.w(TAG, "读背景失败", error);
            return "";
        } finally {
            if (input != null) try { input.close(); } catch (IOException ignored) { }
        }
    }

    /**
     * 收下来的原图 → 缩放 + 转正 + 压缩 → 存盘。返回新图的 data URL。
     * 任何尺寸都能进：先只读文件头拿宽高，按需要做 inSampleSize，绝不整张大图直接进内存。
     */
    static String save(Context context, File source) throws IOException {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(source.getAbsolutePath(), bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw new IOException("不是能识别的图片");

        int longest = Math.max(bounds.outWidth, bounds.outHeight);
        int sample = 1;
        while (longest / (sample * 2) >= MAX_EDGE) sample *= 2;

        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sample;
        Bitmap bitmap = BitmapFactory.decodeFile(source.getAbsolutePath(), options);
        if (bitmap == null) throw new IOException("图片解码失败");

        bitmap = rotateByExif(source, bitmap);
        bitmap = shrink(bitmap);

        File target = file(context);
        File temp = new File(target.getAbsolutePath() + ".tmp");
        FileOutputStream output = null;
        try {
            output = new FileOutputStream(temp);
            if (!bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, output)) throw new IOException("压缩失败");
        } finally {
            if (output != null) try { output.close(); } catch (IOException ignored) { }
            bitmap.recycle();
        }
        if (target.exists() && !target.delete()) Log.w(TAG, "旧背景删不掉");
        if (!temp.renameTo(target)) throw new IOException("写背景失败");
        return dataUrl(context);
    }

    /** 手机竖拍的照片像素是横的，方向写在 EXIF 里；不转正的话电视上会歪 90 度。 */
    private static Bitmap rotateByExif(File source, Bitmap bitmap) {
        int degrees;
        try {
            ExifInterface exif = new ExifInterface(source.getAbsolutePath());
            int orientation = exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
            switch (orientation) {
                case ExifInterface.ORIENTATION_ROTATE_90: degrees = 90; break;
                case ExifInterface.ORIENTATION_ROTATE_180: degrees = 180; break;
                case ExifInterface.ORIENTATION_ROTATE_270: degrees = 270; break;
                default: degrees = 0;
            }
        } catch (Exception error) {
            return bitmap;
        }
        if (degrees == 0) return bitmap;
        try {
            Matrix matrix = new Matrix();
            matrix.postRotate(degrees);
            Bitmap rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), matrix, true);
            if (rotated != bitmap) bitmap.recycle();
            return rotated;
        } catch (Throwable error) {
            return bitmap;
        }
    }

    private static Bitmap shrink(Bitmap bitmap) {
        int width = bitmap.getWidth();
        int height = bitmap.getHeight();
        int longest = Math.max(width, height);
        if (longest <= MAX_EDGE) return bitmap;
        float scale = MAX_EDGE / (float) longest;
        int targetWidth = Math.max(1, Math.round(width * scale));
        int targetHeight = Math.max(1, Math.round(height * scale));
        try {
            Bitmap scaled = Bitmap.createScaledBitmap(bitmap, targetWidth, targetHeight, true);
            if (scaled != bitmap) bitmap.recycle();
            return scaled;
        } catch (Throwable error) {
            return bitmap;
        }
    }
}
