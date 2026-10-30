package com.veyra.gybeyond;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageView;
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
import java.util.HashSet;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 刷剧视频引擎（从原 BingeActivity 抽出）：与 Activity 解耦，由 MainActivity 持有。
 * 只负责原生视频层（海报 + 高斯模糊背景 + ExoPlayer），UI（真底栏 / 真玻璃卡片）留在首页 WebView。
 * 换剧、卡片内容通过 Callback 回写 WebView；上下滑由 WebView 触发 next()/prev()。
 */
public class BingeEngine {

    public interface Callback {
        Activity getActivity();
        /** 当前剧加载完成（或详情到达）时刷新 WebView 卡片 */
        void onShowLoaded(String title, String description, String cover, String id, int index);
        /** 加载失败：把提示交给 WebView 显示 */
        void onShowFailed(String message);
    }

    private final Callback cb;
    private final FrameLayout videoLayer;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService prefetcher = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(Looper.getMainLooper());

    private DualContentRepository repository;
    private AppStore store;

    private JSONArray pool;
    private int index;
    private String currentCover;

    private ImageView poster;
    private ImageView posterFit;
    private PlayerView playerView;
    private TextView message;

    private ExoPlayer player;
    private String currentId;
    private int currentEpisode = 1;
    private int episodeCount;
    private JSONObject detail;
    private String currentSource;
    private String currentTitle;
    private String currentMime = MimeTypes.APPLICATION_M3U8;
    private long lastSaved;
    private int loadToken;
    private boolean destroyed;
    private boolean animating;
    private boolean active;
    private final Map<String, Bitmap> posterCache = new HashMap<>();
    private final Map<String, JSONObject> detailCache = new ConcurrentHashMap<>();
    private final Map<String, JSONObject> readyCache = new ConcurrentHashMap<>();
    private final HashSet<String> prefetching = new HashSet<>();

    public BingeEngine(Callback cb, FrameLayout videoLayer) {
        this.cb = cb;
        this.videoLayer = videoLayer;
        buildVideoLayer();
        videoLayer.setVisibility(View.GONE);
    }

    private Activity activity() { return cb.getActivity(); }

    private int dp(float v) {
        return Math.round(activity().getResources().getDisplayMetrics().density * v);
    }

    private void buildVideoLayer() {
        poster = new ImageView(activity());
        poster.setScaleType(ImageView.ScaleType.CENTER_CROP);
        poster.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        videoLayer.addView(poster);

        posterFit = new ImageView(activity());
        posterFit.setScaleType(ImageView.ScaleType.FIT_CENTER);
        posterFit.setVisibility(View.GONE);
        posterFit.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        videoLayer.addView(posterFit);

        playerView = (PlayerView) activity().getLayoutInflater()
                .inflate(R.layout.episode_player, videoLayer, false);
        playerView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        videoLayer.addView(playerView);

        message = new TextView(activity());
        message.setTextColor(0xCCFFFFFF);
        message.setTextSize(13);
        message.setGravity(Gravity.CENTER);
        message.setPadding(dp(24), dp(12), dp(24), dp(12));
        message.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
        videoLayer.addView(message);
    }

    // ---------- 生命周期 ----------

    public void start(JSONArray items, int startIndex, String source) {
        try {
            repository = new DualContentRepository(activity());
            store = new AppStore(activity());
            ContentMode.get(activity()).require(source == null ? ContentMode.get(activity()).active() : source);
            if (items == null || items.length() == 0) return;
            pool = items;
            index = Math.max(0, Math.min(startIndex, items.length() - 1));
            active = true;
            videoLayer.setVisibility(View.VISIBLE);
            videoLayer.setAlpha(1f);
            videoLayer.setTranslationY(0f);
            hideBars();
            loadShow();
        } catch (Throwable error) {
            active = false;
            videoLayer.setVisibility(View.GONE);
            cb.onShowFailed("进入刷剧模式失败: " + error.getMessage());
        }
    }

    public void exit() {
        active = false;
        releasePlayer();
        videoLayer.setVisibility(View.GONE);
        showBars();
        activity().setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
    }

    public void onResume() {
        if (!active) return;
        hideBars();
        if (player != null) player.setPlayWhenReady(true);
        handler.post(tick);
    }

    public void onPause() {
        if (player != null) {
            player.setPlayWhenReady(false);
            saveProgress(false);
        }
        handler.removeCallbacks(tick);
    }

    public void onDestroy() {
        destroyed = true;
        handler.removeCallbacksAndMessages(null);
        releasePlayer();
        worker.shutdown();
        prefetcher.shutdown();
    }

    // ---------- 沉浸状态栏 / 竖屏锁定 ----------

