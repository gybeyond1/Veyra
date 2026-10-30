package com.veyra.gybeyond;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.GradientDrawable;
import android.graphics.PorterDuff;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.VideoSize;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 刷剧模式（公开模式首页悬浮按钮进入）：
 * 从推荐/榜单随机拉剧，全屏自动播第 1 集；上下滑换剧（红果首页式）。
 * 竖屏视频铺满全屏（ZOOM 裁切），横屏视频按比例完整显示（FIT）。
 * 视频未起播前显示该剧海报；底部一张跟随内容高度的液态玻璃卡片承载标题/简介和
 * 「查看详情 / 观看全集」两个按钮。进度实时写入 AppStore，
 * 「观看全集」进 PlayerActivity 时按已存进度续播；
 * 第 1 集播完未滑动 → 自动进播放页播第 2 集并一直连播。
 * 刷剧页与首页共用同一个底栏与同一个切换悬浮按钮（同位置、同玻璃材质）。
 */
public class BingeActivity extends Activity {

    private DualContentRepository repository;
    private AppStore store;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService prefetcher = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(Looper.getMainLooper());

    private JSONArray pool;
    private int index;
    private String currentCover;

    private FrameLayout root;
    private FrameLayout pageA;
    private FrameLayout pageB;
    private FrameLayout page;          // 当前页
    private FrameLayout incoming;      // 过渡页
    private FrameLayout playerLayer;   // 视频层（随当前页重新挂载）
    private PlayerView playerView;
    private TextView message;

