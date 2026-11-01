package com.veyra.gybeyond;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.ImageFormat;
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
import android.util.Log;
import android.util.Size;
import android.view.Gravity;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
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
public class QrScanActivity extends Activity implements SurfaceHolder.Callback {
    private static final String TAG = "VeyraQrScan";
    private static final int REQUEST_CAMERA = 0x61;

    private SurfaceView preview;
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

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        sessionJson = getIntent() == null ? "" : getIntent().getStringExtra("session");
        if (sessionJson == null) sessionJson = "";

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF101216);

        preview = new SurfaceView(this);
        preview.getHolder().addCallback(this);
        root.addView(preview, new FrameLayout.LayoutParams(-1, -1));

        hint = new TextView(this);
        hint.setText("对准电视上的二维码");
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

    @Override public void surfaceCreated(SurfaceHolder holder) {
        surfaceReady = true;
        openCamera();
    }

    @Override public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) { }

    @Override public void surfaceDestroyed(SurfaceHolder holder) {
        surfaceReady = false;
        closeCamera();
    }

    private void openCamera() {
        if (!surfaceReady || camera != null) return;
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return;
        Surface previewSurface = preview.getHolder().getSurface();
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