    private void hideBars() {
        try {
            activity().setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
            if (Build.VERSION.SDK_INT >= 30) {
                WindowInsetsController c = activity().getWindow().getInsetsController();
                if (c != null) c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
            } else {
                activity().getWindow().getDecorView().setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
            }
        } catch (Exception ignored) { }
    }

    private void showBars() {
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                WindowInsetsController c = activity().getWindow().getInsetsController();
                if (c != null) c.show(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
            } else {
                activity().getWindow().getDecorView().setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
            }
        } catch (Exception ignored) { }
    }

    // ---------- 数据加载与播放 ----------

    private void loadShow() {
        loadToken++;
        final int token = loadToken;
        JSONObject entry = entry(index);
        if (entry == null) { exit(); return; }
        currentId = entry.optString("id");
        currentCover = entry.optString("cover");
        currentTitle = entry.optString("title");
        currentEpisode = 1;
        episodeCount = 0;
        detail = null;
        currentSource = null;
        message.setVisibility(View.GONE);
        playerView.setAlpha(0f);
        playerView.setVisibility(View.GONE);
        releasePlayer();
        loadPoster(currentCover);
        cb.onShowLoaded(currentTitle, "正在加载…", currentCover, currentId, index);
        worker.execute(() -> {
            try {
                JSONObject d = detailCache.get(currentId);
                if (d == null) { d = repository.detail(currentId); detailCache.put(currentId, d); }
                if (Thread.currentThread().isInterrupted()) return;
                detail = d;
                JSONArray episodes = d.optJSONArray("episodes");
                episodeCount = episodes == null ? 0 : episodes.length();
                String description = d.optString("description", "");
                final String desc = description;
                handler.post(() -> {
                    if (destroyed || !active || token != loadToken) return;
                    if (!desc.isEmpty()) cb.onShowLoaded(currentTitle, desc, currentCover, currentId, index);
                });
                if (episodeCount <= 0) throw new IllegalStateException("该剧暂无可播放的选集");
                JSONObject cachedReady = readyCache.get(currentId);
                final JSONObject ready = cachedReady != null
                        ? cachedReady : repository.episode(currentId, 1);
                if (cachedReady == null) readyCache.put(currentId, ready);
                if (Thread.currentThread().isInterrupted()) return;
                handler.post(() -> { if (!destroyed && active && token == loadToken) startPlayback(ready); });
                schedulePrefetch();
            } catch (Exception error) {
                handler.post(() -> {
                    if (destroyed || !active || token != loadToken) return;
                    cb.onShowFailed("加载失败: " + error.getMessage() + "\n上滑换一部");
                });
            }
        });
    }

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
                cb.onShowFailed("暂时取不到播放地址\n上滑换一部");
                return;
            }
            releasePlayer();
            player = new ExoPlayer.Builder(activity())
                    .setMediaSourceFactory(VideoPlaybackCache.sources(activity()))
                    .build();
            player.addListener(new Player.Listener() {
                @Override public void onPlaybackStateChanged(int state) {
                    if (destroyed || !active) return;
                    if (state == Player.STATE_READY) message.setVisibility(View.GONE);
                    else if (state == Player.STATE_ENDED) {
                        saveProgress(true);
                        onEpisodeEnded();
                    }
                }

                @Override public void onRenderedFirstFrame() {
                    if (destroyed || !active) return;
                    playerView.animate().alpha(1f).setDuration(200).start();
                    posterFit.setVisibility(View.GONE);
                }

                @Override public void onVideoSizeChanged(VideoSize size) {
                    playerView.setResizeMode(size.width > 0 && size.width > size.height
                            ? AspectRatioFrameLayout.RESIZE_MODE_FIT
                            : AspectRatioFrameLayout.RESIZE_MODE_ZOOM);
                    if (size.width > size.height) {
                        Bitmap bmp;
                        synchronized (posterCache) { bmp = posterCache.get(currentCover); }
                        if (bmp != null) applyPosterMode(bmp, true, false);
                    }
                }

                @Override public void onPlayerError(PlaybackException error) {
                    if (destroyed || !active) return;
                    cb.onShowFailed("播放失败: " + error.getMessage() + "\n上滑换一部");
                }
            });
            playerView.setPlayer(player);
            MediaItem mediaItem = new MediaItem.Builder()
                    .setUri(currentSource)
                    .setMediaId(currentId + ":" + currentEpisode)
                    .setMimeType(currentMime)
                    .build();
            player.setMediaSource(VideoPlaybackCache.sources(activity()).createMediaSource(mediaItem),
                    resumePosition(currentId, currentEpisode));
            player.prepare();
            player.setPlayWhenReady(true);
            playerView.setAlpha(0f);
            playerView.setVisibility(View.VISIBLE);
        } catch (Throwable error) {
            if (destroyed || !active) return;
            try { releasePlayer(); } catch (Exception ignored) { }
            cb.onShowFailed("播放启动失败: " + error.getMessage() + "\n上滑换一部");
        }
    }

    private void onEpisodeEnded() {
        int next = currentEpisode + 1;
        if (detail != null && next <= episodeCount) { openInPlayer(next); return; }
        if (index + 1 < pool.length()) advance(1);
        else exit();
    }

    // ---------- 上下滑换剧（由 WebView 触发） ----------

    public void next() { advance(1); }
    public void prev() { advance(-1); }

    private void advance(int direction) {
        if (animating || !active) return;
        int target = index + direction;
        if (target < 0 || target >= pool.length()) {
            // 边界：阻尼回弹
            float dir = direction > 0 ? -1 : 1;
            videoLayer.animate().translationY(dp(28) * dir).setDuration(120)
                    .withEndAction(() -> videoLayer.animate().translationY(0).setDuration(160).start()).start();
            return;
        }
        animating = true;
        if (player != null) player.setPlayWhenReady(false);
        float height = videoLayer.getHeight();
        videoLayer.animate().translationY(direction > 0 ? -height : height).setDuration(280).start();
        worker.execute(() -> {
            handler.post(() -> {
                index = target;
                loadShow();
                videoLayer.setTranslationY(direction > 0 ? height : -height);
                videoLayer.animate().translationY(0).setDuration(280)
                        .withEndAction(() -> animating = false).start();
            });
        });
    }

    // ---------- 海报 / 模糊背景 ----------

    private void loadPoster(String url) {
        if (url == null || url.isEmpty()) return;
        Bitmap cached;
        synchronized (posterCache) { cached = posterCache.get(url); }
        if (cached != null) { applyPosterMode(cached, false, true); return; }
        worker.execute(() -> {
            try {
                String data = repository.coverData(url);
                byte[] bytes = Base64.decode(data.substring(data.indexOf(',') + 1), Base64.DEFAULT);
                Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                if (bitmap == null) return;
                synchronized (posterCache) { posterCache.put(url, bitmap); }
                handler.post(() -> {
                    if (destroyed || !active) return;
                    applyPosterMode(bitmap, false, true);
                });
            } catch (Exception ignored) { }
        });
    }

    /** 竖图 → CENTER_CROP 铺满；横/方图或视频横屏 → 高斯模糊暗化背景 + 居中完整海报 */
    private void applyPosterMode(Bitmap bitmap, boolean forceBlur, boolean showFit) {
        if (bitmap == null) return;
        boolean blur = forceBlur || bitmap.getWidth() >= bitmap.getHeight() * 0.85f;
        if (blur) {
            poster.setImageBitmap(gaussianBlur(bitmap, 12));
            poster.setAlpha(0.72f);
            if (showFit) { posterFit.setImageBitmap(bitmap); posterFit.setVisibility(View.VISIBLE); }
            else posterFit.setVisibility(View.GONE);
        } else {
            poster.setImageBitmap(bitmap);
            poster.setAlpha(1f);
            posterFit.setVisibility(View.GONE);
        }
    }

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
            value.put("title", currentTitle == null ? "" : currentTitle);
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
            if (!destroyed && active && player != null && player.isPlaying()
                    && System.currentTimeMillis() - lastSaved > 5000) saveProgress(false);
            handler.postDelayed(this, 1000);
        }
    };

    // ---------- 详情 / 全集（供 MainActivity 取用） ----------

    public boolean isActive() { return active; }

    public JSONObject buildPlayerPayload(int episode) {
        try {
            JSONObject item = new JSONObject()
                    .put("id", currentId)
                    .put("title", currentTitle == null ? "" : currentTitle)
                    .put("cover", currentCover == null ? "" : currentCover);
            return new JSONObject()
                    .put("item", item)
                    .put("detail", detail)
                    .put("episodes", detail == null ? new JSONArray() : detail.optJSONArray("episodes"))
                    .put("episode", episode)
                    .put("source", ContentMode.get(activity()).active());
        } catch (Exception ignored) { return null; }
    }

    public void openInPlayer(int episode) {
        JSONObject payload = buildPlayerPayload(episode);
        if (payload == null) return;
        try {
            if (player != null) saveProgress(false);
            Intent intent = new Intent(activity(), PlayerActivity.class);
            intent.putExtra("payload", payload.toString());
            activity().startActivity(intent);
        } catch (Exception ignored) { }
    }

    private void releasePlayer() {
        if (player != null) {
            player.release();
            player = null;
        }
        if (playerView != null) playerView.setPlayer(null);
    }
}
