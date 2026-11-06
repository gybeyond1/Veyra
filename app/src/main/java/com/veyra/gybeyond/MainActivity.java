package com.veyra.gybeyond;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.ActivityNotFoundException;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.net.Uri;
import android.provider.Settings;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.KeyEvent;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
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
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.ProgressBar;
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
    private final ExecutorService requests = Executors.newFixedThreadPool(4);
    private final ExecutorService localRequests = Executors.newSingleThreadExecutor();
    private final ExecutorService coverRequests = Executors.newFixedThreadPool(2);
    private WebView webView;
    private FrameLayout root;
    private View splash;
    private FrameLayout bingeVideoLayer;
    // 玻璃底板层：夹在原生视频层与 WebView 之间，负责把视频糊掉后透出给 WebView 里的玻璃板
    private BingeEngine bingeEngine;
    private final BingeEngine.Callback bingeCallback = new BingeEngine.Callback() {
        @Override public Activity getActivity() { return MainActivity.this; }
        @Override public void onShowLoaded(String title, String description, String cover, String id, int index) {
            runOnUiThread(() -> {
                if (isDestroyed() || webView == null) return;
                try {
                    String json = new JSONObject().put("title", title)
                            .put("description", description).put("cover", cover)
                            .put("id", id).put("index", index).toString();
                    webView.evaluateJavascript("window.hgBingeUpdate && window.hgBingeUpdate(" + json + ")", null);
                } catch (Exception ignored) { }
            });
        }
        @Override public void onShowFailed(String message) {
            runOnUiThread(() -> {
                if (isDestroyed() || webView == null) return;
                webView.evaluateJavascript("window.hgBingeFailed && window.hgBingeFailed("
                        + JSONObject.quote(message) + ")", null);
            });
        }
        // 冷启动记忆恢复：真海报上屏 → 让 WebView 撤掉它自己垫的那张占位海报
        @Override public void onPosterReady() {
            runOnUiThread(() -> {
                if (isDestroyed() || webView == null) return;
                webView.evaluateJavascript("window.hgBingePosterReady && window.hgBingePosterReady()", null);
            });
        }
    };
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
    private volatile float bottomInsetDp;
    private volatile float leftInsetDp;
    private boolean detailSystemBars;
    // Web 管理台「下载到手机」：设备心跳 + 指令领取（前台每 40 秒一次）
    private DeviceLink deviceLink;
    private final Handler deviceHandler = new Handler(Looper.getMainLooper());
    private boolean deviceLoopRunning;
    private volatile boolean deviceRegistered;
    /** 远程服务器配置是否已从账号里恢复过（每次登录/冷启动各一次） */
    private volatile boolean remotesRestored;
    // 大屏适配：phone/tablet/tv 由 DeviceProfile 判定，页面据此加载对应布局与遥控焦点。
    // tvCapture 为 true 时方向键/确认键由页面接管（遥控导航），输入框聚焦时页面会临时关掉。
    private String deviceType = DeviceProfile.PHONE;
    private volatile boolean tvCapture = true;
    private LanTextRelay textRelay;
    /** 电视端退出确认弹窗（只在返回键落到首页时出现）。 */
    private android.app.Dialog exitDialog;
    /** 扫码登录：电视这边二维码里的一次性码（4 分钟内复用，避免重渲染就换码）。 */
    private volatile String activeLoginCode = "";
    private volatile long activeLoginCodeAt;
    private static final int REQUEST_QR_LOGIN = 0x51;

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
        deviceType = DeviceProfile.type(this);
        // TV 独立包：装在什么设备上都按电视跑（横屏、焦点导航、扫码输入、tv.html），
        // 否则拿手机装 TV 包调试时会被判成 phone，遥控器逻辑和局域网服务全都不会起来。
        if (getResources().getBoolean(R.bool.veyra_lite)) deviceType = DeviceProfile.TV;
        // 手机 / 平板一律不再请求方向（manifest 里也不写 screenOrientation）。
        //
        // 这不是为了能转，恰恰相反 —— 是让横着用的平板别再被塞进一条竖框里。
        // Android 12L 起，声明了固定方向的应用在大屏上会被降级成「兼容窗口」：
        // 界面被压成一列竖条居中、两侧留黑边，看起来就像没适配。BingeEngine 进刷剧时
        // 还会再调一次 PORTRAIT、退出时调 UNSPECIFIED，于是同一台机器会在「铺满」和
        // 「一列」之间来回跳 —— 用户看到的就是切一次刷剧换一次版式。
        // 现在把加锁的地方全部拆掉，窗口尺寸只由屏幕决定。
        // 电视仍然锁横屏：盒子的输出就是横的，锁住能避免个别固件把画面转过来。
        if (DeviceProfile.TV.equals(deviceType)) {
            try { setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE); } catch (Exception ignored) { }
        }
        ContentMode.get(this).startPublic();
        hotUpdates = HotUpdateManager.get(this);
        hotSession = hotUpdates.beginSession();
        repository = new DualContentRepository(this, ContentMode.get(this).active(), hotSession.site);
        store = new AppStore(this);
        android.content.SharedPreferences hotPrefs = getSharedPreferences("hot-updates", MODE_PRIVATE);
        String previousRules = hotPrefs.getString("siteFingerprint", "");
        if (!previousRules.isEmpty() && !previousRules.equals(hotSession.site.fingerprint)) store.clearCache();
        hotPrefs.edit().putString("siteFingerprint", hotSession.site.fingerprint).apply();
        // 电视包不参与「老 file:// 存储迁移」：那是给 app.html 换源用的，
        // 而电视首启如果先加载 app.html，就会拿手机布局糊在电视上（甚至白屏卡住）。
        migratingOrigin = !getResources().getBoolean(R.bool.veyra_lite)
                && !hotPrefs.getBoolean("originMigrated", false);
        account = new AccountService(this, store);
        try { store.activateUser(account.userId()); }
        catch (Exception error) { Log.w(TAG, "无法恢复账号数据", error); }
        updates = new UpdateManager(this);
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        root = new FrameLayout(this);
        // 刷剧原生视频层：垫在 webView 之下（先 add，叠在底层）。平时 GONE，进刷剧时由 BingeEngine 显示。
        bingeVideoLayer = new FrameLayout(this);
        bingeVideoLayer.setVisibility(View.GONE);
        root.addView(bingeVideoLayer, new FrameLayout.LayoutParams(-1, -1));
        webView = new WebView(this);
        webView.setBackgroundColor(Color.TRANSPARENT);
        root.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        buildSplash();
        setContentView(root);
        /* 电视端必须自己接管返回。manifest 里开了 enableOnBackInvokedCallback，
           targetSdk 36 下系统不再调用 onBackPressed；而 tv.js 从头到尾没调过
           setBackEnabled，回调也就一直没注册。结果 BACK 落到系统默认行为，
           直接把 Activity finish 掉——表现就是"除了播放页，哪里按返回都退桌面"。
           页面加载前就注册上，别等 JS。 */
        if (liteBuild()) updateBackRegistration(true);
        hotHandler.postDelayed(this::hideSplash, 9000);
        startTextRelay();
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
                float density = getResources().getDisplayMetrics().density;
                statusBarInsetDp = safe.top / density;
                // 底部不再由 Window 留白：WebView 铺到屏幕最底，手势条/导航栏区域由
                // 前端底栏自己让开（#dock 的 bottom 加 --safe-bottom）。
                // 这样做页面背景能一直延伸到手势条下面，手势条是浮在底栏同色背景上，
                // 而不是浮在一条跟页面不一致的空白带上——微信、酷安都是这个做法。
                bottomInsetDp = safe.bottom / density;
                leftInsetDp = safe.left / density;
                root.setPadding(safe.left, 0, safe.right, 0);
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
            @Override public void onPageCommitVisible(WebView view, String url) {
                /* 页面首帧已经画出来了：撤掉启动页，别让用户对着 logo 等数据 */
                hideSplash();
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
                        view.loadUrl(uiUrl());
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
        webView.loadUrl(migratingOrigin ? "file:///android_asset/app.html" : uiUrl());
        checkHotUpdates();
        checkLastCrash();
    }

    /** 电视构建走独立页面 tv.html（不再给 app.html 加 ?lite=1）；手机 / 平板仍是 app.html。 */
    private String uiUrl() {
        // 不走热更新资源通道：热更新包里没有 tv.html 时会 404 白屏，电视端不值得赌这一下。
        if (liteBuild()) return "file:///android_asset/tv.html";
        return HotUpdateManager.UI_URL;
    }

    /**
     * 是否走轻量页面。
     *
     * 第一判据是 flavor 打进来的 R.bool.veyra_lite；再按设备形态兜一次底。
     * 电视上跑手机那套 UI 一定会白屏（老 WebView 不认可选链），所以宁可多判一次，
     * 也不能因为 flavor 打错、或者用户把手机包装到电视上，就让整台电视打不开。
     */
    private boolean liteBuild() {
        if (getResources().getBoolean(R.bool.veyra_lite)) return true;
        return DeviceProfile.TV.equals(DeviceProfile.type(this));
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
            webView.loadUrl(uiUrl());
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
        if (webView == null) return;
        // 顶部沿用单参数的老接口，底部/左侧另开一个函数：万一热更新回滚到旧资源，
        // 旧脚本不认识 hgSafeInsets，&& 短路即可，不会把状态栏高度读成 NaN。
        webView.evaluateJavascript("window.hgWindowInsets && window.hgWindowInsets(" + statusBarInsetDp + ");"
                + "window.hgSafeInsets && window.hgSafeInsets(" + bottomInsetDp + "," + leftInsetDp + ")", null);
    }

    private void applySystemBars() {
        boolean dark = dark();
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= 30) {
            // 铺到屏幕最底后导航栏必须透明，否则手势条下面会压一条系统色带；
            // 同时关掉对比度遮罩，避免浅色页面上出现一层发灰的横向渐变。
            getWindow().setNavigationBarColor(Color.TRANSPARENT);
        } else {
            // 30 以下没有铺底，导航栏维持不透明，避免三键导航出现白底白键
            getWindow().setNavigationBarColor(Color.parseColor(dark ? "#171B1D" : "#F5F2E9"));
        }
        if (Build.VERSION.SDK_INT >= 29) {
            getWindow().setStatusBarContrastEnforced(false);
            getWindow().setNavigationBarContrastEnforced(false);
        }
        if (Build.VERSION.SDK_INT >= 30) {
            // 30+ 用 Appearance 控制图标/手势条明暗，比 setSystemUiVisibility 可靠
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                int mask = WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS;
                int appearance = 0;
                if (!dark) appearance |= WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                if (!dark && !detailSystemBars) appearance |= WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS;
                controller.setSystemBarsAppearance(appearance, mask);
            }
            return;
        }
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
        if (!remotesRestored) restoreAccountRemotes();
        startDeviceLoop();
        if (pendingUpdateApk != null) {
            File apk = pendingUpdateApk;
            pendingUpdateApk = null;
            if (getPackageManager().canRequestPackageInstalls()) openUpdateInstaller(apk);
            else webView.evaluateJavascript("window.hgUpdateInstallPermissionDenied && window.hgUpdateInstallPermissionDenied()", null);
        }
        if (bingeEngine != null) bingeEngine.onResume();
    }

    @Override protected void onPause() {
        super.onPause();
        stopDeviceLoop();
        if (bingeEngine != null) bingeEngine.onPause();
    }

    // ---- Web 管理台「下载到手机」：设备上报 + 指令轮询 ----
    /** 前台才轮询：后台不拉起网络，避免耗电；回到前台立即补一次。 */
    private void startDeviceLoop() {
        if (deviceLoopRunning || account == null || !account.isLoggedIn()) return;
        deviceLoopRunning = true;
        deviceHandler.post(deviceTick);
    }

    private void stopDeviceLoop() {
        deviceLoopRunning = false;
        deviceHandler.removeCallbacks(deviceTick);
    }

    private final Runnable deviceTick = new Runnable() {
        @Override public void run() {
            if (!deviceLoopRunning) return;
            pollDeviceCommands();
            // 投屏要求「按下去几秒内电视就有反应」，40 秒一轮回显然不行；
            // 电视常年插电、只在前台轮询，5 秒一次可以接受。手机维持 40 秒（只领下载指令）。
            if (deviceLoopRunning) deviceHandler.postDelayed(this, DeviceProfile.isTv(MainActivity.this) ? 5_000 : 40_000);
        }
    };

    private void pollDeviceCommands() {
        if (account == null || !account.isLoggedIn()) return;
        if (deviceLink == null) deviceLink = new DeviceLink(this, account);
        final DeviceLink link = deviceLink;
        requests.execute(() -> {
            try {
                if (!deviceRegistered) {
                    link.register();
                    deviceRegistered = true;
                }
                JSONArray commands = link.poll();
                for (int i = 0; i < commands.length(); i++) {
                    JSONObject command = commands.optJSONObject(i);
                    if (command == null) continue;
                    String id = command.optString("id");
                    String type = command.optString("type", "download");
                    if ("cast".equals(type)) {
                        handleCastCommand(id, command.optJSONObject("payload"), link);
                        continue;
                    }
                    try {
                        JSONObject task = startPushedDownload(command.optJSONObject("payload"));
                        link.ack(id, true, "");
                        toast("网页推送的下载已加入：" + task.optString("title", "")
                                + (ContentMode.PRIVATE.equals(ContentMode.get(this).active())
                                ? "（切回公开模式可在「我的-下载」看到）" : ""));
                    } catch (Exception error) {
                        String message = error.getMessage() == null ? "下载失败" : error.getMessage();
                        link.ack(id, false, message);
                        toast("网页推送的下载失败：" + message);
                    }
                }
            } catch (Exception error) {
                // 设备未注册（后端数据被清）时下轮重新上报
                deviceRegistered = false;
                Log.d(TAG, "设备心跳稍后重试", error);
            }
        });
    }

    /**
     * 手机「投到电视」：只把剧 id / 集数 / 进度交给页面，
     * 详情、播放地址、预取、连播全部复用电视端已有的播放链路（open-player 同一套 payload）。
     */
    private void handleCastCommand(String commandId, JSONObject payload, DeviceLink link) {
        if (payload == null) { link.ack(commandId, false, "投屏内容为空"); return; }
        if (!DeviceProfile.isTv(this)) { link.ack(commandId, false, "这台设备不是电视"); return; }
        String seriesId = payload.optString("seriesId").trim();
        int episode = payload.optInt("episode", 0);
        if (seriesId.isEmpty() || episode < 1) { link.ack(commandId, false, "投屏内容不完整"); return; }
        String script = "window.hgTvCast && window.hgTvCast(" + payload.toString() + ")";
        runOnUiThread(() -> {
            if (isDestroyed() || webView == null) return;
            webView.evaluateJavascript(script, null);
        });
        link.ack(commandId, true, "");
        toast("手机投屏：" + payload.optString("title", "当前剧集") + " 第 " + episode + " 集");
    }

    /** 按指令里的剧集号在本机取流，再交给本地 DownloadManager（合并逻辑与手动下载一致）。 */
    private JSONObject startPushedDownload(JSONObject payload) throws Exception {
        if (payload == null) throw new IllegalArgumentException("指令内容为空");
        if ("huangguo".equals(payload.optString("source"))) throw new IllegalArgumentException("私密内容暂不支持网页推送");
        String seriesId = payload.optString("seriesId").trim();
        String title = payload.optString("title").trim();
        JSONArray numbers = payload.optJSONArray("episodes");
        if (seriesId.isEmpty() || numbers == null || numbers.length() == 0)
            throw new IllegalArgumentException("指令缺少剧集信息");
        HongguoRepository repository = new HongguoRepository();
        JSONArray episodes = new JSONArray();
        for (int i = 0; i < numbers.length(); i++) {
            int number = numbers.optInt(i, 0);
            if (number < 1 || number > 999) continue;
            JSONObject episode = repository.episode(seriesId, number);
            String url = episode.optString("source");
            if (url == null || !url.startsWith("http")) throw new IllegalStateException("第 " + number + " 集取流失败");
            episodes.put(new JSONObject().put("index", number).put("url", url).put("key", episode.optString("key")));
        }
        if (episodes.length() == 0) throw new IllegalArgumentException("没有可下载的分集");
        // 电脑 / WebUI 选了「下载到某个远程存储」时会把整条配置一起带过来：
        // 落到本机 RemoteStore（同 id 覆盖）再交给下载器，下载合并后自动上传。
        String remoteId = "";
        JSONObject remote = payload.optJSONObject("remote");
        if (remote != null && !remote.optString("host", "").isEmpty()) {
            try {
                remoteId = RemoteStore.save(this, remote).optString("id", "");
            } catch (Exception error) {
                throw new IllegalStateException("远程存储配置无效：" + error.getMessage());
            }
        }
        return DownloadManager.get(this).start("hongguo", title.isEmpty() ? seriesId : title,
                episodes, false, payload.optString("cover"), remoteId);
    }

    private void toast(String message) {
        runOnUiThread(() -> {
            if (isDestroyed()) return;
            android.widget.Toast.makeText(this, message, android.widget.Toast.LENGTH_LONG).show();
        });
    }

    @Override public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && webView != null) UiRefreshRate.apply(this, webView);
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_QR_LOGIN) {
            if (webView == null) return;
            String message = data == null ? null : data.getStringExtra("message");
            webView.evaluateJavascript("window.hgQrScan && window.hgQrScan(" + (resultCode == RESULT_OK) + ","
                    + JSONObject.quote(message == null ? "" : message) + ")", null);
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

    // 必须在主线程建：BingeEngine 构造里会 inflate PlayerView / ImageView 并 addView 到已 attach 的
    // bingeVideoLayer，而 "binge-start" 是在 requests 线程池里 dispatch 的，子线程动视图会抛
    // CalledFromWrongThreadException（Only the original thread that created a view hierarchy can touch its views），
    // 结果引擎没建起来 → 进刷剧页黑屏、什么都不播。
    private void ensureBingeEngine() {
        if (bingeEngine != null) return;
        if (Looper.myLooper() != Looper.getMainLooper()) { runOnUiThread(this::ensureBingeEngine); return; }
        bingeEngine = new BingeEngine(bingeCallback, bingeVideoLayer);
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
        /* 退出确认框开着的时候，返回键应该是"取消"，不是再弹一次 */
        if (exitDialog != null && exitDialog.isShowing()) { exitDialog.dismiss(); return; }
        if (webView == null) { finish(); return; }
        String script = predictive
                ? "window.hgPredictiveBackCommit ? window.hgPredictiveBackCommit() : (window.hgBack ? window.hgBack() : false)"
                : "window.hgBack ? window.hgBack() : false";
        webView.evaluateJavascript(script, result -> {
            if ("true".equals(result)) return;
            // 电视端返回不该直接掉到桌面：先弹确认，确认后连进程一起收掉，
            // 否则盒子会留一个后台进程占内存，再打开还得重新加载一遍。
            if (DeviceProfile.TV.equals(deviceType)) { showExitConfirm(); return; }
            if (!moveTaskToBack(true)) finish();
        });
    }

    /** 电视端退出确认：遥控器方向键 + 确定键就能选，不需要触摸。 */
    private void showExitConfirm() {
        if (exitDialog != null && exitDialog.isShowing()) return;
        exitDialog = VeyraDialog.confirm(this, "退出 Veyra", "确定要退出应用吗？",
                "退出", "取消", this::exitApplication);
        exitDialog.setOnDismissListener(dialog -> exitDialog = null);
        exitDialog.show();
    }

    private void exitApplication() {
        try { finishAndRemoveTask(); } catch (Exception ignored) { finish(); }
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            android.os.Process.killProcess(android.os.Process.myPid());
            System.exit(0);
        }, 150);
    }

    /**
     * 局域网中继服务：
     *  - 电视开机就起（遥控器打字不现实，搜索/换背景都靠手机扫码）；
     *  - 手机/平板只在「扫码登录」时按需起（用完就留着，端口只监听局域网，且所有
     *    请求都要校验一次性码 + token）。
     */
    private void startTextRelay() {
        if (!DeviceProfile.TV.equals(deviceType)) return;
        ensureTextRelay();
    }

    private synchronized void ensureTextRelay() {
        if (textRelay != null) return;
        try {
            textRelay = new LanTextRelay(
                    text -> runOnUiThread(() -> {
                        if (isDestroyed() || webView == null) return;
                        webView.evaluateJavascript("window.veyraRelayFill && window.veyraRelayFill("
                                + JSONObject.quote(text) + ")", null);
                    }),
                    // 扫码登录：另一台设备把会话推过来，这边落盘后通知页面。
                    (server, tokenValue, user) -> runOnUiThread(() -> adoptScannedSession(server, tokenValue, user)));
            // 扫码换背景：手机把原图整张传上来，这里解码压缩成 data URL 再交给页面
            textRelay.setBackgroundSink(new java.io.File(getCacheDir(), "tv-bg-upload"), this::adoptBackgroundImage);
            textRelay.start();
        } catch (Exception error) {
            Log.w(TAG, "扫码输入服务启动失败", error);
            textRelay = null;
        }
    }

    /**
     * 手机扫码上传的自定义背景：原图可能几十兆，解码压缩一律放后台线程，
     * 处理完只把压缩后的 data URL 交给页面；原图立刻删掉，不在缓存里留。
     */
    private void adoptBackgroundImage(java.io.File source) {
        if (source == null) return;
        requests.execute(() -> {
            String dataUrl = "";
            try {
                dataUrl = TvBackground.save(this, source);
            } catch (Exception error) {
                Log.w(TAG, "自定义背景处理失败", error);
            } finally {
                try { if (!source.delete()) source.deleteOnExit(); } catch (Exception ignored) { }
            }
            final String result = dataUrl;
            runOnUiThread(() -> {
                if (isDestroyed() || webView == null) return;
                webView.evaluateJavascript("window.veyraTvBgUpdated && window.veyraTvBgUpdated("
                        + org.json.JSONObject.quote(result) + ")", null);
            });
        });
    }

    /** 把手机扫码授权过来的账号写进本机，并通知页面刷新登录态。 */
    private void adoptScannedSession(String server, String tokenValue, org.json.JSONObject user) {
        if (account == null) return;
        requests.execute(() -> {
            boolean ok;
            try {
                account.adoptSession(tokenValue, server, user);
                ok = true;
            } catch (Exception error) {
                Log.w(TAG, "扫码登录失败", error);
                ok = false;
            }
            boolean result = ok;
            runOnUiThread(() -> {
                if (isDestroyed() || webView == null) return;
                webView.evaluateJavascript("window.hgTvLogin && window.hgTvLogin(" + result + ")", null);
            });
            if (result) {
                deviceRegistered = false;
                remotesRestored = false;
                restoreAccountRemotes();
            }
        });
    }

    /**
     * 电视遥控：方向键与确认键转给页面做焦点导航（页面的 veyraTvKey 负责移动高亮、滚动、触发点击）。
     * 只拦这几颗键，音量、菜单、返回等仍按系统默认走；手机/平板完全不进这个分支。
     */
    /**
     * 启动页：只有电视端才铺一层，手机端直接进页面（性能足够，不需要等人看动画）。
     * 电视端深色底 + 大号 "Veyra TV" + 细转圈，页面首帧可见后淡出。
     */
    private void buildSplash() {
        if (!DeviceProfile.isTv(this)) return;
        float density = getResources().getDisplayMetrics().density;
        FrameLayout layer = new FrameLayout(this);
        layer.setBackgroundColor(0xFF17181A);
        layer.setClickable(true);

        LinearLayout stack = new LinearLayout(this);
        stack.setOrientation(LinearLayout.VERTICAL);
        stack.setGravity(Gravity.CENTER_HORIZONTAL);
        layer.addView(stack, new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER));

        /* 名字直接当主视觉：去掉那个跟产品没关系的 V，字号拉到电视上够看的尺寸 */
        TextView name = new TextView(this);
        name.setText("Veyra TV");
        name.setTextSize(52);
        name.setTextColor(0xFFF2F3F5);
        name.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        name.setLetterSpacing(0.14f);
        name.setGravity(Gravity.CENTER);
        name.setIncludeFontPadding(false);
        stack.addView(name, new LinearLayout.LayoutParams(-2, -2));

        ProgressBar wait = new ProgressBar(this, null, android.R.attr.progressBarStyleSmall);
        wait.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(0xFFC89B3C));
        LinearLayout.LayoutParams waitParams = new LinearLayout.LayoutParams(
                Math.round(26 * density), Math.round(26 * density));
        waitParams.topMargin = Math.round(34 * density);
        waitParams.gravity = Gravity.CENTER_HORIZONTAL;
        stack.addView(wait, waitParams);

        /* 入场：名字放大淡入，转圈随后浮现 */
        name.setAlpha(0f);
        name.setScaleX(.92f);
        name.setScaleY(.92f);
        wait.setAlpha(0f);
        name.animate().alpha(1f).scaleX(1f).scaleY(1f)
                .setDuration(420).setInterpolator(new android.view.animation.DecelerateInterpolator()).start();
        wait.animate().alpha(1f).setDuration(300).setStartDelay(260).start();

        splash = layer;
        root.addView(layer, new FrameLayout.LayoutParams(-1, -1));
    }

    private void hideSplash() {
        final View layer = splash;
        if (layer == null) return;
        splash = null;
        layer.animate().alpha(0f).setDuration(220).withEndAction(() -> {
            try { root.removeView(layer); } catch (Exception ignored) { }
        }).start();
    }

    /** Shift 单按当返回：按下时先记一笔，期间按了别的键就作废，抬起时才触发。 */
    private boolean shiftArmed = false;

    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        /* 返回类按键必须在 tvCapture 之前处理：页面里输入框一聚焦就会
           setTvCapture(false) 暂停按键接管，ESC 于是漏到系统手里，表现就是直接退桌面。 */
        if (liteBuild() && webView != null) {
            int rawCode = event.getKeyCode();
            int rawAction = event.getAction();
            if (rawCode == KeyEvent.KEYCODE_SHIFT_LEFT || rawCode == KeyEvent.KEYCODE_SHIFT_RIGHT) {
                if (rawAction == KeyEvent.ACTION_DOWN) {
                    shiftArmed = true;
                } else if (rawAction == KeyEvent.ACTION_UP) {
                    boolean fire = shiftArmed;
                    shiftArmed = false;
                    if (fire) handleBack(false);
                }
                return false;   /* 放行，Shift + 字母 的组合输入不受影响 */
            }
            if (rawAction == KeyEvent.ACTION_DOWN) shiftArmed = false;
            /* 遥控器返回键也在这里兜一层。部分盒子的 BACK 不走 OnBackInvokedDispatcher，
               直接以 KeyEvent 下来，漏给 super 就是 finish。消费掉，交给页面判断。 */
            if (rawCode == KeyEvent.KEYCODE_BACK) {
                if (rawAction == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) handleBack(false);
                return true;
            }
            if (rawCode == KeyEvent.KEYCODE_ESCAPE) {
                if (rawAction == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) handleBack(false);
                return true;
            }
        }
        if (!DeviceProfile.TV.equals(deviceType) || !tvCapture || webView == null) {
            return super.dispatchKeyEvent(event);
        }
        int code = event.getKeyCode();
        boolean navigational = code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN
                || code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT
                || code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER
                || code == KeyEvent.KEYCODE_NUMPAD_ENTER;
        if (!navigational) return super.dispatchKeyEvent(event);
        if (event.getAction() != KeyEvent.ACTION_DOWN) return true;
        boolean center = code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER
                || code == KeyEvent.KEYCODE_NUMPAD_ENTER;
        /* 方向键长按要连续走：系统每 ~50ms 发一次 repeat，全部转给页面。
           确定键不连发，否则按住会连着点开好几层。 */
        if (center && event.getRepeatCount() > 0) return true;
        webView.evaluateJavascript("window.veyraTvKey && window.veyraTvKey(" + code + ")", null);
        return true;
    }

    @Override public void onBackPressed() {
        handleBack(false);
    }

    @Override protected void onDestroy() {
        if (Build.VERSION.SDK_INT >= 33 && backRegistered) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
        }
        hotHandler.removeCallbacksAndMessages(null);
        if (textRelay != null) { textRelay.stop(); textRelay = null; }
        requests.shutdownNow();
        localRequests.shutdownNow();
        coverRequests.shutdownNow();
        if (webView != null) {
            webView.removeJavascriptInterface("AndroidHost");
            webView.destroy();
        }
        if (bingeEngine != null) bingeEngine.onDestroy();
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
        // 自定义背景：页面启动时取一次 data URL；清空只删本地文件
        if ("tv-bg-load".equals(action)) return TvBackground.dataUrl(this);
        if ("tv-bg-clear".equals(action)) { TvBackground.clear(this); return true; }
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
            // 电视端每次进入都必须输动态码（forceOtp），家里共用的屏幕不能靠手机的解锁标记；
            // 手机端保持原样：管理员/特权组免码，普通用户验证一次永久有效（跟账号走）
            account.refreshProfileNow();
            String role = account.role();
            if (args.optBoolean("forceOtp", false)) {
                account.verifyOtp(args.optString("password"));
            } else if (!account.isPrivateUnlocked() && !"admin".equals(role) && !"vip".equals(role)) {
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
        // 后端支持的私密源清单（剧果/野果/帝果……），设置页据此渲染可选项
        if ("private-sites".equals(action)) return account.getJson("api/sources");
        // 私密源切换：黄果保持原三通道；剧果/野果/帝果等接口型源统一走后端网关
        if ("private-site".equals(action)) {
            if (args.has("id")) {
                PrivateSite.set(this, args.optString("id"), args.optString("name"));
                rebindContent();   // 立即换源，不用重启
                // 缓存是给上一个源存的（首页/分类/详情），不清会先闪一遍别的源的内容
                store.clearCache();
            }
            return new JSONObject().put("id", PrivateSite.get(this)).put("name", PrivateSite.name(this));
        }
        if ("test-proxy".equals(action)) return testProxy();
        // ---- 远程服务器（SMB / WebDAV / FTP）：配置 + 传输 ----
        // 这三个协议的客户端都在手机侧直连局域网，不经后端：后端可能跑在公网 VPS 上，
        // 看不到用户家里的 NAS；而且文件本来就在手机上。
        if ("remote-list".equals(action)) return RemoteStore.list(this);
        if ("remote-save".equals(action)) {
            JSONObject saved = RemoteStore.save(this, args.optJSONObject("server"));
            // 下一次心跳重新上报：同账号的电脑 / WebUI 立刻能看到这条存储
            deviceRegistered = false;
            return saved;
        }
        if ("remote-delete".equals(action)) {
            RemoteStore.remove(this, args.optString("id"));
            deviceRegistered = false;
            return new JSONObject().put("ok", true);
        }
        if ("remote-test".equals(action)) {
            JSONObject server;
            try {
                server = RemoteStore.withSecret(this, args.optJSONObject("server"));
            } catch (Exception error) {
                throw new IllegalArgumentException(error.getMessage() == null ? "配置不完整" : error.getMessage());
            }
            long started = System.currentTimeMillis();
            RemoteClient client = null;
            try {
                client = RemoteClient.create(server);
                client.open();
                client.verify();
            } catch (Exception error) {
                throw new IllegalStateException(RemoteClient.describeError(error));
            } finally {
                if (client != null) { try { client.close(); } catch (Exception ignored) { } }
            }
            return new JSONObject().put("ok", true)
                    .put("ms", System.currentTimeMillis() - started)
                    .put("address", RemoteStore.describe(server));
        }
        if ("remote-transfer-start".equals(action)) {
            return RemoteTransfer.get(this).enqueue(args.optString("taskId"), args.optString("remoteId"));
        }
        if ("remote-transfer-list".equals(action)) return RemoteTransfer.get(this).list();
        if ("remote-transfer-cancel".equals(action)) {
            RemoteTransfer.get(this).cancel(args.optString("id"));
            return new JSONObject().put("ok", true);
        }
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
            case "window-safe-insets": return new float[]{bottomInsetDp, leftInsetDp};
            case "account": return account.profile();
            // 下载目标：在线设备（电脑/其他手机/电视）与远程存储，全部从后端账号维度拉
            case "download-targets": {
                JSONObject out = new JSONObject();
                JSONObject devices = account.api("GET", "api/devices", null);
                out.put("devices", devices.optJSONArray("devices") == null ? new JSONArray() : devices.optJSONArray("devices"));
                JSONObject storages = account.api("GET", "api/storages", null);
                out.put("storages", storages.optJSONArray("storages") == null ? new JSONArray() : storages.optJSONArray("storages"));
                return out;
            }
            // 设备管理：改名不需要动态码；移除设备等于让它退出登录，要 6 位动态码
            case "device-rename": {
                JSONObject body = new JSONObject();
                body.put("id", args.optString("id"));
                body.put("name", args.optString("name"));
                return account.api("POST", "api/devices/rename", body);
            }
            case "device-revoke": {
                JSONObject body = new JSONObject();
                body.put("code", args.optString("code"));
                account.api("DELETE", "api/devices/" + args.optString("id"), body);
                return new JSONObject().put("ok", true);
            }
            // 把这一集推给指定在线设备去下（后端下发 download 指令）
            case "download-dispatch": {
                JSONObject body = new JSONObject();
                body.put("source", args.optString("source"));
                body.put("title", args.optString("title"));
                body.put("seriesId", args.optString("seriesId"));
                body.put("cover", args.optString("cover"));
                body.put("episodes", args.optJSONArray("episodes") == null ? new JSONArray() : args.optJSONArray("episodes"));
                JSONObject target = new JSONObject();
                target.put("kind", args.optString("kind", "device"));
                if (args.has("deviceId")) target.put("deviceId", args.optString("deviceId"));
                if (args.has("storageId")) target.put("storageId", args.optString("storageId"));
                body.put("target", target);
                return account.api("POST", "api/download/dispatch", body);
            }
            case "refresh-account": return account.refreshProfileNow(); // 强制拉服务端最新角色/解锁状态（NAS 下载鉴权用）
            case "register": return account.register(args.optString("username"), args.optString("password"), args.optString("server"), args.optString("code"));
            case "login": return account.login(args.optString("username"), args.optString("password"), args.optString("server"));
            case "change-password": return account.changePassword(args.optString("oldPassword"), args.optString("newPassword"));
            case "logout": account.logout(); return account.profile();
            case "sync": return account.sync();
            case "download-start": return DownloadManager.get(this).start(args.optString("source"), args.optString("title"), args.optJSONArray("episodes"), args.optBoolean("debug", false), args.optString("cover"), args.optString("remoteId"));
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
            case "download-delete": DownloadManager.get(this).delete(args.optString("id")); RemoteTransfer.get(this).forgetTask(args.optString("id")); return new JSONObject().put("ok", true);
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
            case "device-download-list":
            case "desktop-download-list": {
                // 同一账号下在线设备的下载记录：电脑、电视、其它手机都列出来。
                // 每台设备上报了自己的局域网媒体服务地址，有地址且已合并就能直接连过去播。
                if (!account.isLoggedIn()) throw new IllegalStateException("请先登录");
                JSONArray devices = account.getJson("api/devices").optJSONArray("devices");
                String selfId = DeviceLink.deviceId(this);
                JSONArray out = new JSONArray();
                for (int i = 0; devices != null && i < devices.length(); i++) {
                    JSONObject device = devices.optJSONObject(i);
                    if (device == null) continue;
                    String deviceId = device.optString("id", "");
                    if (deviceId.isEmpty() || deviceId.equals(selfId)) continue;  // 本机的任务手机自己有一份
                    if (!device.optBoolean("online")) continue;
                    String platform = device.optString("platform", "android");
                    String kind = "desktop".equals(platform) ? "desktop" : "tv".equals(platform) ? "tv" : "android";
                    JSONObject lan = device.optJSONObject("lan");
                    String base = lan == null ? "" : lan.optString("url", "");
                    String lanToken = lan == null ? "" : lan.optString("token", "");
                    JSONArray tasks = device.optJSONArray("tasks");
                    for (int j = 0; tasks != null && j < tasks.length(); j++) {
                        JSONObject task = tasks.optJSONObject(j);
                        if (task == null) continue;
                        String taskId = task.optString("id", "");
                        if (taskId.isEmpty()) continue;
                        boolean merged = task.optBoolean("merged", false);
                        boolean playable = merged && !base.isEmpty();
                        String label = "desktop".equals(kind) ? "电脑" : "tv".equals(kind) ? "电视" : "手机";
                        out.put(new JSONObject()
                                .put("id", (("desktop".equals(kind)) ? "pc:" : "dev:") + deviceId + ":" + taskId)
                                .put("taskId", taskId)
                                .put("deviceId", deviceId)
                                .put("deviceName", device.optString("name", label))
                                .put("platform", platform)
                                .put("title", task.optString("title", "未命名"))
                                .put("cover", task.optString("cover", ""))
                                .put("status", task.optString("status", ""))
                                .put("percent", task.optDouble("percent", 0))
                                .put("doneCount", task.optInt("doneCount", 0))
                                .put("totalCount", task.optInt("totalCount", 0))
                                .put("episodeCount", task.optInt("episodeCount", 0))
                                .put("merged", merged)
                                .put("url", playable ? endpoint(base, "/file/" + taskId + "/0?t=" + lanToken) : "")
                                .put("kind", kind));
                    }
                }
                return new JSONObject().put("tasks", out);
            }
            case "open-desktop-player": {
                // 电脑在线时直接播它本机的成品：局域网直连，不走后端中转。
                String url = args.optString("url", "");
                if (url.isEmpty()) throw new IllegalStateException("电脑文件地址无效");
                Intent intent = new Intent(this, LocalPlayerActivity.class);
                intent.putExtra("title", args.optString("title", "电脑下载"));
                intent.putExtra("merged", true);
                intent.putExtra("nasMode", true);
                intent.putExtra("auth", "");
                JSONArray eps = new JSONArray();
                eps.put(new JSONObject().put("index", 1).put("url", url));
                intent.putExtra("episodes", eps.toString());
                intent.putExtra("path", url);
                runOnUiThread(() -> startActivity(intent));
                return true;
            }
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
                // 地址必须走 endpoint()：baseUrl 末尾自带 "/"，手写 "/api" 会拼出 "//api"，后端 404。
                JSONArray eps = new JSONArray();
                for (int i = 1; i <= count; i++) {
                    eps.put(new JSONObject().put("index", i)
                            .put("url", endpoint(account.baseUrl(), "/api/download/files/" + nasId + "/" + i)));
                }
                String mergedUrl = endpoint(account.baseUrl(), "/api/download/files/" + nasId + "/0");
                String firstEpUrl = count > 0 ? endpoint(account.baseUrl(), "/api/download/files/" + nasId + "/1") : mergedUrl;
                // status=done 才是「已合并」，这时才有 files/{id}/0；ready 只是下载完，直接播第 1 集，
                // 省掉一次注定 404 的请求（以前固定先探合并产物，未合并时白闪一下再回退）。
                boolean hasMerged = "done".equals(task.optString("status"));
                String token = account.authToken();
                Intent intent = new Intent(this, LocalPlayerActivity.class);
                intent.putExtra("title", title);
                intent.putExtra("merged", hasMerged);     // 合并产物缺失时播放器还会回退逐集，这里只是少走弯路
                intent.putExtra("nasMode", true);
                intent.putExtra("auth", token);
                intent.putExtra("episodes", eps.toString());
                intent.putExtra("path", hasMerged ? mergedUrl : firstEpUrl);
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
            // 详情页「继续播放」：取这部剧最近一次看到哪集、哪一秒
            case "latest-progress": return store.latestProgress(args.optString("id"));
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
            case "binge-start": {
                // 刷剧模式：做成首页 WebView 的一种形态；原生视频层（BingeEngine）垫在透明 WebView 后。
                args.put("source", mode.active());
                final JSONArray items = args.optJSONArray("items");
                final int startIndex = args.optInt("index", 0);
                final String source = args.optString("source");
                // 建引擎 + 启动必须都在主线程（这里是 requests 线程池，不能碰视图）
                runOnUiThread(() -> {
                    ensureBingeEngine();
                    if (bingeEngine != null) bingeEngine.start(items, startIndex, source);
                });
                return true;
            }
            case "binge-exit": {
                runOnUiThread(() -> { if (bingeEngine != null) bingeEngine.exit(); });
                return true;
            }
            case "binge-pause": {
                // 刷剧形态挂起：切 tab / 进详情 / 看全集时只暂停，播放器和当前剧原样保留
                runOnUiThread(() -> { if (bingeEngine != null) bingeEngine.pause(); });
                return true;
            }
            case "binge-resume": {
                // 回到首页直接接着播，不重新 loadShow（不会先走一遍传统首页）
                runOnUiThread(() -> { if (bingeEngine != null) bingeEngine.resume(); });
                return true;
            }
            case "binge-next": {
                runOnUiThread(() -> { if (bingeEngine != null) bingeEngine.next(); });
                return true;
            }
            case "binge-prev": {
                runOnUiThread(() -> { if (bingeEngine != null) bingeEngine.prev(); });
                return true;
            }
            case "binge-detail": {
                // 退出刷剧（释放播放器、隐藏视频层）并回 WebView 进详情页；index 保留以便返回恢复
                final int index = args.optInt("index", 0);
                final String id = args.optString("id");
                runOnUiThread(() -> {
                    if (bingeEngine != null) bingeEngine.pause();
                    if (webView != null && !id.isEmpty()) {
                        webView.evaluateJavascript("window.hgBingeAction && window.hgBingeAction('detail',"
                                + JSONObject.quote(id) + "," + index + ")", null);
                    }
                });
                return true;
            }
            case "binge-full": {
                // 观看全集：进 PlayerActivity 按已存进度续播；不退出刷剧（返回后继续）
                final int episode = args.optInt("episode", 1);
                runOnUiThread(() -> { if (bingeEngine != null) bingeEngine.openInPlayer(Math.max(1, episode)); });
                return true;
            }
            default: throw new IllegalArgumentException("未知请求");
        }
    }

    /**
     * 拼后端绝对地址。
     *
     * 坑：ServerConfig 存下来的 baseUrl 一定带结尾斜杠（normalize 里 withSlash 补的），
     * 再手写 "/api/..." 就变成 "https://host//api/..."。Express 的 strict routing 下
     * "//api/..." 不匹配 "/api/..."，直接 404 —— 表现就是播放器一句 "Source error"，
     * 没有任何有用信息。这里统一去掉尾部斜杠再拼，顺便兼容部署在子路径的地址。
     */
    private static String endpoint(String base, String path) {
        String b = base == null ? "" : base.trim();
        while (b.endsWith("/")) b = b.substring(0, b.length() - 1);
        String p = path == null ? "" : path.trim();
        if (!p.startsWith("/")) p = "/" + p;
        return b + p;
    }

    /**
     * 电视的设备名，写进登录二维码给手机看。
     * 手机端弹确认框时要让人一眼认出「是不是客厅那台」，光有 IP 认不出来。
     */
    private static String tvLabel() {
        String brand = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.trim();
        String model = Build.MODEL == null ? "" : Build.MODEL.trim();
        if (model.isEmpty()) return brand.isEmpty() ? "Veyra TV" : brand;
        if (brand.isEmpty() || model.toLowerCase().startsWith(brand.toLowerCase())) return model;
        return brand + " " + model;
    }

    private final class Bridge {
        // 跟手拖拽的合帧状态：触摸事件只更新这些值，真正碰视图的只有 applyDrag 一次
        private volatile boolean pendingDragStart;
        private volatile boolean pendingDragEnd;
        private volatile float pendingDragOffset;
        private volatile float pendingDragVelocity;
        private volatile boolean dragFlushQueued;

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

        /** 设备形态：phone / tablet / tv。同步返回，页面首帧就能拿到，不用等异步桥。 */
        @JavascriptInterface public String deviceProfile() {
            JSONObject profile = new JSONObject();
            try {
                profile.put("type", deviceType);
                profile.put("tv", DeviceProfile.TV.equals(deviceType));
                profile.put("tablet", DeviceProfile.TABLET.equals(deviceType));
                profile.put("model", Build.MODEL == null ? "" : Build.MODEL);
            } catch (Exception ignored) { }
            return profile.toString();
        }

        /** 扫码输入的局域网地址；服务还没绑上端口时 url 为空，前端会重试。 */
        @JavascriptInterface public String relayInfo() {
            LanTextRelay relay = textRelay;
            JSONObject info = new JSONObject();
            try {
                info.put("url", relay == null ? "" : relay.url());
                info.put("address", relay == null ? "" : relay.address());
                info.put("port", relay == null ? 0 : relay.port());
                // 自定义背景的扫码地址：同一个局域网服务，换一条路径
                info.put("bgUrl", relay == null ? "" : relay.backgroundUrl());
            } catch (Exception ignored) { }
            return info.toString();
        }

        /**
         * 电视端登录二维码：返回局域网地址 + 一次性码（5 分钟）。
         * 手机扫这个码之后，把会话 POST 回 http://host:port/login?t=...
         * 4 分钟内重复调用复用同一个码，避免页面重渲染就让二维码跳变。
         */
        @JavascriptInterface public String tvLoginInfo() {
            JSONObject info = new JSONObject();
            try {
                info.put("ready", false);
                LanTextRelay relay = textRelay;
                if (relay == null || relay.port() == 0 || relay.address().isEmpty()) {
                    info.put("reason", "relay-offline");
                    return info.toString();
                }
                long now = System.currentTimeMillis();
                if (activeLoginCode.isEmpty() || now - activeLoginCodeAt > 4 * 60_000L || !relay.loginCodeUsable()) {
                    activeLoginCode = String.format("%06d", (int) (Math.random() * 1000000));
                    activeLoginCodeAt = now;
                    relay.issueLoginCode(activeLoginCode, 5 * 60_000L);
                }
                info.put("ready", true)
                        .put("url", "veyra://tv-login?h=" + relay.address() + "&p=" + relay.port()
                                + "&t=" + relay.token() + "&c=" + activeLoginCode
                                + "&n=" + Uri.encode(tvLabel()))
                        .put("code", activeLoginCode)
                        .put("host", relay.address())
                        .put("port", relay.port())
                        .put("name", tvLabel())
                        .put("expiresIn", Math.max(0, 300 - (now - activeLoginCodeAt) / 1000));
            } catch (Exception ignored) { }
            return info.toString();
        }

        /**
         * 手机 / 平板登录页的「扫码登录」：按需起局域网服务并返回二维码信息。
         * 协议与电视端完全一致（veyra://tv-login?...），所以任何一台已登录的设备
         * （手机、平板、电脑）都能扫这个码，把账号授权给这台设备。
         */
        @JavascriptInterface public String startLoginHost() {
            ensureTextRelay();
            return tvLoginInfo();
        }

        /** 手机端：打开扫码页，扫另一台设备（电视 / 电脑 / 手机 / 平板）上的登录二维码，把本机账号授权过去。 */
        @JavascriptInterface public void startQrScan() {
            runOnUiThread(() -> {
                if (isDestroyed() || webView == null) return;
                if (account == null || !account.isLoggedIn()) {
                    webView.evaluateJavascript("window.hgQrScan && window.hgQrScan(false,"
                            + JSONObject.quote("请先登录手机端账号") + ")", null);
                    return;
                }
                try {
                    Intent intent = new Intent();
                    intent.setClassName(MainActivity.this, "com.veyra.gybeyond.QrScanActivity");
                    intent.putExtra("session", account.session().toString());
                    startActivityForResult(intent, REQUEST_QR_LOGIN);
                } catch (Exception error) {
                    String message = error.getMessage() == null ? "打不开扫码页" : error.getMessage();
                    webView.evaluateJavascript("window.hgQrScan && window.hgQrScan(false,"
                            + JSONObject.quote(message) + ")", null);
                }
            });
        }

        /** 页面接管/交还方向键：输入框聚焦时交还给系统，避免吃掉软键盘里的方向键。 */
        @JavascriptInterface public void setTvTheme(String key) {
            TvTheme.save(MainActivity.this, key);
        }

        @JavascriptInterface public void setTvCapture(boolean enabled) {
            tvCapture = enabled;
        }

        /** 跟手拖拽：phase = start/move/end，dy 为手指纵向位移（CSS px，向上为负）。 */
        @JavascriptInterface public void bingeDrag(String phase, double dy, double velocity) {
            if (bingeEngine == null) return;
            // 触摸事件比 UI 帧密，原来每来一个 move 就 runOnUiThread 一次，主线程上一帧还没画完
            // 消息已经堆了十几条 —— 手感就是「拖不动 / 落后半拍」。这里只记最新值，一帧只处理一次。
            if ("start".equals(phase)) { pendingDragStart = true; pendingDragEnd = false; }
            else if ("end".equals(phase)) pendingDragEnd = true;
            pendingDragOffset = (float) dy;
            pendingDragVelocity = (float) velocity;
            if (!dragFlushQueued) {
                dragFlushQueued = true;
                webView.post(applyDrag);
            }
        }

        private final Runnable applyDrag = new Runnable() {
            @Override public void run() {
                dragFlushQueued = false;
                BingeEngine engine = bingeEngine;
                if (engine == null) return;
                boolean start = pendingDragStart;
                boolean end = pendingDragEnd;
                pendingDragStart = false;
                pendingDragEnd = false;
                float offset = pendingDragOffset;
                float velocity = pendingDragVelocity;
                if (start) {
                    engine.dragStart();
                    if (end) engine.dragEnd(offset, velocity);
                    else if (offset != 0f) engine.dragMove(offset);
                    return;
                }
                if (end) engine.dragEnd(offset, velocity);
                else engine.dragMove(offset);
            }
        };

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

    /**
     * 远程服务器配置跟账号走：登录后/每次冷启动把账号下那份（含口令）合并回本机，
     * 重装、换机、清数据之后不用重新填。本地已经有的条目按 id 更新，不会重复堆积。
     */
    private void restoreAccountRemotes() {
        if (account == null || !account.isLoggedIn()) return;
        requests.execute(() -> {
            try {
                boolean changed = RemoteStore.restoreFromAccount(this, account.restoreRemotes());
                remotesRestored = true;
                if (changed) runOnUiThread(() -> {
                    if (isDestroyed() || webView == null) return;
                    webView.evaluateJavascript("window.hgRemotesRestored && window.hgRemotesRestored()", null);
                });
            } catch (Exception error) {
                Log.w(TAG, "远程服务器配置稍后恢复", error);
            }
        });
    }

    private void refreshAccountAfterAuth(String userId) {
        // 登录/注册成功后立刻上报设备，Web 管理台才能看到这台手机
        deviceRegistered = false;
        remotesRestored = false;
        runOnUiThread(this::startDeviceLoop);
        restoreAccountRemotes();
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
