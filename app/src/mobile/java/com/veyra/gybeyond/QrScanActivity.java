package com.veyra.gybeyond;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Canvas;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.SurfaceTexture;
import android.graphics.drawable.GradientDrawable;
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
import android.view.TextureView;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
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
 *   veyra://tv-login?h=192.168.1.5&p=8765&t=<relay token>&c=<一次性码>&n=<电视名>
 * 扫到之后先弹确认框，用户点「允许登录」才 POST 到电视的 http://h:p/login?t=…，
 * 和「扫码输入」共用同一条通道。
 */
public class QrScanActivity extends Activity implements TextureView.SurfaceTextureListener {
    private static final String TAG = "VeyraQrScan";
    private static final int REQUEST_CAMERA = 0x61;
    private static final String HINT_IDLE = "对准电视上的二维码，让码落在方框内";

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
    /** 解码用的相机流尺寸（≈720p）：够认二维码，又不至于每帧都吃满 CPU。 */
    private Size previewSize;
    /**
     * 预览显示用的相机流尺寸。和解码分开选：解码要小（快），显示要大（清楚）。
     * 以前两者共用一个尺寸，遇到只给 640x480 / 1080p 的机型就挑成 640x480，
     * 铺到 1080 宽的屏幕上放两三倍，肉眼就是一层糊。
     */
    private Size previewBuffer;
    /** 预览画面要顺时针转多少度才对得上现实，由 SENSOR_ORIENTATION 和屏幕方向算出来。 */
    private int rotationDegrees = 90;
    /** 混合尺寸配置失败时退回单尺寸（宁可解码慢点，也别打不开）。 */
    private boolean fallbackSingle;

    /* ---- 二次确认 ---- */
    private View confirmLayer;
    private TextView cardTitle;
    private TextView cardBody;
    private TextView cardPrimary;
    private TextView cardSecondary;
    private TvLogin pending;
    private boolean pushing;
    private int hintToken;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        sessionJson = getIntent() == null ? "" : getIntent().getStringExtra("session");
        if (sessionJson == null) sessionJson = "";

        FrameLayout root = new FrameLayout(this);
        // 纯黑：画面按完整比例居中时上下会留一点边，深灰背景会显出一道"框"
        root.setBackgroundColor(0xFF000000);

        preview = new TextureView(this);
        // 不透明：TextureView 默认半透明，扫码这种全屏预览开不透明省一次混合
        preview.setOpaque(true);
        preview.setSurfaceTextureListener(this);
        root.addView(preview, new FrameLayout.LayoutParams(-1, -1));
        // 布局稳定之前 getWidth() 可能还是 0 或旧值，那时算出来的矩阵会把画面摆歪。
        // 尺寸一变就重算一次，代价是一次矩阵运算。
        preview.addOnLayoutChangeListener((v, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> {
            if (right - left != oldRight - oldLeft || bottom - top != oldBottom - oldTop) {
                configureTransform(previewBuffer);
            }
        });

        addViewfinder(root);
        addHint(root);
        addCancel(root);
        buildConfirmLayer(root);

        setContentView(root);
    }

