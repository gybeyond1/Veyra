package com.veyra.gybeyond;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
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
import android.widget.ProgressBar;
import android.widget.TextView;

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
 * 视频未起播前显示该剧海报；底部一层轻模糊遮罩承载标题/简介和
 * 「查看详情 / 观看全集」两个按钮。进度实时写入 AppStore，
 * 「观看全集」进 PlayerActivity 时按已存进度续播；
 * 第 1 集播完未滑动 → 自动进播放页播第 2 集并一直连播。
 */
public class BingeActivity extends Activity {

    private DualContentRepository repository;
    private AppStore store;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
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
    private ProgressBar loading;
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

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= 29) getWindow().setNavigationBarContrastEnforced(false);
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        hideBars();
        repository = new DualContentRepository(this);
        store = new AppStore(this);
        try {
            JSONObject payload = new JSONObject(getIntent().getStringExtra("payload"));
            ContentMode.get(this).require(payload.optString("source", ContentMode.get(this).active()));
            pool = payload.optJSONArray("items");
            if (pool == null || pool.length() == 0) throw new IllegalArgumentException("没有可刷的内容");
            index = Math.max(0, payload.optInt("index", 0));
        } catch (Exception error) {
            finish();
            return;
        }
        buildUi();
        loadShow();
    }

    private void hideBars() {
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    private int dp(float v) { return Math.round(getResources().getDisplayMetrics().density * v); }

    private void buildUi() {
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        setContentView(root);

        pageA = buildPage();
        pageB = buildPage();
        page = pageA;
        incoming = pageB;
        root.addView(pageA);
        root.addView(pageB);
        pageB.setVisibility(View.GONE);

        playerLayer = new FrameLayout(this);
        playerView = new PlayerView(this);
        playerView.setUseController(false);
        playerView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        playerLayer.addView(playerView);
        loading = new ProgressBar(this);
        FrameLayout.LayoutParams loadingParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER);
        loading.setLayoutParams(loadingParams);
        playerLayer.addView(loading);
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
    }

    private FrameLayout buildPage() {
        FrameLayout frame = new FrameLayout(this);
        frame.setBackgroundColor(Color.BLACK);
        ImageView poster = new ImageView(this);
        poster.setScaleType(ImageView.ScaleType.CENTER_CROP);
        poster.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        frame.addView(poster);

        // 底部轻模糊遮罩：用缩小海报拉伸作模糊底 + 渐变压暗
        LinearLayout mask = new LinearLayout(this);
        mask.setOrientation(LinearLayout.VERTICAL);
        FrameLayout.LayoutParams maskParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(210), Gravity.BOTTOM);
        mask.setLayoutParams(maskParams);
        mask.setClipChildren(false);

        ImageView backdrop = new ImageView(this);
        backdrop.setScaleType(ImageView.ScaleType.CENTER_CROP);
        backdrop.setAlpha(0.32f);
        backdrop.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        mask.addView(backdrop);

        View shade = new View(this);
        shade.setBackground(gradient(0x00000000, 0xB3000000));
        shade.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        mask.addView(shade);

        LinearLayout info = new LinearLayout(this);
        info.setOrientation(LinearLayout.VERTICAL);
        info.setPadding(dp(18), dp(10), dp(18), dp(26));
        info.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        TextView title = new TextView(this);
        title.setTextColor(Color.WHITE);
        title.setTextSize(19);
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

        mask.addView(info, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        frame.setTag(R.id.binge_poster, poster);
        frame.setTag(R.id.binge_mask_title, title);
        frame.setTag(R.id.binge_mask_desc, desc);
        frame.setTag(R.id.binge_mask_backdrop, backdrop);
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

    private GradientDrawable gradient(int top, int bottom) {
        GradientDrawable drawable = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[]{top, bottom});
        return drawable;
    }

    /** 把视频层（playerView/loading/message）插到当前页海报之上、遮罩之下 */
    private void mountPlayerLayer() {
        page.addView(playerLayer, Math.min(1, page.getChildCount()), new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void populatePage(FrameLayout frame, JSONObject entry) {
        if (entry == null) return;
        ImageView poster = (ImageView) frame.getTag(R.id.binge_poster);
        TextView title = (TextView) frame.getTag(R.id.binge_mask_title);
        TextView desc = (TextView) frame.getTag(R.id.binge_mask_desc);
        ImageView backdrop = (ImageView) frame.getTag(R.id.binge_mask_backdrop);
        String cover = entry.optString("cover");
        poster.setImageDrawable(null);
        backdrop.setImageDrawable(null);
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
            target.setImageBitmap(cached);
            ImageView backdrop = (ImageView) frame.getTag(R.id.binge_mask_backdrop);
            if (backdrop != null) backdrop.setImageBitmap(blurStub(cached));
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
                    target.setImageBitmap(bitmap);
                    ImageView backdrop = (ImageView) frameRef.getTag(R.id.binge_mask_backdrop);
                    if (backdrop != null) backdrop.setImageBitmap(blurStub(bitmap));
                });
            } catch (Exception ignored) { }
        });
    }

    /** 缩到极小再放大 = 天然的轻模糊遮罩底 */
    private Bitmap blurStub(Bitmap source) {
        try {
            int w = Math.max(8, source.getWidth() / 28);
            int h = Math.max(8, source.getHeight() / 28);
            Bitmap small = Bitmap.createScaledBitmap(source, w, h, true);
            return Bitmap.createScaledBitmap(small, source.getWidth(), source.getHeight(), true);
        } catch (Exception ignored) { return source; }
    }

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
        playerLayer.setVisibility(View.GONE);
        loading.setVisibility(View.VISIBLE);
        message.setVisibility(View.GONE);
        releasePlayer();
        worker.execute(() -> {
            try {
                JSONObject d = repository.detail(currentId);
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
                JSONObject ready = repository.episode(currentId, 1);
                if (Thread.currentThread().isInterrupted()) return;
                runOnUiThread(() -> { if (!destroyed && !isFinishing() && token == loadToken) startPlayback(ready); });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    if (destroyed || isFinishing() || token != loadToken) return;
                    loading.setVisibility(View.GONE);
                    message.setText("加载失败: " + error.getMessage() + "\n上滑换一部");
                    message.setVisibility(View.VISIBLE);
                });
            }
        });
    }

    private void startPlayback(JSONObject ready) {
        currentSource = ready.optString("source");
        currentMime = ready.optString("mimeType", MimeTypes.APPLICATION_M3U8);
        if (currentSource.isEmpty()) {
            loading.setVisibility(View.GONE);
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
                    loading.setVisibility(View.GONE);
                    message.setVisibility(View.GONE);
                } else if (state == Player.STATE_ENDED) {
                    saveProgress(true);
                    onEpisodeEnded();
                }
            }

            @Override public void onVideoSizeChanged(VideoSize size) {
                // 竖屏铺满裁切，横屏按比例完整显示
                playerView.setResizeMode(size.width > 0 && size.width > size.height
                        ? AspectRatioFrameLayout.RESIZE_MODE_FIT
                        : AspectRatioFrameLayout.RESIZE_MODE_ZOOM);
            }

            @Override public void onPlayerError(PlaybackException error) {
                if (destroyed || isFinishing()) return;
                loading.setVisibility(View.GONE);
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
        playerLayer.setVisibility(View.VISIBLE);
        loading.setVisibility(View.VISIBLE);
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
            startActivity(intent);
            finish();
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
    }
}