    private ExoPlayer player;
    private String currentId;
    private int currentEpisode = 1;
    private int episodeCount;
    private JSONObject detail;
    private String currentSource;
    private String currentMime = MimeTypes.APPLICATION_M3U8;
    private long lastSaved;
    private int loadToken;
    private boolean destroyed;
    private boolean animating;
    private float downY;
    private boolean swiping;
    private final Map<String, Bitmap> posterCache = new HashMap<>();
    // 预缓存：详情与第 1 集播放地址提前解析好，滑到即播（不再等转圈）
    private final Map<String, JSONObject> detailCache = new java.util.concurrent.ConcurrentHashMap<>();
    private final Map<String, JSONObject> readyCache = new java.util.concurrent.ConcurrentHashMap<>();
    private final java.util.Set<String> prefetching = new java.util.HashSet<>();

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= 29) getWindow().setNavigationBarContrastEnforced(false);
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        try {
            repository = new DualContentRepository(this);
            store = new AppStore(this);
            JSONObject payload = new JSONObject(getIntent().getStringExtra("payload"));
            ContentMode.get(this).require(payload.optString("source", ContentMode.get(this).active()));
            pool = payload.optJSONArray("items");
            if (pool == null || pool.length() == 0) throw new IllegalArgumentException("没有可刷的内容");
            index = Math.max(0, payload.optInt("index", 0));
            buildUi();
            loadShow();
        } catch (Throwable error) {
            try { Toast.makeText(this, "进入刷剧模式失败: " + error.getMessage(), Toast.LENGTH_LONG).show(); }
            catch (Exception ignored) { }
            finish();
        }
    }

    private void hideBars() {
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                WindowInsetsController c = getWindow().getInsetsController();
                if (c != null) c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
            } else {
                getWindow().getDecorView().setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
            }
        } catch (Exception ignored) { }
    }

    private int dp(float v) { return Math.round(getResources().getDisplayMetrics().density * v); }

    /** 液态玻璃底（与首页 #dock / #binge-fab 同族：半透明填充 + 1px 描边 + 圆角，由 elevation 出阴影） */
    private GradientDrawable glassDrawable(int fill, int stroke, int radiusDp) {
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.RECTANGLE);
        g.setCornerRadius(dp(radiusDp));
        g.setColor(fill);
        g.setStroke(dp(1), stroke);
        return g;
    }

    private void buildUi() {
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        setContentView(root);
        // 必须在 setContentView 之后：此时 decorView 才 attach，getInsetsController() 才可用
        hideBars();

        pageA = buildPage();
        pageB = buildPage();
        page = pageA;
        incoming = pageB;
        root.addView(pageA);
        root.addView(pageB);
        pageB.setVisibility(View.GONE);

        playerLayer = new FrameLayout(this);
        // 与 PlayerActivity 完全同源：用 XML 布局 inflate（surface_type=texture_view + use_controller=false）。
        // 代码 new PlayerView(this) 默认 surface_view，在 edge-to-edge 全屏下可能初始化异常。
        playerView = (PlayerView) getLayoutInflater().inflate(R.layout.episode_player, playerLayer, false);
        playerLayer.addView(playerView);
        message = new TextView(this);
        message.setTextColor(0xCCFFFFFF);
        message.setTextSize(13);
        message.setGravity(Gravity.CENTER);
        message.setPadding(dp(24), dp(12), dp(24), dp(12));
        message.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
        playerLayer.addView(message);
        playerLayer.setVisibility(View.GONE);

        root.setOnTouchListener((v, event) -> { handleTouch(event); return true; });
        populatePage(page, entry(index));
        mountPlayerLayer();
        buildDock();
        buildFab();
    }

    /** 首页同款底栏：刷剧页也保留，点 tab 切回传统首页对应栏目 */
    private void buildDock() {
        FrameLayout dock = new FrameLayout(this);
        dock.setBackground(glassDrawable(0x14FFFFFF, 0x26FFFFFF, 22));
        dock.setElevation(dp(10));
        LinearLayout row = new LinearLayout(this);
        row.setWeightSum(4);
        row.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        String[] tabs = {"首页", "剧场", "AI", "我的"};
        int[] icons = {R.drawable.ic_dock_home, R.drawable.ic_dock_theater, R.drawable.ic_dock_ai, R.drawable.ic_dock_me};
        for (int i = 0; i < tabs.length; i++) {
            final String tab = tabs[i];
            LinearLayout item = new LinearLayout(this);
            item.setOrientation(LinearLayout.VERTICAL);
            item.setGravity(Gravity.CENTER);
            item.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f));
            ImageView iv = new ImageView(this);
            iv.setImageResource(icons[i]);
            iv.setColorFilter(0xCCFFFFFF, PorterDuff.Mode.SRC_IN);
            iv.setScaleType(ImageView.ScaleType.FIT_CENTER);
            LinearLayout.LayoutParams ivp = new LinearLayout.LayoutParams(dp(22), dp(22));
            ivp.bottomMargin = dp(3);
            item.addView(iv, ivp);
            TextView tv = new TextView(this);
            tv.setText(tabs[i]);
            tv.setTextSize(11);
            tv.setTextColor(0xCCFFFFFF);
            item.addView(tv);
            item.setOnClickListener(v -> switchHome(tab));
            row.addView(item);
        }
        dock.addView(row);
        FrameLayout.LayoutParams dockParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(64), Gravity.BOTTOM);
        dockParams.leftMargin = dp(14);
        dockParams.rightMargin = dp(14);
        dockParams.bottomMargin = dp(12);
        root.addView(dock, dockParams);
    }

    /** 切换悬浮按钮：与首页常驻按钮同一语义、同一位置（right:16 / bottom:96）、同一玻璃材质。
     *  刷剧页里它是「首页」图标：点一下切回传统首页（finish 本页）。 */
    private void buildFab() {
        FrameLayout fab = new FrameLayout(this);
        fab.setBackground(glassDrawable(0x14FFFFFF, 0x26FFFFFF, 26));
        fab.setElevation(dp(10));
        ImageView icon = new ImageView(this);
        icon.setImageResource(R.drawable.ic_dock_home);
        icon.setColorFilter(0xFFFFFFFF, PorterDuff.Mode.SRC_IN);
        icon.setScaleType(ImageView.ScaleType.FIT_CENTER);
        fab.addView(icon, new FrameLayout.LayoutParams(dp(22), dp(22), Gravity.CENTER));
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(dp(52), dp(52), Gravity.END | Gravity.BOTTOM);
        params.rightMargin = dp(16);
        params.bottomMargin = dp(96);    // 与首页悬浮按钮同位置（在底栏之上）
        fab.setOnClickListener(v -> finish());
        root.addView(fab, params);
    }

    /** 切回传统首页：finish 并带上目标栏目，由 MainActivity 切换 tab */
    private void switchHome(String tab) {
        if (player != null) saveProgress(false);
        Intent data = new Intent();
        data.putExtra("bingeAction", "home");
        data.putExtra("nav", tab);
        setResult(RESULT_OK, data);
        finish();
    }

    private FrameLayout buildPage() {
        FrameLayout frame = new FrameLayout(this);
        frame.setBackgroundColor(Color.BLACK);
        ImageView poster = new ImageView(this);
        poster.setScaleType(ImageView.ScaleType.CENTER_CROP);
        poster.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        frame.addView(poster);

        // 横图/方图海报的完整居中层：模糊底之上显示完整海报（竖图或视频已起播时隐藏）
        ImageView posterFit = new ImageView(this);
        posterFit.setScaleType(ImageView.ScaleType.FIT_CENTER);
        posterFit.setVisibility(View.GONE);
        posterFit.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        frame.addView(posterFit);

        // 底部液态玻璃卡片：高度跟随「标题 + 简介 + 按钮」自适应，不再固定一大块。
        // 右侧留 76dp 给切换悬浮按钮，底部 90dp 落在底栏（bottom12+height64）之上。
        FrameLayout card = new FrameLayout(this);
        card.setBackground(glassDrawable(0x59000000, 0x33FFFFFF, 20));
        card.setElevation(dp(8));
        FrameLayout.LayoutParams cardParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM);
        cardParams.leftMargin = dp(14);
        cardParams.rightMargin = dp(76);
        cardParams.bottomMargin = dp(90);
        card.setLayoutParams(cardParams);

        LinearLayout info = new LinearLayout(this);
        info.setOrientation(LinearLayout.VERTICAL);
        info.setPadding(dp(16), dp(14), dp(16), dp(16));
        info.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView title = new TextView(this);
        title.setTextColor(Color.WHITE);
        title.setTextSize(18);
        title.setTypeface(boldTypeface());
        title.setShadowLayer(dp(2), 0, dp(1), 0xB3000000);
        info.addView(title, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView desc = new TextView(this);
        desc.setTextColor(0xE6FFFFFF);
        desc.setTextSize(12);
        desc.setLineSpacing(dp(2), 1f);
        desc.setMaxLines(2);
        desc.setEllipsize(android.text.TextUtils.TruncateAt.END);
        desc.setShadowLayer(dp(2), 0, dp(1), 0x99000000);
        LinearLayout.LayoutParams descParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        descParams.topMargin = dp(6);
        info.addView(desc, descParams);

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams buttonsParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        buttonsParams.topMargin = dp(12);
        info.addView(buttons, buttonsParams);

        TextView detailButton = pillButton("查看详情", false);
        detailButton.setOnClickListener(v -> openDetail());
        buttons.addView(detailButton);

        TextView fullButton = pillButton("观看全集", true);
        LinearLayout.LayoutParams fullParams = (LinearLayout.LayoutParams) fullButton.getLayoutParams();
        fullParams.leftMargin = dp(10);
        fullButton.setOnClickListener(v -> openFullEpisode());
        buttons.addView(fullButton);

        card.addView(info);
        frame.addView(card);
        frame.setTag(R.id.binge_poster, poster);
        frame.setTag(R.id.binge_poster_fit, posterFit);
        frame.setTag(R.id.binge_mask_title, title);
        frame.setTag(R.id.binge_mask_desc, desc);
        return frame;
    }

    private android.graphics.Typeface boldTypeface() {
        return android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD);
    }

    private TextView pillButton(String text, boolean primary) {
        TextView button = new TextView(this);
        button.setText(text);
        button.setTextColor(primary ? 0xFF221F17 : Color.WHITE);
        button.setTextSize(13);
        button.setGravity(Gravity.CENTER);
        button.setPadding(dp(18), 0, dp(18), 0);
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(11));
        bg.setColor(primary ? 0xFFFFC93E : 0x2EFFFFFF);
        button.setBackground(bg);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, dp(38));
        button.setLayoutParams(params);
        return button;
    }

    /** 把视频层（playerView/message）插到当前页海报之上、卡片之下 */
    private void mountPlayerLayer() {
        page.addView(playerLayer, Math.min(1, page.getChildCount()), new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void populatePage(FrameLayout frame, JSONObject entry) {
        if (entry == null) return;
        ImageView poster = (ImageView) frame.getTag(R.id.binge_poster);
        TextView title = (TextView) frame.getTag(R.id.binge_mask_title);
        TextView desc = (TextView) frame.getTag(R.id.binge_mask_desc);
        String cover = entry.optString("cover");
        poster.setImageDrawable(null);
        poster.setAlpha(1f);
        ImageView posterFit = (ImageView) frame.getTag(R.id.binge_poster_fit);
        if (posterFit != null) { posterFit.setImageDrawable(null); posterFit.setVisibility(View.GONE); }
        title.setText(entry.optString("title"));
        String description = entry.optString("description");
        desc.setText(description.isEmpty() ? "正在加载…" : description);
        loadPoster(cover, poster, frame);
    }

    private void loadPoster(String url, ImageView target, FrameLayout frame) {
        if (url == null || url.isEmpty()) return;
        target.setTag(url);
        Bitmap cached;
        synchronized (posterCache) { cached = posterCache.get(url); }
        if (cached != null) {
            applyPosterMode(frame, cached, false, true);
            return;
        }
        final FrameLayout frameRef = frame;
        worker.execute(() -> {
            try {
                String data = repository.coverData(url);
                byte[] bytes = Base64.decode(data.substring(data.indexOf(',') + 1), Base64.DEFAULT);
                Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                if (bitmap == null) return;
                synchronized (posterCache) { posterCache.put(url, bitmap); }
                runOnUiThread(() -> {
                    if (destroyed || isFinishing() || !url.equals(target.getTag())) return;
                    applyPosterMode(frameRef, bitmap, false, true);
                });
            } catch (Exception ignored) { }
        });
    }

    /**
     * 海报展示模式：
     * 竖图 → CENTER_CROP 铺满（现状不变）；
     * 横图/方图、或视频是横屏 → 高斯模糊海报做全屏暗化背景 +（可选）完整海报居中显示。
     */
    private void applyPosterMode(FrameLayout frame, Bitmap bitmap, boolean forceBlur, boolean showFit) {
        if (frame == null || bitmap == null) return;
        ImageView poster = (ImageView) frame.getTag(R.id.binge_poster);
        ImageView fit = (ImageView) frame.getTag(R.id.binge_poster_fit);
        if (poster == null) return;
        boolean blur = forceBlur || bitmap.getWidth() >= bitmap.getHeight() * 0.85f;
        if (blur) {
            poster.setImageBitmap(gaussianBlur(bitmap, 12));
            poster.setAlpha(0.72f);   // 模糊底压暗，突出完整海报与视频
            if (fit != null) {
                fit.setImageBitmap(bitmap);
                fit.setVisibility(showFit ? View.VISIBLE : View.GONE);
            }
        } else {
            poster.setImageBitmap(bitmap);
            poster.setAlpha(1f);
            if (fit != null) fit.setVisibility(View.GONE);
        }
    }

    /** 真正的高斯模糊：小图先放大到合适尺寸（避免放大马赛克），再用 3 次盒式模糊逼近高斯。
     *  输出分辨率无关、平滑，不像「缩到极小再放大」那样出马赛克。 */
    private Bitmap gaussianBlur(Bitmap source, int radius) {
        if (source == null) return null;
        try {
            Bitmap b = source;
            int minSide = Math.min(source.getWidth(), source.getHeight());
            if (minSide < 540) {
                float scale = 540f / minSide;
                b = Bitmap.createScaledBitmap(source, Math.round(source.getWidth() * scale),
                        Math.round(source.getHeight() * scale), true);
            }
            int r = Math.max(2, radius);
            Bitmap out = boxBlur(b, r, 3);
            if (b != source) b.recycle();
            return out;
        } catch (Exception ignored) { return source; }
    }

    /** 基于滑动窗口求和的可分离盒式模糊，passes 次迭代逼近高斯 */
    private Bitmap boxBlur(Bitmap src, int r, int passes) {
        int w = src.getWidth(), h = src.getHeight();
        int[] pix = new int[w * h];
        src.getPixels(pix, 0, w, 0, 0, w, h);
        int[] tmp = new int[w * h];
        for (int p = 0; p < passes; p++) {
            boxPass(pix, tmp, w, h, r, true);
            boxPass(tmp, pix, w, h, r, false);
        }
        Bitmap out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        out.setPixels(pix, 0, w, 0, 0, w, h);
        return out;
    }

    private void boxPass(int[] src, int[] dst, int w, int h, int r, boolean horizontal) {
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int sumR = 0, sumG = 0, sumB = 0, count = 0;
                for (int k = -r; k <= r; k++) {
                    int cx = horizontal ? clamp(x + k, 0, w - 1) : x;
                    int cy = horizontal ? y : clamp(y + k, 0, h - 1);
                    int c = src[cy * w + cx];
                    sumR += (c >> 16) & 0xff;
                    sumG += (c >> 8) & 0xff;
                    sumB += c & 0xff;
                    count++;
                }
                int idx = y * w + x;
                dst[idx] = 0xff000000 | ((sumR / count) << 16) | ((sumG / count) << 8) | (sumB / count);
            }
        }
    }

    private static int clamp(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

    private JSONObject entry(int i) { return pool.optJSONObject(i); }

    // ---------- 数据加载与播放 ----------

    private void loadShow() {
        loadToken++;
        final int token = loadToken;
        JSONObject entry = entry(index);
        if (entry == null) { finish(); return; }
        currentId = entry.optString("id");
        currentCover = entry.optString("cover");
        currentEpisode = 1;
        episodeCount = 0;
        detail = null;
        currentSource = null;
        populatePage(page, entry);
        // 视频层从旧页搬到当前页（换剧时页已交换）
        if (playerLayer.getParent() instanceof ViewGroup) ((ViewGroup) playerLayer.getParent()).removeView(playerLayer);
        mountPlayerLayer();
        playerLayer.setAlpha(0f);   // 海报 → 视频无缝衔接：首帧渲染后才淡入
        playerLayer.setVisibility(View.GONE);
        message.setVisibility(View.GONE);
        releasePlayer();
        worker.execute(() -> {
            try {
                JSONObject d = detailCache.get(currentId);
                if (d == null) { d = repository.detail(currentId); detailCache.put(currentId, d); }
                if (Thread.currentThread().isInterrupted()) return;
                detail = d;
                JSONArray episodes = d.optJSONArray("episodes");
                episodeCount = episodes == null ? 0 : episodes.length();
                String description = d.optString("description", "");
                runOnUiThread(() -> {
                    if (destroyed || isFinishing() || token != loadToken) return;
                    TextView desc = (TextView) page.getTag(R.id.binge_mask_desc);
                    if (desc != null && !description.isEmpty()) desc.setText(description);
                });
                if (episodeCount <= 0) throw new IllegalStateException("该剧暂无可播放的选集");
                JSONObject cachedReady = readyCache.get(currentId);
                final JSONObject ready = cachedReady != null
                        ? cachedReady : repository.episode(currentId, 1);
                if (cachedReady == null) readyCache.put(currentId, ready);
                if (Thread.currentThread().isInterrupted()) return;
                runOnUiThread(() -> { if (!destroyed && !isFinishing() && token == loadToken) startPlayback(ready); });
                schedulePrefetch();
            } catch (Exception error) {
                runOnUiThread(() -> {
                    if (destroyed || isFinishing() || token != loadToken) return;
                    message.setText("加载失败: " + error.getMessage() + "\n上滑换一部");
                    message.setVisibility(View.VISIBLE);
                });
            }
        });
    }

    /** 预缓存后面三部剧的详情与第 1 集播放地址：滑到即播，不再现场解析等待 */
    private void schedulePrefetch() {
        prefetcher.execute(() -> {
            for (int i = index + 1; i <= index + 3 && i < pool.length(); i++) {
                JSONObject e = entry(i);
                if (e == null) continue;
                String id = e.optString("id");
                if (id.isEmpty() || detailCache.containsKey(id) || !prefetching.add(id)) continue;
                try {
                    JSONObject d = repository.detail(id);
                    detailCache.put(id, d);
                    JSONArray eps = d == null ? null : d.optJSONArray("episodes");
                    if (eps != null && eps.length() > 0) {
                        JSONObject ready = repository.episode(id, 1);
                        if (ready != null && !ready.optString("source").isEmpty()) readyCache.put(id, ready);
                    }
                } catch (Exception ignored) { }
                finally { prefetching.remove(id); }
            }
        });
    }

    private void startPlayback(JSONObject ready) {
        try {
        currentSource = ready.optString("source");
        currentMime = ready.optString("mimeType", MimeTypes.APPLICATION_M3U8);
        if (currentSource.isEmpty()) {
            message.setText("暂时取不到播放地址\n上滑换一部");
            message.setVisibility(View.VISIBLE);
            return;
        }
        releasePlayer();
        player = new ExoPlayer.Builder(this)
                .setMediaSourceFactory(VideoPlaybackCache.sources(this))
                .build();
        player.addListener(new Player.Listener() {
            @Override public void onPlaybackStateChanged(int state) {
                if (destroyed || isFinishing()) return;
                if (state == Player.STATE_READY) {
                    message.setVisibility(View.GONE);
                } else if (state == Player.STATE_ENDED) {
                    saveProgress(true);
                    onEpisodeEnded();
                }
            }

            @Override public void onRenderedFirstFrame() {
                // 海报 → 视频 无缝衔接：首帧真正渲染出来才淡入，全程无转圈、无黑屏
                if (destroyed || isFinishing()) return;
                playerLayer.animate().alpha(1f).setDuration(200).start();
                ImageView fit = (ImageView) page.getTag(R.id.binge_poster_fit);
                if (fit != null) fit.setVisibility(View.GONE);
            }

            @Override public void onVideoSizeChanged(VideoSize size) {
                // 竖屏铺满裁切，横屏按比例完整显示
                playerView.setResizeMode(size.width > 0 && size.width > size.height
                        ? AspectRatioFrameLayout.RESIZE_MODE_FIT
                        : AspectRatioFrameLayout.RESIZE_MODE_ZOOM);
                // 横屏视频：海报切换为高斯模糊暗化背景，视频两侧不再露出杂乱的裁切海报
                if (size.width > size.height) {
                    Bitmap bmp;
                    synchronized (posterCache) { bmp = posterCache.get(currentCover); }
                    if (bmp != null) applyPosterMode(page, bmp, true, false);
                }
            }

            @Override public void onPlayerError(PlaybackException error) {
                if (destroyed || isFinishing()) return;
                message.setText("播放失败: " + error.getMessage() + "\n上滑换一部");
                message.setVisibility(View.VISIBLE);
            }
        });
        playerView.setPlayer(player);
        MediaItem mediaItem = new MediaItem.Builder()
                .setUri(currentSource)
                .setMediaId(currentId + ":" + currentEpisode)
                .setMimeType(currentMime)
                .build();
        player.setMediaSource(VideoPlaybackCache.sources(this).createMediaSource(mediaItem), resumePosition(currentId, currentEpisode));
        player.prepare();
        player.setPlayWhenReady(true);
        playerLayer.setAlpha(0f);
        playerLayer.setVisibility(View.VISIBLE);   // alpha 0：首帧渲染后才淡入（onRenderedFirstFrame）
        } catch (Throwable error) {
            if (destroyed || isFinishing()) return;
            try { releasePlayer(); } catch (Exception ignored) { }
            message.setText("播放启动失败: " + error.getMessage() + "\n上滑换一部");
            message.setVisibility(View.VISIBLE);
        }
    }

    private void onEpisodeEnded() {
        int next = currentEpisode + 1;
        if (detail != null && next <= episodeCount) { openInPlayer(next); return; }
        // 第一集就是大结局：直接滑到下一部
        if (index + 1 < pool.length()) advance(1);
        else finish();
    }

    /** 进入具体播放页（PlayerActivity 自己会按已存进度续播） */
    private void openInPlayer(int episode) {
        try {
            JSONObject item = new JSONObject()
                    .put("id", currentId)
                    .put("title", maskTitleText())
                    .put("cover", currentCover == null ? "" : currentCover);
            JSONObject payload = new JSONObject()
                    .put("item", item)
                    .put("detail", detail)
                    .put("episodes", detail == null ? new JSONArray() : detail.optJSONArray("episodes"))
                    .put("episode", episode)
                    .put("source", ContentMode.get(this).active());
            Intent intent = new Intent(this, PlayerActivity.class);
            intent.putExtra("payload", payload.toString());
            // 不 finish：播放页返回后仍停留在刷剧模式的这部剧上
            startActivity(intent);
        } catch (Exception ignored) { }
    }

    private String maskTitleText() {
        TextView title = (TextView) page.getTag(R.id.binge_mask_title);
        return title == null ? "" : title.getText().toString();
    }

    // ---------- 进度 ----------

    private long resumePosition(String id, int episode) {
        JSONObject progress = store.getProgress(id, episode);
        if (progress == null || progress.optBoolean("completed")) return 0;
        long position = progress.optLong("position");
        return position > 0 && position < progress.optLong("duration") ? position : 0;
    }

    private void saveProgress(boolean completed) {
        if (player == null || currentId == null || player.getDuration() <= 0) return;
        try {
            JSONObject value = new JSONObject();
            value.put("id", currentId);
            value.put("episode", currentEpisode);
            value.put("episodeCount", episodeCount);
            value.put("title", maskTitleText());
            value.put("cover", currentCover == null ? "" : currentCover);
            value.put("position", player.getCurrentPosition());
            value.put("duration", player.getDuration());
            value.put("completed", completed);
            store.recordProgress(value);
            lastSaved = System.currentTimeMillis();
        } catch (Exception ignored) { }
    }

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (!destroyed && player != null && player.isPlaying()
                    && System.currentTimeMillis() - lastSaved > 5000) saveProgress(false);
            handler.postDelayed(this, 1000);
        }
    };

    // ---------- 上下滑切剧 ----------

    private void handleTouch(MotionEvent event) {
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                downY = event.getY();
                swiping = false;
                break;
            case MotionEvent.ACTION_MOVE:
                float dy = event.getY() - downY;
                if (!swiping && Math.abs(dy) > dp(14)) swiping = true;
                if (swiping && !animating) {
                    // 到边界后加阻尼
                    float offset = dy;
                    if ((index == 0 && dy > 0) || (index >= pool.length() - 1 && dy < 0)) offset = dy * 0.35f;
                    page.setTranslationY(offset);
                }
                break;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                if (swiping && !animating) {
                    float dy2 = page.getTranslationY();
                    page.setTranslationY(0);
                    if (dy2 < -dp(120) && index < pool.length() - 1) advance(1);
                    else if (dy2 > dp(120) && index > 0) advance(-1);
                }
                swiping = false;
                break;
        }
    }

    /** 换剧：当前页滑出，预置好的新页从同侧滑入 */
    private void advance(int direction) {
        if (animating) return;
        int target = index + direction;
        if (target < 0 || target >= pool.length()) return;
        animating = true;
        if (player != null) player.setPlayWhenReady(false);
        populatePage(incoming, entry(target));
        incoming.setTranslationY(direction > 0 ? root.getHeight() : -root.getHeight());
        incoming.setAlpha(1f);
        incoming.setVisibility(View.VISIBLE);
        float height = root.getHeight();
        page.animate().translationY(direction > 0 ? -height : height).setDuration(300).start();
        incoming.animate().translationY(0).setDuration(300).withEndAction(() -> {
            FrameLayout old = page;
            page = incoming;
            incoming = old;
            old.setVisibility(View.GONE);
            old.setTranslationY(0);
            index = target;
            animating = false;
            loadShow();
        }).start();
    }

    // ---------- 按钮 ----------

    /** 查看详情：回主 WebView 进详情页 */
    private void openDetail() {
        if (player != null) saveProgress(false);
        Intent data = new Intent();
        data.putExtra("bingeAction", "detail");
        data.putExtra("id", currentId);
        data.putExtra("index", index);   // 返回后要回到刷剧的这部剧
        setResult(RESULT_OK, data);
        finish();
    }

    /** 观看全集：进具体播放页，PlayerActivity 按已存进度续播当前集 */
    private void openFullEpisode() {
        if (player != null) saveProgress(false);
        openInPlayer(Math.max(1, currentEpisode));
    }

    private void releasePlayer() {
        if (player != null) {
            player.release();
            player = null;
        }
        playerView.setPlayer(null);
    }

    @Override protected void onResume() {
        super.onResume();
        hideBars();
        if (player != null) player.setPlayWhenReady(true);
        handler.post(tick);
    }

    @Override protected void onPause() {
        super.onPause();
        if (player != null) {
            player.setPlayWhenReady(false);
            saveProgress(false);
        }
        handler.removeCallbacks(tick);
    }

    @Override protected void onDestroy() {
        super.onDestroy();
        destroyed = true;
        handler.removeCallbacksAndMessages(null);
        releasePlayer();
        worker.shutdown();
        prefetcher.shutdown();
    }
}
