package com.veyra.gybeyond;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.DisplayMetrics;
import android.util.Log;
import android.util.Size;
import android.view.Gravity;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.TextView;

import com.google.zxing.BinaryBitmap;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.common.HybridBinarizer;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 手机端扫码：扫电视上的登录二维码，把本机账号授权过去。
 *
 * 为什么不用 zxing-android-embedded：那套要拖进 appcompat（+1.5MB），而这里只
 * 需要一个取景框 + 一次解码。Camera2 + zxing core 足够，包体只涨 600KB。
 *
 * 二维码内容由 MainActivity.tvLoginInfo() 生成：
 *   veyra://tv-login?h=192.168.1.5&p=8765&t=<relay token>&c=<一次性码>
 * 扫到之后直接 POST 到电视的 http://h:p/login?t=…，和「扫码输入」共用同一条通道。
 */
public class QrScanActivity extends Activity implements TextureView.SurfaceTextureListener {
    private static final String TAG = "VeyraQrScan";
    private static final int REQUEST_CAMERA = 0x61;

    private TextureView preview;
    private Surface previewSurface;
    private TextView hint;
    private CameraDevice camera;
    private CameraCaptureSession session;
    private ImageReader reader;
    private HandlerThread cameraThread;
    private Handler cameraHandler;
    private final AtomicBoolean handled = new AtomicBoolean(false);
    private final MultiFormatReader decoder = new MultiFormatReader();
    private String sessionJson = "";
    private boolean surfaceReady;
    /** 相机出流的尺寸；预览按它的比例缩放，比例只由 Matrix 决定。 */
    private Size previewSize;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        sessionJson = getIntent() == null ? "" : getIntent().getStringExtra("session");
        if (sessionJson == null) sessionJson = "";

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF101216);

        preview = new TextureView(this);
        // 不透明：TextureView 默认半透明，扫码这种全屏预览开不透明省一次混合
        preview.setOpaque(true);
        preview.setSurfaceTextureListener(this);
        root.addView(preview, new FrameLayout.LayoutParams(-1, -1));

        /* 取景方框只是视觉参考：解码用的是整帧，框外照样能认出来。
           有了它才知道该把电视上的码怼到画面中间。 */
        View frame = new View(this);
        android.graphics.drawable.GradientDrawable border = new android.graphics.drawable.GradientDrawable();
        border.setColor(0x00000000);
        border.setStroke(dp(2), 0x99FFD277);
        border.setCornerRadius(dp(18));
        frame.setBackground(border);
        FrameLayout.LayoutParams frameParams = new FrameLayout.LayoutParams(dp(240), dp(240));
        frameParams.gravity = Gravity.CENTER;
        root.addView(frame, frameParams);

        hint = new TextView(this);
        hint.setText("对准电视上的二维码，让码落在方框内");
        hint.setTextColor(0xFFF3EFE4);
        hint.setTextSize(15f);
        hint.setGravity(Gravity.CENTER);
        FrameLayout.LayoutParams hintParams = new FrameLayout.LayoutParams(-1, -2);
        hintParams.gravity = Gravity.BOTTOM;
        hintParams.bottomMargin = dp(56);
        root.addView(hint, hintParams);

        TextView cancel = new TextView(this);
        cancel.setText("取消");
        cancel.setTextColor(0xFFC89B3C);
        cancel.setTextSize(16f);
        cancel.setGravity(Gravity.CENTER);
        FrameLayout.LayoutParams cancelParams = new FrameLayout.LayoutParams(-2, -2);
        cancelParams.gravity = Gravity.TOP | Gravity.END;
        cancelParams.topMargin = dp(18);
        cancelParams.rightMargin = dp(22);
        cancel.setOnClickListener(v -> finishWith(false, "已取消"));
        root.addView(cancel, cancelParams);

        setContentView(root);
    }

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override protected void onResume() {
        super.onResume();
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQUEST_CAMERA);
        }
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != REQUEST_CAMERA) return;
        if (results.length == 0 || results[0] != PackageManager.PERMISSION_GRANTED) {
            finishWith(false, "没有相机权限，无法扫码");
            return;
        }
        openCamera();
    }

    @Override public void onSurfaceTextureAvailable(SurfaceTexture texture, int width, int height) {
        surfaceReady = true;
        openCamera();
    }

    @Override public void onSurfaceTextureSizeChanged(SurfaceTexture texture, int width, int height) {
        // 转屏、分屏：按新尺寸重新摆一次，别让画面跟着窗口变形
        configureTransform(previewSize);
    }

    @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture texture) {
        surfaceReady = false;
        closeCamera();
        return true;
    }

    @Override public void onSurfaceTextureUpdated(SurfaceTexture texture) {
    }

    private void openCamera() {
        if (!surfaceReady || camera != null) return;
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return;

        try {
            CameraManager manager = (CameraManager) getSystemService(CAMERA_SERVICE);
            String id = null;
            for (String candidate : manager.getCameraIdList()) {
                CameraCharacteristics characteristics = manager.getCameraCharacteristics(candidate);
                Integer facing = characteristics.get(CameraCharacteristics.LENS_FACING);
                if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) { id = candidate; break; }
                if (id == null) id = candidate;
            }
            if (id == null) { finishWith(false, "这台设备没有可用的相机"); return; }

            CameraCharacteristics characteristics = manager.getCameraCharacteristics(id);
            StreamConfigurationMap map = characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            Size size = new Size(1280, 720);
            if (map != null) {
                Size[] sizes = map.getOutputSizes(ImageFormat.YUV_420_888);
                if (sizes != null && sizes.length > 0) size = pickSize(sizes);
            }
            previewSize = size;

            /* 预览改走 TextureView：相机流尺寸由 setDefaultBufferSize 固定，
               画面怎么摆由 Matrix 决定（等比缩放 + 旋转 + 居中裁剪），
               不再指望 SurfaceView 的尺寸去"凑"相机比例 —— 那条路在部分机型上
               会被系统再拉伸一次，于是画面就成了瘦长条。 */
            SurfaceTexture texture = preview.getSurfaceTexture();
            if (texture == null) return;
            texture.setDefaultBufferSize(size.getWidth(), size.getHeight());
            if (previewSurface != null) previewSurface.release();
            previewSurface = new Surface(texture);
            configureTransform(size);

            cameraThread = new HandlerThread("veyra-scan");
            cameraThread.start();
            cameraHandler = new Handler(cameraThread.getLooper());

            reader = ImageReader.newInstance(size.getWidth(), size.getHeight(), ImageFormat.YUV_420_888, 2);
            reader.setOnImageAvailableListener(this::onImage, cameraHandler);

            manager.openCamera(id, new CameraDevice.StateCallback() {
                @Override public void onOpened(CameraDevice device) {
                    camera = device;
                    startPreview(previewSurface);
                }

                @Override public void onDisconnected(CameraDevice device) {
                    device.close();
                    camera = null;
                }

                @Override public void onError(CameraDevice device, int error) {
                    device.close();
                    camera = null;
                    finishWith(false, "相机启动失败（" + error + "）");
                }
            }, cameraHandler);
        } catch (CameraAccessException | SecurityException | IllegalArgumentException error) {
            Log.w(TAG, "openCamera", error);
            finishWith(false, "相机不可用：" + error.getClass().getSimpleName());
        }
    }

    /** 选一个面积最接近 720p 的预览尺寸：太大解码慢，太小认不出二维码。 */
    private static Size pickSize(Size[] sizes) {
        Size best = sizes[0];
        long target = 1280L * 720L;
        long delta = Long.MAX_VALUE;
        for (Size size : sizes) {
            long area = (long) size.getWidth() * size.getHeight();
            long diff = Math.abs(area - target);
            if (diff < delta) { delta = diff; best = size; }
        }
        return best;
    }

    /**
     * 把预览画面摆正：等比缩放 → 旋转 90°（竖屏）→ 居中裁剪铺满。
     *
     * 关键在于「比例只由 Matrix 说话」：相机流是 1280x720 的横向画面，
     * 竖屏下要转 90° 才正，缩放系数取 max(viewW/bufferW, viewH/bufferH)，
     * 这样画面一定填满、且横竖比例不会被改。多出来的部分由 TextureView 自己裁掉。
     */
    private void configureTransform(Size size) {
        if (preview == null || size == null) return;
        int viewW = preview.getWidth();
        int viewH = preview.getHeight();
        if (viewW <= 0 || viewH <= 0) return;

        int rotation = getWindowManager().getDefaultDisplay().getRotation();
        boolean rotate = rotation == Surface.ROTATION_0 || rotation == Surface.ROTATION_180;
        float bufferW = rotate ? size.getHeight() : size.getWidth();
        float bufferH = rotate ? size.getWidth() : size.getHeight();

        Matrix matrix = new Matrix();
        // 先把 buffer 的原点挪到画面中心，旋转再缩放，最后放回控件中心
        matrix.postTranslate(-size.getWidth() / 2f, -size.getHeight() / 2f);
        if (rotate) matrix.postRotate(90f);
        float scale = Math.max(viewW / bufferW, viewH / bufferH);
        matrix.postScale(scale, scale);
        matrix.postTranslate(viewW / 2f, viewH / 2f);
        preview.setTransform(matrix);
    }

    @Override public void onConfigurationChanged(android.content.res.Configuration configuration) {
        super.onConfigurationChanged(configuration);
        closeCamera();
        if (preview != null) preview.post(this::openCamera);
    }

    private void startPreview(Surface previewSurface) {
        CameraDevice device = camera;
        if (device == null || reader == null) return;
        try {
            CaptureRequest.Builder builder = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            builder.addTarget(previewSurface);
            builder.addTarget(reader.getSurface());
            builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
            builder.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON);
            device.createCaptureSession(Arrays.asList(previewSurface, reader.getSurface()),
                    new CameraCaptureSession.StateCallback() {
                        @Override public void onConfigured(CameraCaptureSession ready) {
                            session = ready;
                            try { ready.setRepeatingRequest(builder.build(), null, cameraHandler); }
                            catch (CameraAccessException | IllegalStateException error) { Log.w(TAG, "setRepeatingRequest", error); }
                        }

                        @Override public void onConfigureFailed(CameraCaptureSession failed) {
                            finishWith(false, "相机预览配置失败");
                        }
                    }, cameraHandler);
        } catch (CameraAccessException | IllegalStateException error) {
            Log.w(TAG, "startPreview", error);
            finishWith(false, "相机预览失败");
        }
    }

    private void onImage(ImageReader source) {
        Image image = null;
        try {
            image = source.acquireLatestImage();
            if (image == null || handled.get()) return;
            String text = decode(image);
            if (text != null && handled.compareAndSet(false, true)) submit(text);
        } catch (Exception error) {
            Log.w(TAG, "decode", error);
        } finally {
            if (image != null) image.close();
        }
    }

    /** 只取 Y 平面做灰度解码；rowStride 可能大于宽度，要按行搬一次。 */
    private String decode(Image image) {
        Image.Plane plane = image.getPlanes()[0];
        ByteBuffer buffer = plane.getBuffer();
        int width = image.getWidth();
        int height = image.getHeight();
        int rowStride = plane.getRowStride();
        int total = buffer.remaining();
        byte[] raw = new byte[total];
        buffer.get(raw);
        byte[] data = raw;
        if (rowStride != width) {
            data = new byte[width * height];
            for (int y = 0; y < height; y++) {
                int from = y * rowStride;
                if (from + width > raw.length) break;
                System.arraycopy(raw, from, data, y * width, width);
            }
        }
        try {
            decoder.reset();
            PlanarYUVLuminanceSource source = new PlanarYUVLuminanceSource(data, width, height, 0, 0, width, height, false);
            return decoder.decodeWithState(new BinaryBitmap(new HybridBinarizer(source))).getText();
        } catch (Exception notFound) {
            return null;
        }
    }

    /** 后台线程：解析二维码 → 推给电视 → 回结果给主界面。 */
    private void submit(String text) {
        runOnUiThread(() -> hint.setText("正在把账号授权给电视…"));
        new Thread(() -> {
            try {
                Uri uri = Uri.parse(text.trim());
                if (!"veyra".equals(uri.getScheme()) || !"tv-login".equals(uri.getHost()))
                    throw new IllegalArgumentException("这不是电视登录码");
                String host = uri.getQueryParameter("h");
                String port = uri.getQueryParameter("p");
                String relayToken = uri.getQueryParameter("t");
                String code = uri.getQueryParameter("c");
                if (host == null || port == null || relayToken == null || code == null)
                    throw new IllegalArgumentException("登录码不完整，请刷新电视上的二维码");
                push(host, Integer.parseInt(port), relayToken, code);
                finishWith(true, "已登录电视");
            } catch (Exception error) {
                String message = error.getMessage() == null ? "扫码失败" : error.getMessage();
                finishWith(false, message);
            }
        }, "veyra-scan-push").start();
    }

    private void push(String host, int port, String relayToken, String code) throws Exception {
        JSONObject session = new JSONObject(sessionJson);
        JSONObject body = new JSONObject()
                .put("code", code)
                .put("token", session.optString("token"))
                .put("server", session.optString("server"))
                .put("user", session.optJSONObject("user"));
        URL url = new URL("http://" + host + ":" + port + "/login?t=" + Uri.encode(relayToken));
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(6000);
            connection.setReadTimeout(6000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int status = connection.getResponseCode();
            InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String response = read(input);
            if (status == 403) throw new IllegalStateException("二维码已失效，请在电视上重新打开");
            if (status == 410) throw new IllegalStateException("登录码已过期，请刷新电视上的二维码");
            if (status != 200) throw new IllegalStateException("电视没有接受登录（" + status + "）");
            if (!response.contains("\"ok\":true")) throw new IllegalStateException("电视返回异常");
        } finally {
            connection.disconnect();
        }
    }

    private static String read(InputStream input) throws Exception {
        if (input == null) return "";
        try (InputStream source = input; ByteArrayOutputStream buffer = new ByteArrayOutputStream()) {
            byte[] chunk = new byte[2048];
            int count;
            while ((count = source.read(chunk)) > 0) buffer.write(chunk, 0, count);
            return new String(buffer.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private void finishWith(boolean ok, String message) {
        runOnUiThread(() -> {
            closeCamera();
            Intent result = new Intent();
            result.putExtra("message", message == null ? "" : message);
            setResult(ok ? RESULT_OK : RESULT_CANCELED, result);
            finish();
        });
    }

    private void closeCamera() {
        try { if (session != null) session.close(); } catch (Exception ignored) { }
        session = null;
        try { if (camera != null) camera.close(); } catch (Exception ignored) { }
        camera = null;
        try { if (reader != null) reader.close(); } catch (Exception ignored) { }
        reader = null;
        if (previewSurface != null) { previewSurface.release(); previewSurface = null; }
        if (cameraThread != null) {
            cameraThread.quitSafely();
            cameraThread = null;
            cameraHandler = null;
        }
    }

    @Override protected void onDestroy() {
        closeCamera();
        super.onDestroy();
    }
}
