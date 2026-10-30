package com.veyra.gybeyond;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.ActivityNotFoundException;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.net.Uri;
import android.provider.Settings;
import android.util.Log;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.RoundedCorner;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.JsResult;
import android.window.BackEvent;
import android.window.OnBackAnimationCallback;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;
import android.widget.FrameLayout;
import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebResourceResponse;
import android.webkit.WebResourceError;
import android.webkit.RenderProcessGoneDetail;
import org.json.JSONTokener;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URL;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final String TAG = "HuangGuo";
    private static final int AVATAR_PICKER = 7101;
    private static final int BINGE_REQUEST = 7102;
    private final ExecutorService requests = Executors.newFixedThreadPool(4);
    private final ExecutorService localRequests = Executors.newSingleThreadExecutor();
    private final ExecutorService coverRequests = Executors.newFixedThreadPool(2);
    private WebView webView;
    private FrameLayout root;
    private DualContentRepository repository;
    private AppStore store;
    private AccountService account;
    private UpdateManager updates;
    private HotUpdateManager hotUpdates;
    private HotUpdateManager.Session hotSession;
    private boolean migratingOrigin;
    private boolean resourceReady;
    private final Handler hotHandler = new Handler(Looper.getMainLooper());
    private final Runnable resourceTimeout = () -> recoverResources();
    private File pendingUpdateApk;
    private OnBackInvokedCallback backCallback;
    private boolean backRegistered;
    private int backProgressGeneration;
    private float pendingBackProgress = -1f;
    private boolean backProgressInFlight;
    private int backViewLeft;
    private int backViewWidth;
    private float backLeadPx;
    private volatile float statusBarInsetDp;
    private boolean detailSystemBars;

    /** 全局崩溃日志：任何未捕获 Throwable（含 native 崩前能到 Java 层的 Error）都写入 filesDir/crash.log，
     *  app.js 启动时经 "crash-log" bridge 读取展示，便于排查闪退。每次启动先清空并写版本头：日志永远只属于当前版本。 */
    private void installCrashLogger() {
        try {
            // 每次启动清空旧 crash.log 并写入版本头：区分新旧版本日志，避免历史残留误导排查
            try {
                String ver = "unknown";
                try { ver = getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception ignored) { }
                java.io.File f0 = new java.io.File(getFilesDir(), "crash.log");
                java.io.FileOutputStream fos0 = new java.io.FileOutputStream(f0, false);
                fos0.write(("=== Veyra " + ver + " 启动于 "
                        + new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.US).format(new java.util.Date()) + " ===\n").getBytes("UTF-8"));
                fos0.close();
            } catch (Exception ignored) { }
            Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
            Thread.setDefaultUncaughtExceptionHandler((thread, throwable) -> {
                try {
                    StringBuilder sb = new StringBuilder();
                    sb.append("time=").append(System.currentTimeMillis()).append(" thread=").append(thread.getName()).append('\n');
                    java.io.StringWriter sw = new java.io.StringWriter();
                    throwable.printStackTrace(new java.io.PrintWriter(sw));
                    sb.append(sw);
                    sb.append('\n');
                    java.io.File f = new java.io.File(getFilesDir(), "crash.log");
                    java.io.FileOutputStream fos = new java.io.FileOutputStream(f, true);
                    fos.write(sb.toString().getBytes("UTF-8"));
                    fos.close();
                    // 单独写一份"上次崩溃"快照：覆盖写、启动不清空，供下次启动原生弹窗展示 + 一键复制
                    java.io.File flast = new java.io.File(getFilesDir(), "crash_last.log");
                    java.io.FileOutputStream fosl = new java.io.FileOutputStream(flast, false);
                    fosl.write(sb.toString().getBytes("UTF-8"));
                    fosl.close();
                    android.util.Log.e(TAG, "uncaught crash", throwable);
                } catch (Exception ignored) { }
                if (prev != null) prev.uncaughtException(thread, throwable);
            });
        } catch (Exception ignored) { }
    }

    private String crashLog() {
        try {
            StringBuilder sb = new StringBuilder();
            java.io.File f = new java.io.File(getFilesDir(), "crash.log");
            if (f.exists()) {
                byte[] b = java.nio.file.Files.readAllBytes(f.toPath());
                String s = new String(b, "UTF-8");
                // 启动版本头（=== Veyra x 启动于 ===）不是崩溃；真正的未捕获异常以 "time=" 开头。
                // 只有存在真实堆栈时才返回，避免每次启动误报"上次崩溃"并写剪贴板。
                int idx = s.indexOf("time=");
                if (idx >= 0) sb.append(s.substring(idx));
            }
            // 注意：filesDir/native.log 是合并引擎的普通阶段日志，不是崩溃日志，不再作为崩溃提示来源。
            return sb.toString();
        } catch (Exception e) { return ""; }
    }

    /** 读取上次崩溃快照（crash_last.log，覆盖写、启动不清空），无则返回 null。 */
    private String readCrashLast() {
        try {
            java.io.File f = new java.io.File(getFilesDir(), "crash_last.log");
            if (!f.exists() || f.length() == 0) return null;
            byte[] b = new byte[(int) f.length()];
            java.io.FileInputStream fis = new java.io.FileInputStream(f);
            try { fis.read(b); } finally { fis.close(); }
            String s = new String(b, "UTF-8").trim();
            return s.isEmpty() ? null : s;
        } catch (Exception e) { return null; }
    }

    /** 启动时检查上次崩溃：有快照则弹窗展示，支持一键复制。 */
    private void checkLastCrash() {
        hotHandler.postDelayed(() -> {
            if (isDestroyed() || isFinishing()) return;
            String log = readCrashLast();
            if (log == null) return;
            showCrashDialog(log);
        }, 700);
    }

    private void showCrashDialog(String log) {
        try {
            android.widget.TextView tv = new android.widget.TextView(this);
            tv.setText(log);
            tv.setTextIsSelectable(true);
            tv.setTypeface(android.graphics.Typeface.MONOSPACE);
            tv.setTextSize(12f);
            tv.setTextColor(0xFFDFE3EA);
            tv.setPadding(28, 22, 28, 22);
            android.widget.ScrollView scroll = new android.widget.ScrollView(this);
            scroll.addView(tv, new FrameLayout.LayoutParams(-1, -2));

            android.app.AlertDialog dialog = new android.app.AlertDialog.Builder(this)
                    .setTitle("检测到上次崩溃")
                    .setView(scroll)
                    .setPositiveButton("复制日志", (d, w) -> {
                        try {
                            ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                            cm.setPrimaryClip(ClipData.newPlainText("Veyra崩溃日志", log));
                            android.widget.Toast.makeText(this, "已复制，请粘贴发给开发者", android.widget.Toast.LENGTH_LONG).show();
                        } catch (Exception ignored) { }
                    })
                    .setNegativeButton("关闭", null)
                    .setCancelable(false)
                    .create();
            // 无论复制还是关闭，dismiss 后清掉快照，避免每次启动重复弹
            dialog.setOnDismissListener(d -> {
                try { new java.io.File(getFilesDir(), "crash_last.log").delete(); } catch (Exception ignored) { }
            });
            dialog.show();
        } catch (Exception e) {
            android.util.Log.e(TAG, "崩溃弹窗失败", e);
        }
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        com.hongguotv.core.AppContext.init(this);
        installCrashLogger();
        ContentMode.get(this).startPublic();
        hotUpdates = HotUpdateManager.get(this);
        hotSession = hotUpdates.beginSession();
        repository = new DualContentRepository(this, ContentMode.get(this).active(), hotSession.site);
        store = new AppStore(this);
        android.content.SharedPreferences hotPrefs = getSharedPreferences("hot-updates", MODE_PRIVATE);
        String previousRules = hotPrefs.getString("siteFingerprint", "");
        if (!previousRules.isEmpty() && !previousRules.equals(hotSession.site.fingerprint)) store.clearCache();
        hotPrefs.edit().putString("siteFingerprint", hotSession.site.fingerprint).apply();
        migratingOrigin = !hotPrefs.getBoolean("originMigrated", false);
        account = new AccountService(this, store);
        try { store.activateUser(account.userId()); }
        catch (Exception error) { Log.w(TAG, "无法恢复账号数据", error); }
        updates = new UpdateManager(this);
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        root = new FrameLayout(this);
        webView = new WebView(this);
        webView.setBackgroundColor(Color.TRANSPARENT);
        root.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        UiRefreshRate.apply(this, webView);
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams attributes = getWindow().getAttributes();
            attributes.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(attributes);
        }
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets safe = insets.getInsets(WindowInsets.Type.systemBars());
                statusBarInsetDp = safe.top / getResources().getDisplayMetrics().density;
                root.setPadding(safe.left, 0, safe.right, safe.bottom);
            } else {
                statusBarInsetDp = insets.getSystemWindowInsetTop() / getResources().getDisplayMetrics().density;
                root.setPadding(insets.getSystemWindowInsetLeft(), 0,
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            publishWindowInsets();
            return insets;
        });
        applyTheme();
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setAllowFileAccess(migratingOrigin);
        webView.getSettings().setAllowFileAccessFromFileURLs(false);
        webView.getSettings().setAllowUniversalAccessFromFileURLs(false);
        webView.getSettings().setMediaPlaybackRequiresUserGesture(true);
        // 全局禁用长按文本选择（复制/分享/全选/搜索/朗读等系统菜单）与触摸触感。
        // 注意：输入框聚焦时通过 JS 的 input-edit 回调临时放行（仅选中文字时系统震动），
        // 非输入区域保持禁选禁震，避免误触系统菜单。
        webView.setLongClickable(false);
        webView.setHapticFeedbackEnabled(false);
        webView.setOnLongClickListener(v -> true);
        webView.setClickable(true);
        WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", path -> hotUpdates.resource(hotSession, path)).build();
        webView.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                if (HotUpdateManager.trusted(Uri.parse(url))) {
                    resourceReady = false;
                    hotHandler.removeCallbacks(resourceTimeout);
                    if (hotSession.trial) hotHandler.postDelayed(resourceTimeout, 15_000);
                }
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (migratingOrigin && "file:///android_asset/app.html".equals(url)) {
                    view.evaluateJavascript("localStorage.getItem('adult-confirmed')", value -> {
                        if (isDestroyed()) return;
                        try {
                            Object confirmed = new JSONTokener(value).nextValue();
                            getSharedPreferences("hot-updates", MODE_PRIVATE).edit().putBoolean("originMigrated", true)
                                    .putBoolean("adultConfirmed", "1".equals(confirmed)).apply();
                        } catch (Exception ignored) { }
                        migratingOrigin = false;
                        view.getSettings().setAllowFileAccess(false);
                        view.loadUrl(HotUpdateManager.UI_URL);
                    });
                    return;
                }
                publishWindowInsets();
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !HotUpdateManager.trusted(request.getUrl());
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame() && hotSession.trial) recoverResources();
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame() && hotSession.trial && response.getStatusCode() >= 400) recoverResources();
            }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                try { hotUpdates.rollback(hotSession); } catch (Exception error) { Log.w(TAG, "资源回退失败", error); }
                root.removeView(view); view.destroy(); webView = null;
                recreate();
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage message) {
                Log.d(TAG, message.message() + " @" + message.lineNumber());
                return true;
            }
            @Override public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                new android.app.AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton("清空", (dialog, which) -> result.confirm())
                        .setNegativeButton("取消", (dialog, which) -> result.cancel())
                        .setOnCancelListener(dialog -> result.cancel())
                        .show();
                return true;
            }
        });
        webView.addJavascriptInterface(new Bridge(), "AndroidHost");
        webView.loadUrl(migratingOrigin ? "file:///android_asset/app.html" : HotUpdateManager.UI_URL);
        checkHotUpdates();
        checkLastCrash();
    }

    private void checkHotUpdates() {
        requests.execute(() -> {
            try {
                JSONObject status = hotUpdates.check(false);
                runOnUiThread(() -> {
                    if (!isDestroyed() && webView != null) webView.evaluateJavascript(
                            "window.hgHotUpdateStatus && window.hgHotUpdateStatus(" + status + ")", null);
                });
            } catch (Exception error) { Log.d(TAG, "资源更新暂不可用，继续使用本地版本", error); }
        });
    }

    private void recoverResources() {
        if (resourceReady || hotSession == null || !hotSession.trial || isDestroyed()) return;
        hotHandler.removeCallbacks(resourceTimeout);
        try {
            hotUpdates.rollback(hotSession);
            hotSession = hotUpdates.beginSession();
            repository = new DualContentRepository(this, ContentMode.get(this).active(), hotSession.site);
            store.clearCache();
            getSharedPreferences("hot-updates", MODE_PRIVATE).edit()
                    .putString("siteFingerprint", hotSession.site.fingerprint).apply();
            webView.loadUrl(HotUpdateManager.UI_URL);
            Log.w(TAG, "资源包启动异常，已回退至可用版本");
        } catch (Exception error) { Log.e(TAG, "资源回退失败", error); }
    }

    private void applyPendingResources() {
        if (!hotUpdates.hasPending() || webView == null || isDestroyed()) return;
        webView.evaluateJavascript("window.hgCanApplyHotUpdate ? window.hgCanApplyHotUpdate() : false", safe -> {
            if ("true".equals(safe) && !isDestroyed()) recreate();
        });
    }

    private boolean dark() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    /** 输入框聚焦时临时放行长按（恢复复制/粘贴菜单与选中震动），失焦后恢复全局禁选禁震。 */
    private void setInputEditing(boolean active) {
        runOnUiThread(() -> {
            if (webView == null || isDestroyed()) return;
            if (active) {
                webView.setLongClickable(true);
                webView.setHapticFeedbackEnabled(true);
                webView.setOnLongClickListener(null);
            } else {
                webView.setLongClickable(false);
                webView.setHapticFeedbackEnabled(false);
                webView.setOnLongClickListener(v -> true);
            }
        });
    }

    private float screenCornerRadius(int position) {
        if (Build.VERSION.SDK_INT >= 31) {
            RoundedCorner corner = getDisplay() == null ? null : getDisplay().getRoundedCorner(position);
            if (corner != null && corner.getRadius() > 0)
                return corner.getRadius() / getResources().getDisplayMetrics().density;
        }
        return 22f;
    }

    private JSONObject screenCorners() throws Exception {
        return new JSONObject()
                .put("topLeft", screenCornerRadius(RoundedCorner.POSITION_TOP_LEFT))
                .put("topRight", screenCornerRadius(RoundedCorner.POSITION_TOP_RIGHT))
                .put("bottomRight", screenCornerRadius(RoundedCorner.POSITION_BOTTOM_RIGHT))
                .put("bottomLeft", screenCornerRadius(RoundedCorner.POSITION_BOTTOM_LEFT));
    }

    private void applyTheme() {
        boolean dark = dark();
        int background = Color.parseColor(dark ? "#171B1D" : "#F5F2E9");
        root.setBackgroundColor(background);
        applySystemBars();
        if (webView != null) webView.evaluateJavascript("window.hgTheme && window.hgTheme(" + dark + ")", null);
    }

    private void publishWindowInsets() {
        if (webView != null) webView.evaluateJavascript("window.hgWindowInsets && window.hgWindowInsets(" + statusBarInsetDp + ")", null);
    }

    private void applySystemBars() {
        boolean dark = dark();
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.parseColor(dark ? "#171B1D" : "#F5F2E9"));
        if (Build.VERSION.SDK_INT >= 29) getWindow().setStatusBarContrastEnforced(false);
        int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN;
        if (!dark) flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        if (!dark && !detailSystemBars) flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        getWindow().getDecorView().setSystemUiVisibility(flags);
    }

    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        applyTheme();
    }

    @Override protected void onResume() {
        super.onResume();
        applySystemBars();
        if (webView != null) UiRefreshRate.apply(this, webView);
        if (webView != null) webView.evaluateJavascript("window.hgResume && window.hgResume()", null);
        if (hotUpdates != null && !migratingOrigin) {
            applyPendingResources();
            checkHotUpdates();
        }
        if (account != null && account.isLoggedIn()) requests.execute(() -> {
            try {
                account.sync();
                runOnUiThread(() -> webView.evaluateJavascript("window.hgCloudSynced && window.hgCloudSynced()", null));
            } catch (Exception error) { Log.w(TAG, "云端同步稍后重试", error); }
        });
        if (pendingUpdateApk != null) {
            File apk = pendingUpdateApk;
            pendingUpdateApk = null;
            if (getPackageManager().canRequestPackageInstalls()) openUpdateInstaller(apk);
            else webView.evaluateJavascript("window.hgUpdateInstallPermissionDenied && window.hgUpdateInstallPermissionDenied()", null);
        }
    }

    @Override public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && webView != null) UiRefreshRate.apply(this, webView);
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == BINGE_REQUEST) {
            if (data != null && "detail".equals(data.getStringExtra("bingeAction"))) {
                String id = data.getStringExtra("id");
                int index = data.getIntExtra("index", 0);
                if (id != null && !id.isEmpty()) {
                    String script = "window.hgBingeAction && window.hgBingeAction('detail',"
                            + JSONObject.quote(id) + "," + index + ")";
                    runOnUiThread(() -> { if (webView != null) webView.evaluateJavascript(script, null); });
                }
            }
            return;
        }
        if (requestCode != AVATAR_PICKER || resultCode != RESULT_OK || data == null || data.getData() == null) return;
        Uri selected = data.getData();
        requests.execute(() -> {
            try {
                JSONObject profile = account.setAvatar(selected);
                runOnUiThread(() -> webView.evaluateJavascript("window.hgAvatarUpdated && window.hgAvatarUpdated(" + profile + ")", null));
            } catch (Exception error) {
                String script = "window.hgAvatarError && window.hgAvatarError(" + JSONObject.quote(error.getMessage() == null ? "头像保存失败" : error.getMessage()) + ")";
                runOnUiThread(() -> webView.evaluateJavascript(script, null));
            }
        });
    }

    private void installUpdate(File apk) {
        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            pendingUpdateApk = apk;
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getPackageName()));
            startActivity(settings);
            return;
        }
        openUpdateInstaller(apk);
    }

    private void openUpdateInstaller(File apk) {
        try {
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".updates", apk);
            Intent intent = new Intent(Intent.ACTION_INSTALL_PACKAGE);
            intent.setData(uri);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(intent);
        } catch (ActivityNotFoundException | IllegalArgumentException error) {
            Log.e(TAG, "无法打开系统安装程序", error);
            webView.evaluateJavascript("window.hgUpdateInstallError && window.hgUpdateInstallError()", null);
        }
    }

    private void updateBackRegistration(boolean enabled) {
        if (Build.VERSION.SDK_INT < 33 || enabled == backRegistered) return;
        if (enabled) {
            if (Build.VERSION.SDK_INT >= 34) {
                backCallback = new OnBackAnimationCallback() {
                    @Override public void onBackStarted(BackEvent event) {
                        resetBackProgress();
                        captureBackGeometry();
                        webView.evaluateJavascript("window.hgPredictiveBackStart && window.hgPredictiveBackStart(" +
                                (event.getSwipeEdge() == BackEvent.EDGE_RIGHT) + ")", null);
                    }

                    @Override public void onBackProgressed(BackEvent event) {
                        pendingBackProgress = backTouchFraction(event);
                        sendLatestBackProgress();
                    }

                    @Override public void onBackCancelled() {
                        resetBackProgress();
                        webView.evaluateJavascript("window.hgPredictiveBackCancel && window.hgPredictiveBackCancel()", null);
                    }

                    @Override public void onBackInvoked() {
                        resetBackProgress();
                        handleBack(true);
                    }
                };
            } else backCallback = () -> handleBack(false);
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCallback);
        } else {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
            backCallback = null;
        }
        backRegistered = enabled;
    }

    private void resetBackProgress() {
        backProgressGeneration++;
        pendingBackProgress = -1f;
        backProgressInFlight = false;
    }

    private void captureBackGeometry() {
        int[] location = new int[2];
        webView.getLocationOnScreen(location);
        backViewLeft = location[0];
        backViewWidth = webView.getWidth();
        backLeadPx = getResources().getDisplayMetrics().density * 18f;
    }

    private float backTouchFraction(BackEvent event) {
        float touchX = event.getTouchX();
        int edge = event.getSwipeEdge();
        if (Float.isNaN(touchX) || edge == BackEvent.EDGE_NONE || backViewWidth == 0)
            return event.getProgress();
        float width = backViewWidth;
        float distance = edge == BackEvent.EDGE_RIGHT
                ? backViewLeft + width - touchX : touchX - backViewLeft;
        distance = Math.max(0f, distance);
        float lead = Math.min(backLeadPx, distance * .35f);
        return Math.min(1f, (distance + lead) / width);
    }

    private void sendLatestBackProgress() {
        if (backProgressInFlight || pendingBackProgress < 0 || webView == null) return;
        float progress = pendingBackProgress;
        pendingBackProgress = -1f;
        backProgressInFlight = true;
        int generation = backProgressGeneration;
        webView.evaluateJavascript("window.hgPredictiveBackProgress && window.hgPredictiveBackProgress(" +
                progress + ")", ignored -> {
            if (generation != backProgressGeneration) return;
            backProgressInFlight = false;
            sendLatestBackProgress();
        });
    }

    private void handleBack(boolean predictive) {
        if (webView == null) { finish(); return; }
        String script = predictive
                ? "window.hgPredictiveBackCommit ? window.hgPredictiveBackCommit() : (window.hgBack ? window.hgBack() : false)"
                : "window.hgBack ? window.hgBack() : false";
        webView.evaluateJavascript(script, result -> {
            if (!"true".equals(result) && !moveTaskToBack(true)) finish();
        });
    }

    @Override public void onBackPressed() {
        handleBack(false);
    }

    @Override protected void onDestroy() {
        if (Build.VERSION.SDK_INT >= 33 && backRegistered) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
        }
        hotHandler.removeCallbacksAndMessages(null);
        requests.shutdownNow();
        localRequests.shutdownNow();
        coverRequests.shutdownNow();
        if (webView != null) {
            webView.removeJavascriptInterface("AndroidHost");
            webView.destroy();
        }
        super.onDestroy();
    }

    private synchronized void rebindContent() throws Exception {
        String source = ContentMode.get(this).active();
        repository = new DualContentRepository(this, source, hotSession.site);
        store = new AppStore(this, source);
        account = new AccountService(this, store);
        store.activateUser(account.userId());
    }

    private Object dispatch(String action, JSONObject args) throws Exception {
        ContentMode mode = ContentMode.get(this);
        if ("server-base".equals(action)) return ServerConfig.get(this);   // 当前后端地址（登录页预填用）
        if ("content-status".equals(action)) {
            // 解锁状态跟账号走：先强制拉服务端最新（角色/解锁标记），避免本地缓存陈旧导致误判
            account.refreshProfileNow();
            JSONObject status = mode.status();
            String role = account.role();
            boolean priv = "admin".equals(role) || "vip".equals(role);
            status.put("unlocked", account.isPrivateUnlocked() || priv); // 管理员/特权组免动态码，视为已解锁
            status.put("needsAgeConfirmation", (account.isPrivateUnlocked() || priv) && !mode.adultConfirmed());
            return status;
        }
        if ("enter-private".equals(action)) {
            // 管理员/特权组免动态码直接进入；普通用户未解锁需先验证后端动态码（验证一次永久有效，跟账号走）
            account.refreshProfileNow();
            String role = account.role();
            if (!account.isPrivateUnlocked() && !"admin".equals(role) && !"vip".equals(role)) {
                account.verifyOtp(args.optString("password"));
            }
            mode.markPrivateUnlocked();
            JSONObject result = mode.enterPrivateVerified();
            if (ContentMode.PRIVATE.equals(mode.active())) rebindContent();
            return result;
        }
        if ("verify-otp-public".equals(action)) {
            // 注册前置动态码校验（无需登录，复用 /api/otp/verify）
            account.verifyOtpPublic(args.optString("code"), args.optString("server"));
            return new JSONObject().put("ok", true);
        }
        if ("confirm-private-age".equals(action)) {
            JSONObject result = mode.finishPrivateEntry(); rebindContent(); return result;
        }
        if ("leave-private".equals(action)) { mode.startPublic(); rebindContent(); return mode.status(); }
        if ("get-proxy".equals(action)) return ProxySettings.address(this);
        if ("set-proxy".equals(action)) { ProxySettings.set(this, args.optString("value")); return true; }
        if ("get-proxy-mode".equals(action)) return ProxySettings.mode(this);
        if ("set-proxy-mode".equals(action)) {
          // 走后端转发仅管理员/特权组；普通用户强制仅直连并提示
          if (args.optInt("value", ProxySettings.MODE_BACKEND) == ProxySettings.MODE_BACKEND
              && !"admin".equals(account.role()) && !"vip".equals(account.role())) {
            throw new IllegalArgumentException("走后端转发仅管理员与特权组可用，请联系管理员");
          }
          ProxySettings.setMode(this, args.optInt("value", ProxySettings.MODE_BACKEND)); return true;
        }
        if ("test-proxy".equals(action)) return testProxy();
        // A request keeps its repository and storage together while another request switches modes.
        final DualContentRepository repository;
        final AppStore store;
        final AccountService account;
        synchronized (this) {
            if (args.has("source")) mode.require(args.getString("source"));
            repository = this.repository; store = this.store; account = this.account;
        }
        switch (action) {
            case "hot-update-status": return hotUpdates.status().put("enabled", !HotUpdateManager.INDEX.isEmpty());
            case "check-hot-update": return hotUpdates.check(true);
            case "apply-hot-update": runOnUiThread(this::applyPendingResources); return true;
            case "age-status": return ContentMode.PUBLIC.equals(mode.active()) || mode.adultConfirmed();
            case "confirm-age": mode.confirmAdult(); return true;
            case "hot-ready": {
                if (!migratingOrigin && args.optLong("revision", -1) == hotSession.revision
                        && hotSession.bootId.equals(args.optString("bootId"))) {
                    hotUpdates.markHealthy(hotSession);
                    runOnUiThread(() -> { resourceReady = true; hotHandler.removeCallbacks(resourceTimeout); });
                }
                return true;
            }
            case "theme": return dark();
            case "screen-corners": return screenCorners();
            case "window-insets": return statusBarInsetDp;
            case "account": return account.profile();
            case "refresh-account": return account.refreshProfileNow(); // 强制拉服务端最新角色/解锁状态（NAS 下载鉴权用）
            case "register": return account.register(args.optString("username"), args.optString("password"), args.optString("server"), args.optString("code"));
            case "login": return account.login(args.optString("username"), args.optString("password"), args.optString("server"));
            case "change-password": return account.changePassword(args.optString("oldPassword"), args.optString("newPassword"));
            case "logout": account.logout(); return account.profile();
            case "sync": return account.sync();
            case "download-start": return DownloadManager.get(this).start(args.optString("source"), args.optString("title"), args.optJSONArray("episodes"), args.optBoolean("debug", false), args.optString("cover"));
            case "download-list": return DownloadManager.get(this).list();
            case "download-files": return DownloadManager.get(this).localFiles(args.optString("id"));
            case "open-local-player": {
                JSONObject files = DownloadManager.get(this).localFiles(args.optString("id"));
                JSONArray list = files.optJSONArray("episodes");
                String mergedFile = files.optString("merged", "");
                String pick = !mergedFile.isEmpty() ? mergedFile
                        : (list != null && list.length() > 0 ? list.optJSONObject(0).optString("path") : "");
                if (pick.isEmpty()) throw new IllegalStateException("本剧还没有可播放的成品文件，可先合并");
                Intent intent = new Intent(this, LocalPlayerActivity.class);
                intent.putExtra("title", files.optString("title", ""));
                intent.putExtra("merged", !mergedFile.isEmpty());
                intent.putExtra("episodes", (list == null ? "[]" : list.toString()));
                intent.putExtra("path", pick);
                runOnUiThread(() -> startActivity(intent));
                return true;
            }
            case "download-cancel": DownloadManager.get(this).cancel(args.optString("id")); return new JSONObject().put("ok", true);
            case "download-delete": DownloadManager.get(this).delete(args.optString("id")); return new JSONObject().put("ok", true);
            case "download-retry": DownloadManager.get(this).retry(args.optString("id")); return new JSONObject().put("ok", true);
            case "download-merge": return DownloadManager.get(this).merge(args.optString("id"));
            case "download-forward-prepare": return DownloadManager.get(this).forwardPrepare(args.optString("title"), args.optInt("count"), args.optString("nasTaskId"));
            case "download-forward-pull": {
                String nasId = args.optString("nasTaskId");
                int index = args.optInt("index");
                byte[] bytes = account.getBytes("api/download/files/" + nasId + "/" + index);
                return DownloadManager.get(this).forwardPull(args.optString("id"), index, bytes);
            }
            case "download-forward-pull-merged": {
                String nasId = args.optString("nasTaskId");
                byte[] bytes = account.getBytes("api/download/files/" + nasId + "/0");
                return DownloadManager.get(this).forwardPullMerged(args.optString("id"), bytes);
            }
            case "input-edit": setInputEditing(args.optBoolean("active")); return new JSONObject().put("ok", true);
            case "open-url": {
                String url = args.optString("url");
                if (url != null && (url.startsWith("http://") || url.startsWith("https://"))) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    } catch (Exception error) {
                        return new JSONObject().put("ok", false).put("error", error.getMessage());
                    }
                }
                return new JSONObject().put("ok", true);
            }
            case "crash-log": return new JSONObject().put("log", crashLog());
            case "nas-download-start": {
                JSONObject body = new JSONObject()
                        .put("source", args.optString("source")).put("title", args.optString("title"))
                        .put("seriesId", args.optString("seriesId")).put("episodes", args.optJSONArray("episodes"))
                        // 封面带给后端落库：下载列表 NAS 行直接出图（此前 NAS 行永远灰块）
                        .put("cover", args.optString("cover"));
                // 红果源：手机端直接解析官方 vid 推给 NAS（NAS 端 video_detail/searchSeries 常被风控导致
                // "未注入 App vid" 而走网页源 403）；NAS 拿到 vids 后直接用 vid 签名取流
                if ("hongguo".equals(args.optString("source"))) {
                    try {
                        JSONObject det = new HongguoAppApi().fetch(args.optString("seriesId"));
                        JSONArray vs = det == null ? null : det.optJSONArray("vids");
                        if (vs != null && vs.length() > 0) {
                            body.put("vids", vs);
                            Log.i(TAG, "NAS 下载注入 vids " + vs.length() + " 个");
                        }
                    } catch (Exception e) {
                        Log.w(TAG, "NAS 下载 vids 预解析失败，由后端自行解析", e);
                    }
                }
                return account.postJson("api/download/tasks", body);
            }
            case "nas-download-list": return account.getJson("api/download/tasks");
            case "open-nas-player": {
                // NAS 任务点封面直接播 NAS 上的成品：合并产物（files/{id}/0）优先，
                // 未合并则逐集播（files/{id}/1..N）。服务器 sendFile 支持 Range，拖动进度没问题。
                if (!account.isLoggedIn()) throw new IllegalStateException("请先登录");
                String nasId = args.optString("id");
                JSONObject task = account.getJson("api/download/tasks/" + nasId).optJSONObject("task");
                if (task == null) throw new IllegalStateException("NAS 任务不存在或已被清理");
                if (!"done".equals(task.optString("status")) && !"ready".equals(task.optString("status")))
                    throw new IllegalStateException("NAS 任务尚未完成（" + task.optString("status") + "）");
                int count = task.optInt("episodeCount", 0);
                String title = task.optString("title", "NAS 下载");
                JSONArray eps = new JSONArray();
                for (int i = 1; i <= count; i++) {
                    eps.put(new JSONObject().put("index", i)
                            .put("url", account.baseUrl() + "/api/download/files/" + nasId + "/" + i));
                }
                String mergedUrl = account.baseUrl() + "/api/download/files/" + nasId + "/0";
                String token = account.authToken();
                Intent intent = new Intent(this, LocalPlayerActivity.class);
                intent.putExtra("title", title);
                intent.putExtra("merged", true);          // 先探测合并产物：404 则回退逐集
                intent.putExtra("nasMode", true);
                intent.putExtra("auth", token);
                intent.putExtra("episodes", eps.toString());
                intent.putExtra("path", mergedUrl);
                runOnUiThread(() -> startActivity(intent));
                return true;
            }
            case "nas-download-episodes": return account.getJson("api/download/tasks/" + args.optString("id") + "/episodes");
            case "nas-download-cancel": account.deleteJson("api/download/tasks/" + args.optString("id")); return new JSONObject().put("ok", true);
            case "nas-download-merge": return account.postJson("api/download/merge", new JSONObject().put("id", args.optString("id")));
            case "nas-download-retry-failed": return account.postJson("api/download/retry-failed", new JSONObject().put("id", args.optString("id")));
            case "choose-avatar": {
                if (!account.isLoggedIn()) throw new IllegalStateException("请先登录");
                runOnUiThread(() -> {
                    Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    picker.addCategory(Intent.CATEGORY_OPENABLE);
                    picker.setType("image/*");
                    startActivityForResult(picker, AVATAR_PICKER);
                });
                return true;
            }
            case "app-version": return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            case "cached-update": return updates.cached();
            case "check-update": return updates.check(args.optBoolean("manual"));
            case "download-update": {
                File apk = updates.download(percent -> runOnUiThread(() ->
                        webView.evaluateJavascript("window.hgUpdateProgress && window.hgUpdateProgress(" + percent + ")", null)));
                runOnUiThread(() -> installUpdate(apk));
                return true;
            }
            case "cached": return store.cached(args.optString("key"));
            case "home": {
                JSONObject result = repository.home();
                store.saveCache("home", result);
                return result;
            }
            case "category": {
                String id = args.optString("id");
                int page = args.optInt("page", 1);
                JSONObject result = repository.category(id, page);
                store.saveCache("category:" + id + ":" + page, result);
                return result;
            }
            case "tags": {
                JSONObject result = repository.tags();
                store.saveCache("tags", result);
                return result;
            }
            case "tag-list": {
                String slug = args.optString("slug");
                int page = args.optInt("page", 1);
                JSONObject result = repository.tagListing(slug, page);
                store.saveCache("tag:" + slug + ":" + page, result);
                return result;
            }
            case "recommend":
            case "newest": {
                int page = args.optInt("page", 1);
                JSONObject result = repository.recommend(page, "newest".equals(action));
                store.saveCache(action + ":" + page, result);
                return result;
            }
            case "search": {
                String term = args.optString("query").trim();
                JSONObject result = repository.search(term, args.optBoolean("suggest"));
                store.saveCache("search:" + term, result);
                return result;
            }
            case "detail": {
                String id = args.optString("id");
                JSONObject result = repository.detail(id);
                // 记录详情实际内容源：下载/播放判定必须与详情一致，避免全局模式与详情脱节导致
                // 黄果剧被误判红果源而走了手机直连（防盗链失败）。
                result.put("source", ContentMode.get(this).active());
                store.saveCache("detail:" + id, result);
                return result;
            }
            case "episode": return repository.episode(args.optString("id"), args.optInt("episode", 1));
            case "cover": return repository.coverData(args.optString("url"));
            case "library": return store.library();
            case "bookmark": {
                boolean saved = store.toggleBookmark(args);
                if (account.isLoggedIn()) requests.execute(() -> {
                    try { account.sync(); } catch (Exception error) { Log.w(TAG, "收藏稍后同步", error); }
                });
                return saved;
            }
            case "bookmark-state": return store.hasBookmark(args.optString("id"));
            case "get-progress": return store.getProgress(args.optString("id"), args.optInt("episode", 1));
            case "clear-history": store.clearHistory(); if (account.isLoggedIn()) requests.execute(() -> { try { account.sync(); } catch (Exception ignored) { } }); return true;
            case "clear-bookmarks": store.clearBookmarks(); if (account.isLoggedIn()) requests.execute(() -> { try { account.sync(); } catch (Exception ignored) { } }); return true;
            case "clear-content-cache": store.clearCache(); repository.clearCovers(); return true;
            case "copy-text": {
                String text = args.optString("text", "");
                if (!text.isEmpty()) {
                    runOnUiThread(() -> {
                        ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                        if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("Veyra", text));
                    });
                }
                return !text.isEmpty();
            }
            case "quit": runOnUiThread(this::finish); return true;
            case "open-player": {
                args.put("source", mode.active());
                Intent intent = new Intent(this, PlayerActivity.class);
                intent.putExtra("payload", args.toString());
                runOnUiThread(() -> startActivity(intent));
                return true;
            }
            case "open-binge": {
                // 刷剧模式：全屏 feed 播随机推荐剧第一集；BingeActivity 通过
                // setResult 把「查看详情」带回来，由 onActivityResult 转 JS 路由
                args.put("source", mode.active());
                Intent intent = new Intent(this, BingeActivity.class);
                intent.putExtra("payload", args.toString());
                runOnUiThread(() -> startActivityForResult(intent, BINGE_REQUEST));
                return true;
            }
            default: throw new IllegalArgumentException("未知请求");
        }
    }

    private final class Bridge {
        @JavascriptInterface public void setDetailMode(boolean enabled) {
            runOnUiThread(() -> {
                if (detailSystemBars == enabled) return;
                detailSystemBars = enabled;
                applySystemBars();
            });
        }
        @JavascriptInterface public void setBackEnabled(boolean enabled) {
            runOnUiThread(() -> updateBackRegistration(enabled));
        }

        @JavascriptInterface public void request(String requestId, String action, String argsText) {
            ExecutorService executor = "cached".equals(action) ? localRequests
                    : "cover".equals(action) ? coverRequests : requests;
            executor.execute(() -> {
                try {
                    JSONObject args = new JSONObject(argsText);
                    Object result = dispatch(action, args);
                    String data;
                    if (result == null) data = "null";
                    else if (result instanceof JSONObject) data = result.toString();
                    else if (result instanceof JSONArray) data = result.toString();
                    else if (result instanceof Boolean || result instanceof Number) data = result.toString();
                    else data = JSONObject.quote(String.valueOf(result));
                    String script = "window.NativeCallbacks.resolve(" + JSONObject.quote(requestId) + "," + data + ")";
                    String authUserId = ("login".equals(action) || "register".equals(action)) && result instanceof JSONObject
                            ? ((JSONObject) result).optString("userId") : "";
                    final AccountService profileService = "account".equals(action) ? account : null;
                    String profileUserId = profileService != null && result instanceof JSONObject ? ((JSONObject) result).optString("userId") : "";
                    runOnUiThread(() -> {
                        if (isDestroyed() || webView == null) return;
                        webView.evaluateJavascript(script, null);
                        if (!authUserId.isEmpty()) refreshAccountAfterAuth(authUserId);
                        if (!profileUserId.isEmpty()) refreshAccountSilently(profileService, profileUserId);
                    });
                } catch (Exception error) {
                    Log.e(TAG, action + " failed", error);
                    String script = "window.NativeCallbacks.reject(" + JSONObject.quote(requestId) + "," + JSONObject.quote(error.getMessage() == null ? "请求失败" : error.getMessage()) + ")";
                    runOnUiThread(() -> { if (!isDestroyed() && webView != null) webView.evaluateJavascript(script, null); });
                }
            });
        }
    }

    private void refreshAccountAfterAuth(String userId) {
        requests.execute(() -> {
            try {
                account.sync();
                runOnUiThread(() -> webView.evaluateJavascript("window.hgCloudSynced && window.hgCloudSynced()", null));
            } catch (Exception error) { Log.w(TAG, "登录后片单稍后同步", error); }
            try {
                JSONObject refreshed = account.refreshProfile();
                if (!userId.equals(refreshed.optString("userId"))) return;
                String script = "window.hgAccountRefreshed && window.hgAccountRefreshed(" + refreshed + ")";
                runOnUiThread(() -> webView.evaluateJavascript(script, null));
            } catch (Exception error) { Log.w(TAG, "登录后账号资料稍后刷新", error); }
        });
    }

    private void refreshAccountSilently(AccountService service, String userId) {
        requests.execute(() -> {
            try {
                JSONObject refreshed = service.refreshProfile();
                if (!service.isLoggedIn() || !userId.equals(service.userId()) || !userId.equals(refreshed.optString("userId"))) return;
                runOnUiThread(() -> {
                    if (!isDestroyed() && webView != null) webView.evaluateJavascript(
                            "window.hgAccountRefreshed && window.hgAccountRefreshed(" + refreshed + ")", null);
                });
            } catch (Exception error) { Log.w(TAG, "账号后台刷新稍后重试", error); }
        });
    }

    /** 检测配置的代理是否可用：经代理请求当前黄果主源首页，返回连通延时毫秒。 */
    private JSONObject testProxy() throws Exception {
        String address = ProxySettings.address(this);
        if (address.isEmpty()) throw new IOException("未配置代理地址");
        String[] parts = address.split(":");
        String host = parts.length > 0 && !parts[0].isEmpty() ? parts[0] : "127.0.0.1";
        int port = 80;
        if (parts.length > 1) try { port = Integer.parseInt(parts[1]); } catch (NumberFormatException ignored) { }
        String origin = HotUpdateManager.get(this).currentSite().origin();
        long start = System.currentTimeMillis();
        HttpURLConnection connection = (HttpURLConnection) new URL(origin)
                .openConnection(new Proxy(Proxy.Type.HTTP, new InetSocketAddress(host, port)));
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(5000);
        connection.setUseCaches(false);
        connection.setInstanceFollowRedirects(true);
        try {
            int status = connection.getResponseCode();
            long ms = System.currentTimeMillis() - start;
            if (status < 200 || status >= 300) throw new IOException("代理已连通，但目标站点返回 " + status);
            return new JSONObject().put("ok", true).put("ms", ms);
        } catch (IOException error) {
            throw new IOException("代理连接失败", error);
        } finally {
            connection.disconnect();
        }
    }
}
