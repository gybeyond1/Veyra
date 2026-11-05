package com.veyra.gybeyond;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.util.Size;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.Lifecycle;
import androidx.lifecycle.LifecycleOwner;
import androidx.lifecycle.LifecycleRegistry;

import com.google.common.util.concurrent.ListenableFuture;
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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 手机端扫码：扫另一台设备（电视 / 电脑 / 手机 / 平板）的登录二维码，把本机账号授权过去。
 *
 * 为什么用 CameraX 而不是手搓 Camera2 + TextureView：
 * 预览的「旋转 + 等比缩放」看着简单，实际每一步都踩坑 —— TextureView 默认把 buffer
 * 拉伸到控件大小，setTransform 又叠加在这层拉伸之上，算错一处画面就是歪的、扁的、糊的。
 * 自己推了两版矩阵都不对。PreviewView 内部用 PreviewTransformation 统一处理传感器朝向、
 * 屏幕方向、镜像和裁剪，是 CameraX 团队在大量机型上校准过的逻辑，比自己推公式靠谱。
 *
 * 二维码内容由 MainActivity.tvLoginInfo() 生成：
 *   veyra://tv-login?h=192.168.1.5&p=8765&t=<relay token>&c=<一次性码>&n=<设备名>
 * 扫到之后先弹确认框，用户点「允许登录」才 POST 到那台设备的 http://h:p/login?t=…。
 */
public class QrScanActivity extends Activity implements LifecycleOwner {
    private static final String TAG = "VeyraQrScan";
    private static final int REQUEST_CAMERA = 0x61;
    private static final String HINT_IDLE = "对准另一台设备上的登录二维码（电视 / 电脑 / 平板 / 手机）";

    private final LifecycleRegistry lifecycleRegistry = new LifecycleRegistry(this);
    private final AtomicBoolean handled = new AtomicBoolean(false);
    private final MultiFormatReader decoder = new MultiFormatReader();

    private PreviewView previewView;
    private ProcessCameraProvider cameraProvider;
    private ImageAnalysis analysis;
    private ExecutorService worker;
    private String sessionJson = "";
    private TextView hint;

    /* ---- 二次确认 ---- */
    private View confirmLayer;
    private TextView cardBody;
    private TextView cardPrimary;
    private TextView cardSecondary;
    private TvLogin pending;
    private boolean pushing;
    private int hintToken;