    /** 取景方框只是视觉参考：解码用的是整帧，框外照样能认出来。 */
    private void addViewfinder(FrameLayout root) {
        // 按屏幕宽度取边长：手机上约六成宽，平板不会缩成一个小方块
        int screenDp = Math.round(getResources().getDisplayMetrics().widthPixels
                / getResources().getDisplayMetrics().density);
        int side = dp(Math.max(200f, Math.min(320f, screenDp * 0.62f)));

        /* 框外压暗：只描个边在浅色背景上几乎看不见，用户不知道该把码怼哪儿。
           微信那种暗角靠的就是这个，框内保持原亮度。 */
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

    /** 取景框外的一层半透明遮罩：中间留一个方形洞。 */
    private static final class ViewfinderMask extends View {
        private final int side;
        private final Paint paint = new Paint();

        ViewfinderMask(Context context, int side, int color) {
            super(context);
            this.side = side;
            paint.setColor(color);
            paint.setStyle(Paint.Style.FILL);
        }

        @Override protected void onDraw(Canvas canvas) {
            int w = getWidth();
            int h = getHeight();
            int left = (w - side) / 2;
            int top = (h - side) / 2;
            float radius = side * 0.075f;
            // EVEN_ODD：外圈矩形 + 内圈圆角矩形，重叠区域被挖空，正好留出一个圆角取景洞
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

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    /* ---------------- 二次确认 ---------------- */

    /**
     * 扫到码之后不能直接登录：先让用户看清是哪台电视、再点允许。
     * 卡片自己搭而不是用 AlertDialog：系统对话框的主题色跟这个全屏取景页差太远。
     */
    private void buildConfirmLayer(FrameLayout root) {
        /* 卡片必须放进这个容器里，不能跟遮罩平级：
           否则 setVisibility(GONE) 只藏了遮罩，卡片照样挂在屏幕上 —— v0.24.8 就是这么翻的，
           一进扫码页就顶着一张「允许登录电视？」。 */
        FrameLayout layer = new FrameLayout(this);
        layer.setBackgroundColor(0xC4000000);
        layer.setVisibility(View.GONE);
        layer.setClickable(true);   // 吃掉点击，别点穿到相机
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

        cardTitle = new TextView(this);
        cardTitle.setText("允许登录电视？");
        cardTitle.setTextColor(0xFFF3EFE4);
        cardTitle.setTextSize(19f);
        card.addView(cardTitle, new LinearLayout.LayoutParams(-1, -2));

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
            // 请求已经发出去了就别让它"取消"了 —— 那头电视可能已经登上了，
            // 这时候关掉卡片只会让用户以为没生效。
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
        cardTitle.setText("允许登录电视？");
        cardBody.setTextColor(0xFFB9B2A4);
        cardBody.setText(login.label() + "\n\n允许后这台电视会用你手机上的账号登录，"
                + "你随时可以在电视上退出。");
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
        cardBody.setText("正在把这台手机的账号授权给电视，请稍候…");

        new Thread(() -> {
            try {
                push(login.host, login.port, login.token, login.code);
                finishWith(true, "已登录电视");
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
        configureTransform(previewBuffer);
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

            Size decode = new Size(1280, 720);
            if (map != null) {
                Size[] yuv = map.getOutputSizes(ImageFormat.YUV_420_888);
                if (yuv != null && yuv.length > 0) decode = pickSize(yuv);
            }
            // 回退模式：两个 target 用同一个尺寸，避免部分机型配不出混合尺寸
            Size[] yuvSizes = map == null ? null : map.getOutputSizes(ImageFormat.YUV_420_888);
            if (fallbackSingle) decode = largest(decode, yuvSizes);
            previewSize = decode;

            Size buffer = decode;
            if (!fallbackSingle && map != null) {
                Size shown = pickPreviewSize(map.getOutputSizes(SurfaceTexture.class));
                if (shown != null) buffer = shown;
            }
            previewBuffer = buffer;

            // 方向不能拍脑袋写死 90°：不同机型的传感器朝向有 90° 也有 270°，
            // 写死的话前者正、后者上下颠倒。按官方公式算。
            Integer sensor = characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION);
            rotationDegrees = rotationFor(sensor == null ? 90 : sensor);

            /* 预览改走 TextureView：相机流尺寸由 setDefaultBufferSize 固定，
               画面怎么摆由 Matrix 决定（等比缩放 + 旋转 + 居中裁剪），
               不再指望 SurfaceView 的尺寸去"凑"相机比例。 */
            SurfaceTexture texture = preview.getSurfaceTexture();
            if (texture == null) return;
            texture.setDefaultBufferSize(buffer.getWidth(), buffer.getHeight());
            if (previewSurface != null) previewSurface.release();
            previewSurface = new Surface(texture);
            configureTransform(buffer);

            cameraThread = new HandlerThread("veyra-scan");
            cameraThread.start();
            cameraHandler = new Handler(cameraThread.getLooper());

            reader = ImageReader.newInstance(decode.getWidth(), decode.getHeight(), ImageFormat.YUV_420_888, 2);
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

    /** 选一个面积最接近 720p 的解码尺寸：太大解码慢，太小认不出二维码。 */
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
     * 显示用的尺寸：宁可多花一点电，也别让画面放大后发糊。
     *
     * 两条硬指标：横向比例要接近屏幕（16:9 铺 20:9 的屏幕只裁两边，4:3 则要放大裁一半），
     * 分辨率不能明显小于屏幕（小了就只能是"放大的糊"）。同分时选小的，省电。
     */
    private Size pickPreviewSize(Size[] sizes) {
        if (sizes == null || sizes.length == 0) return null;
        int viewW = preview == null ? 0 : preview.getWidth();
        int viewH = preview == null ? 0 : preview.getHeight();
        if (viewW <= 0 || viewH <= 0) {
            viewW = getResources().getDisplayMetrics().widthPixels;
            viewH = getResources().getDisplayMetrics().heightPixels;
        }
        int needShort = Math.min(viewW, viewH);
        int needLong = Math.max(viewW, viewH);
        double targetAspect = (double) needShort / needLong;

        Size best = null;
        double bestScore = Double.MAX_VALUE;
        for (Size size : sizes) {
            int shortSide = Math.min(size.getWidth(), size.getHeight());
            int longSide = Math.max(size.getWidth(), size.getHeight());
            if (longSide > 4096 || shortSide > 2160) continue;   // 4K 预览只会更烫，没有收益
            if (shortSide * 3 < needShort * 2) continue;          // 比屏幕短边还小三分之一，必然糊
            double score = Math.abs((double) shortSide / longSide - targetAspect) * 10;
            if (shortSide < needShort || longSide < needLong) score += 3;   // 盖不住屏幕，得放大
            score += (double) longSide / 4000.0;                  // 同样合格时选小的
            if (score < bestScore) { bestScore = score; best = size; }
        }
        return best;
    }

    /** 回退用：同一组尺寸里挑一个不小于 base、又不超过 1080p 的最大项。 */
    private static Size largest(Size base, Size[] sizes) {
        if (sizes == null || sizes.length == 0) return base;
        Size best = base;
        for (Size size : sizes) {
            long area = (long) size.getWidth() * size.getHeight();
            if (area < (long) base.getWidth() * base.getHeight()) continue;
            if (area > 1920L * 1080L) continue;
            if (area > (long) best.getWidth() * best.getHeight()) best = size;
        }
        return best;
    }

    /** 后摄：传感器朝向减去屏幕方向，就是预览要顺时针转的角度。 */
    private int rotationFor(int sensorOrientation) {
        int rotation = 0;
        android.view.Display display = preview == null ? null : preview.getDisplay();
        if (display != null) {
            rotation = display.getRotation();
        } else if (getWindowManager() != null) {
            rotation = getWindowManager().getDefaultDisplay().getRotation();
        }
        int degrees;
        switch (rotation) {
            case Surface.ROTATION_90: degrees = 90; break;
            case Surface.ROTATION_180: degrees = 180; break;
            case Surface.ROTATION_270: degrees = 270; break;
            default: degrees = 0; break;
        }
        return (sensorOrientation - degrees + 360) % 360;
    }

    /**
     * 把预览画面摆正。
     *
     * 这里有个必须记住的前提：**TextureView 默认会把相机 buffer 直接拉伸到控件大小**
     * （1280x720 的横向流铺到 1080x2400 的竖屏上，默认就是一根被拉长的面条）。
     * 所以第一步必须用 setRectToRect 把这段"默认拉伸"抵消掉、还原 buffer 的原始比例，
     * 再以控件中心为轴做旋转和等比缩放。少了这一步，无论后面怎么算都是歪的、扁的。
     *
     * 缩放用 min 而不是 max：宁可上下留一点黑边，也要让取景范围跟你眼睛看到的一致。
     * 用 max 会裁掉左右约两成视野，人会本能觉得"这画面不对"。
     */
    private void configureTransform(Size buffer) {
        if (preview == null || buffer == null) return;
        int viewW = preview.getWidth();
        int viewH = preview.getHeight();
        if (viewW <= 0 || viewH <= 0) return;

        RectF viewRect = new RectF(0f, 0f, viewW, viewH);
        RectF bufferRect = new RectF(0f, 0f, buffer.getWidth(), buffer.getHeight());
        float centerX = viewRect.centerX();
        float centerY = viewRect.centerY();

        // buffer 矩形的左上角先挪到控件中心，后面旋转/缩放都以控件中心为轴，画面才不会跑偏
        bufferRect.offset(centerX - bufferRect.centerX(), centerY - bufferRect.centerY());

        Matrix matrix = new Matrix();
        matrix.setRectToRect(viewRect, bufferRect, Matrix.ScaleToFit.FILL);

        boolean quarter = rotationDegrees % 180 != 0;
        // 转过 90°/270° 后画面占的宽高要对调过来算
        float shownW = quarter ? buffer.getHeight() : buffer.getWidth();
        float shownH = quarter ? buffer.getWidth() : buffer.getHeight();
        float scale = Math.min(viewW / shownW, viewH / shownH);

        matrix.postScale(scale, scale, centerX, centerY);
        if (rotationDegrees != 0) matrix.postRotate(rotationDegrees, centerX, centerY);
        preview.setTransform(matrix);
    }

    @Override public void onConfigurationChanged(android.content.res.Configuration configuration) {
        super.onConfigurationChanged(configuration);
        closeCamera();
        if (preview != null) preview.post(this::openCamera);
    }

    @Override public void onBackPressed() {
        if (confirmLayer != null && confirmLayer.getVisibility() == View.VISIBLE) {
            resetScan();
            return;
        }
        finishWith(false, "已取消");
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
                            // 少数机型配不出「预览 1080p + 解码 720p」这种混合尺寸，
                            // 退回单尺寸再开一次：画面略糊，但至少扫得了。
                            if (!fallbackSingle) {
                                fallbackSingle = true;
                                Log.w(TAG, "混合尺寸配置失败，回退单尺寸");
                                closeCamera();
                                if (preview != null) preview.post(() -> { surfaceReady = true; openCamera(); });
                                return;
                            }
                            finishWith(false, "相机预览配置失败");
                        }
                    }, cameraHandler);
        } catch (CameraAccessException | IllegalStateException error) {
            Log.w(TAG, "startPreview", error);
            finishWith(false, "相机预览失败");
        }
    }

    /* ---------------- 解码 ---------------- */

    private void onImage(ImageReader source) {
        Image image = null;
        try {
            image = source.acquireLatestImage();
            if (image == null || handled.get()) return;
            String text = decode(image);
            if (text != null && handled.compareAndSet(false, true)) onCode(text);
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

    /** 二维码里承载的登录信息。n 是电视名，老版本码没有就退回 IP。 */
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
                throw new IllegalArgumentException("这不是电视登录码");
            String host = uri.getQueryParameter("h");
            String port = uri.getQueryParameter("p");
            String token = uri.getQueryParameter("t");
            String code = uri.getQueryParameter("c");
            if (host == null || port == null || token == null || code == null)
                throw new IllegalArgumentException("登录码不完整，请刷新电视上的二维码");
            int portNumber;
            try {
                portNumber = Integer.parseInt(port);
            } catch (NumberFormatException error) {
                throw new IllegalArgumentException("登录码里的端口不对，请刷新电视上的二维码");
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