    @Override public Lifecycle getLifecycle() { return lifecycleRegistry; }

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_CREATE);

        sessionJson = getIntent() == null ? "" : getIntent().getStringExtra("session");
        if (sessionJson == null) sessionJson = "";

        FrameLayout root = new FrameLayout(this);
        // 纯黑：FIT_CENTER 上下会留一点边，深灰背景会显出一道"框"
        root.setBackgroundColor(0xFF000000);

        previewView = new PreviewView(this);
        /* FIT_CENTER：完整显示，不裁切也不拉伸。相机看到多大范围，屏幕就显示多大范围。
           方向、镜像、旋转全部由 PreviewView 内部按传感器朝向 + 屏幕方向处理。 */
        previewView.setScaleType(PreviewView.ScaleType.FIT_CENTER);
        // COMPATIBLE 走 TextureView：SurfaceView 在个别机型上切页面会黑一帧
        previewView.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE);
        root.addView(previewView, new FrameLayout.LayoutParams(-1, -1));

        addViewfinder(root);
        addHint(root);
        addCancel(root);
        buildConfirmLayer(root);

        setContentView(root);
    }

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    /** 取景方框只是视觉参考：解码用的是整帧，框外照样能认出来。 */
    private void addViewfinder(FrameLayout root) {
        int screenDp = Math.round(getResources().getDisplayMetrics().widthPixels
                / getResources().getDisplayMetrics().density);
        int side = dp(Math.max(200f, Math.min(320f, screenDp * 0.62f)));

        // 框外压暗：浅色背景上只描一条边根本看不见，用户不知道该把码怼哪儿
        root.addView(new ViewfinderMask(this, side, 0x8C000000),
                new FrameLayout.LayoutParams(-1, -1));

        View frame = new View(this);
        GradientDrawable border = new GradientDrawable();
        border.setColor(0x00000000);
        border.setStroke(dp(2), 0xCCFFD277);
        border.setCornerRadius(dp(18));
        frame.setBackground(border);
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(side, side);
        params.gravity = Gravity.CENTER;
        root.addView(frame, params);
    }

    /** 取景框外的一层半透明遮罩：中间留一个圆角方洞。 */
    private static final class ViewfinderMask extends View {
        private final int side;
        private final Paint paint = new Paint();

        ViewfinderMask(Context context, int side, int color) {
            super(context);
            this.side = side;
            paint.setColor(color);
            paint.setStyle(Paint.Style.FILL);
            paint.setAntiAlias(true);
        }

        @Override protected void onDraw(Canvas canvas) {
            int w = getWidth();
            int h = getHeight();
            int left = (w - side) / 2;
            int top = (h - side) / 2;
            float radius = side * 0.075f;
            // EVEN_ODD：外圈矩形 + 内圈圆角矩形，重叠部分被挖空
            Path path = new Path();
            path.setFillType(Path.FillType.EVEN_ODD);
            path.addRect(0f, 0f, w, h, Path.Direction.CW);
            path.addRoundRect(left, top, left + side, top + side, radius, radius, Path.Direction.CW);
            canvas.drawPath(path, paint);
        }
    }

    private void addHint(FrameLayout root) {
        hint = new TextView(this);
        hint.setText(HINT_IDLE);
        hint.setTextColor(0xFFF3EFE4);
        hint.setTextSize(15f);
        hint.setGravity(Gravity.CENTER);
        hint.setShadowLayer(dp(6), 0f, dp(1), 0xCC000000);
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(-1, -2);
        params.gravity = Gravity.BOTTOM;
        params.bottomMargin = dp(56);
        params.leftMargin = dp(24);
        params.rightMargin = dp(24);
        root.addView(hint, params);
    }

    private void addCancel(FrameLayout root) {
        TextView cancel = new TextView(this);
        cancel.setText("取消");
        cancel.setTextColor(0xFFC89B3C);
        cancel.setTextSize(16f);
        cancel.setGravity(Gravity.CENTER);
        cancel.setPadding(dp(14), dp(8), dp(14), dp(8));
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(-2, -2);
        params.gravity = Gravity.TOP | Gravity.END;
        params.topMargin = dp(12);
        params.rightMargin = dp(12);
        cancel.setOnClickListener(v -> finishWith(false, "已取消"));
        root.addView(cancel, params);
    }

    /* ---------------- 二次确认 ---------------- */

    private void buildConfirmLayer(FrameLayout root) {
        /* 卡片必须放进这个容器里，不能跟遮罩平级：
           否则 setVisibility(GONE) 只藏了遮罩，卡片照样挂在屏幕上。 */
        FrameLayout layer = new FrameLayout(this);
        layer.setBackgroundColor(0xC4000000);
        layer.setVisibility(View.GONE);
        layer.setClickable(true);
        root.addView(layer, new FrameLayout.LayoutParams(-1, -1));
        confirmLayer = layer;

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable background = new GradientDrawable();
        background.setColor(0xFF191C21);
        background.setCornerRadius(dp(20));
        background.setStroke(dp(1), 0x40FFD277);
        card.setBackground(background);
        card.setPadding(dp(22), dp(20), dp(22), dp(14));
        card.setClickable(true);

        TextView title = new TextView(this);
        title.setText("允许登录这台设备？");
        title.setTextColor(0xFFF3EFE4);
        title.setTextSize(19f);
        card.addView(title, new LinearLayout.LayoutParams(-1, -2));

        cardBody = new TextView(this);
        cardBody.setTextColor(0xFFB9B2A4);
        cardBody.setTextSize(14f);
        cardBody.setLineSpacing(dp(4), 1f);
        LinearLayout.LayoutParams bodyParams = new LinearLayout.LayoutParams(-1, -2);
        bodyParams.topMargin = dp(10);
        card.addView(cardBody, bodyParams);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.END);
        LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(-1, -2);
        rowParams.topMargin = dp(18);

        cardSecondary = new TextView(this);
        cardSecondary.setText("取消");
        cardSecondary.setTextColor(0xFFC89B3C);
        cardSecondary.setTextSize(15f);
        cardSecondary.setGravity(Gravity.CENTER);
        cardSecondary.setPadding(dp(16), dp(10), dp(16), dp(10));
        row.addView(cardSecondary, new LinearLayout.LayoutParams(-2, -2));

        cardPrimary = new TextView(this);
        cardPrimary.setText("允许登录");
        cardPrimary.setTextColor(0xFF141519);
        cardPrimary.setTextSize(15f);
        cardPrimary.setGravity(Gravity.CENTER);
        cardPrimary.setPadding(dp(20), dp(10), dp(20), dp(10));
        GradientDrawable primaryBg = new GradientDrawable();
        primaryBg.setColor(0xFFC89B3C);
        primaryBg.setCornerRadius(dp(12));
        cardPrimary.setBackground(primaryBg);
        LinearLayout.LayoutParams primaryParams = new LinearLayout.LayoutParams(-2, -2);
        primaryParams.leftMargin = dp(8);
        row.addView(cardPrimary, primaryParams);

        card.addView(row, rowParams);

        int width = Math.min(dp(340),
                getResources().getDisplayMetrics().widthPixels - dp(48));
        FrameLayout.LayoutParams cardParams = new FrameLayout.LayoutParams(width, -2);
        cardParams.gravity = Gravity.CENTER;
        layer.addView(card, cardParams);

        cardSecondary.setOnClickListener(v -> {
            // 请求已经发出去了就别让它"取消"了 —— 那头电视可能已经登上了
            if (pushing) return;
            resetScan();
        });
        cardPrimary.setOnClickListener(v -> doPush());
    }

    private void showConfirm(final TvLogin login) {
        if (login == null) return;   // 没扫到东西就绝不弹框
        pending = login;
        pushing = false;
        hint.setVisibility(View.INVISIBLE);
        confirmLayer.setVisibility(View.VISIBLE);
        cardBody.setTextColor(0xFFB9B2A4);
        cardBody.setText(login.label() + "\n\n允许后这台设备会用你手机上的账号登录，"
                + "你随时可以在那台设备上退出。");
        cardPrimary.setText("允许登录");
        cardPrimary.setEnabled(true);
        cardPrimary.setAlpha(1f);
        cardSecondary.setText("取消");
        cardSecondary.setEnabled(true);
        cardSecondary.setAlpha(1f);
    }

    private void hideConfirm() {
        confirmLayer.setVisibility(View.GONE);
        hint.setVisibility(View.VISIBLE);
    }

    /** 放弃这次扫码，回到取景状态继续扫。 */
    private void resetScan() {
        pending = null;
        pushing = false;
        hideConfirm();
        hint.setText(HINT_IDLE);
        hint.setTextColor(0xFFF3EFE4);
        handled.set(false);
    }

    private void doPush() {
        final TvLogin login = pending;
        if (login == null || pushing) return;
        pushing = true;
        cardPrimary.setEnabled(false);
        cardPrimary.setAlpha(0.6f);
        cardPrimary.setText("登录中…");
        cardSecondary.setEnabled(false);
        cardSecondary.setAlpha(0.4f);
        cardBody.setTextColor(0xFFB9B2A4);
        cardBody.setText("正在把这台手机的账号授权给 " + login.name + "，请稍候…");

        new Thread(() -> {
            try {
                push(login.host, login.port, login.token, login.code);
                finishWith(true, "已登录 " + login.name);
            } catch (Exception error) {
                final String message = error.getMessage() == null ? "登录失败" : error.getMessage();
                runOnUiThread(() -> {
                    if (isFinishing()) return;
                    pushing = false;
                    cardPrimary.setEnabled(true);
                    cardPrimary.setAlpha(1f);
                    cardPrimary.setText("重试");
                    cardSecondary.setEnabled(true);
                    cardSecondary.setAlpha(1f);
                    cardSecondary.setText("重新扫描");
                    cardBody.setTextColor(0xFFFF9C8A);
                    cardBody.setText(message);
                });
            }
        }, "veyra-scan-push").start();
    }

    /* ---------------- 相机 ---------------- */

    @Override protected void onStart() {
        super.onStart();
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_START);
    }

    @Override protected void onResume() {
        super.onResume();
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_RESUME);
        if (hasPermission()) startCamera();
        else requestPermissions(new String[]{Manifest.permission.CAMERA}, REQUEST_CAMERA);
    }

    @Override protected void onPause() {
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_PAUSE);
        super.onPause();
    }

    @Override protected void onStop() {
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_STOP);
        super.onStop();
    }

    @Override protected void onDestroy() {
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_DESTROY);
        if (worker != null) {
            worker.shutdown();
            worker = null;
        }
        super.onDestroy();
    }

    private boolean hasPermission() {
        return checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != REQUEST_CAMERA) return;
        if (results.length == 0 || results[0] != PackageManager.PERMISSION_GRANTED) {
            finishWith(false, "没有相机权限，无法扫码");
            return;
        }
        startCamera();
    }

    private void startCamera() {
        if (cameraProvider != null) {
            bindUseCases();
            return;
        }
        final ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(this);
        future.addListener(() -> {
            try {
                cameraProvider = future.get();
                bindUseCases();
            } catch (Exception error) {
                Log.w(TAG, "ProcessCameraProvider", error);
                finishWith(false, "相机启动失败");
            }
        }, ContextCompat.getMainExecutor(this));
    }

    private void bindUseCases() {
        ProcessCameraProvider provider = cameraProvider;
        if (provider == null || isFinishing()) return;

        Preview preview = new Preview.Builder().build();
        preview.setSurfaceProvider(previewView.getSurfaceProvider());

        if (worker == null) {
            worker = Executors.newSingleThreadExecutor(task -> {
                Thread thread = new Thread(task, "veyra-scan");
                thread.setDaemon(true);
                return thread;
            });
        }

        // 720p 足够认二维码：再大只会让每帧解码更慢
        ImageAnalysis.Builder builder = new ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888);
        try {
            builder.setTargetResolution(new Size(1280, 720));
        } catch (Exception ignored) {
            // 个别版本不支持指定分辨率，用默认的就行
        }

        analysis = builder.build();
        analysis.setAnalyzer(worker, this::analyze);

        try {
            provider.unbindAll();
            provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis);
        } catch (Exception error) {
            Log.w(TAG, "bindToLifecycle", error);
            finishWith(false, "相机不可用：" + error.getClass().getSimpleName());
        }
    }

    /* ---------------- 解码 ---------------- */

    private void analyze(ImageProxy image) {
        try {
            if (!handled.get()) {
                String text = decode(image);
                if (text != null && handled.compareAndSet(false, true)) onCode(text);
            }
        } catch (Exception error) {
            Log.w(TAG, "decode", error);
        } finally {
            image.close();
        }
    }

    /** 只取 Y 平面做灰度解码。rowStride / pixelStride 都可能大于宽度，要按步长搬一次。 */
    private String decode(ImageProxy image) {
        ImageProxy.PlaneProxy plane = image.getPlanes()[0];
        ByteBuffer buffer = plane.getBuffer();
        int width = image.getWidth();
        int height = image.getHeight();
        int rowStride = plane.getRowStride();
        int pixelStride = plane.getPixelStride();
        int size = width * height;
        byte[] data = new byte[size];

        buffer.rewind();
        if (pixelStride == 1 && rowStride == width) {
            buffer.get(data, 0, Math.min(size, buffer.remaining()));
        } else {
            for (int y = 0; y < height; y++) {
                int rowStart = y * rowStride;
                if (rowStart >= buffer.limit()) break;
                int out = y * width;
                for (int x = 0; x < width; x++) {
                    int index = rowStart + x * pixelStride;
                    if (index >= buffer.limit()) break;
                    data[out + x] = buffer.get(index);
                }
            }
        }

        /* 不按 rotationDegrees 旋转：二维码有三个定位图案，zxing 的 Detector 靠它们
           自己算透视变换，横着、倒着都能认，少一次整帧旋转就少一次内存拷贝。 */
        try {
            decoder.reset();
            PlanarYUVLuminanceSource source =
                    new PlanarYUVLuminanceSource(data, width, height, 0, 0, width, height, false);
            return decoder.decodeWithState(new BinaryBitmap(new HybridBinarizer(source))).getText();
        } catch (Exception notFound) {
            return null;
        }
    }

    /** 解出内容：先校验是不是电视登录码，再弹确认框 —— 不做「扫到就登录」。 */
    private void onCode(String text) {
        final TvLogin login;
        try {
            login = TvLogin.parse(text);
        } catch (IllegalArgumentException error) {
            flashHint(error.getMessage() == null ? "这不是电视登录码" : error.getMessage());
            handled.set(false);
            return;
        }
        runOnUiThread(() -> showConfirm(login));
    }

    private void flashHint(String text) {
        final int token = ++hintToken;
        runOnUiThread(() -> {
            hint.setText(text);
            hint.setTextColor(0xFFFF9C8A);
            hint.postDelayed(() -> {
                if (token != hintToken || isFinishing()) return;
                hint.setText(HINT_IDLE);
                hint.setTextColor(0xFFF3EFE4);
            }, 2000);
        });
    }

    @Override public void onBackPressed() {
        if (confirmLayer != null && confirmLayer.getVisibility() == View.VISIBLE) {
            if (!pushing) resetScan();
            return;
        }
        finishWith(false, "已取消");
    }

    /* ---------------- 登录请求 ---------------- */

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
            if (status == 403) throw new IllegalStateException("二维码已失效，请在另一台设备上重新打开");
            if (status == 410) throw new IllegalStateException("登录码已过期，请刷新另一台设备上的二维码");
            if (status != 200) throw new IllegalStateException("那台设备没有接受登录（" + status + "）");
            if (!response.contains("\"ok\":true")) throw new IllegalStateException("那台设备返回异常");
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

    /** 二维码里承载的登录信息。n 是设备名，老版本码没有就退回 IP。 */
    private static final class TvLogin {
        final String host;
        final int port;
        final String token;
        final String code;
        final String name;

        TvLogin(String host, int port, String token, String code, String name) {
            this.host = host;
            this.port = port;
            this.token = token;
            this.code = code;
            this.name = name;
        }

        static TvLogin parse(String text) {
            Uri uri = Uri.parse(text.trim());
            if (!"veyra".equals(uri.getScheme()) || !"tv-login".equals(uri.getHost()))
                throw new IllegalArgumentException("这不是 Veyra 登录码");
            String host = uri.getQueryParameter("h");
            String port = uri.getQueryParameter("p");
            String token = uri.getQueryParameter("t");
            String code = uri.getQueryParameter("c");
            if (host == null || port == null || token == null || code == null)
                throw new IllegalArgumentException("登录码不完整，请刷新二维码");
            int portNumber;
            try {
                portNumber = Integer.parseInt(port);
            } catch (NumberFormatException error) {
                throw new IllegalArgumentException("登录码里的端口不对，请刷新二维码");
            }
            String name = uri.getQueryParameter("n");
            if (name == null || name.trim().isEmpty()) name = host;
            return new TvLogin(host, portNumber, token, code, name.trim());
        }

        String label() {
            return name + "（" + host + "）";
        }
    }

    private void finishWith(boolean ok, String message) {
        runOnUiThread(() -> {
            Intent result = new Intent();
            result.putExtra("message", message == null ? "" : message);
            setResult(ok ? RESULT_OK : RESULT_CANCELED, result);
            finish();
        });
    }
}
