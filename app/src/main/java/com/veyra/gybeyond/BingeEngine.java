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
import java.io.ByteArrayOutputStream;
import android.view.Gravity;
import android.view.TextureView;
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

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
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
    // 封面单独一条线：和 worker（详情 / 选集 / 地址解析）抢同一个单线程池时，
    // 封面会被排到详情请求后面，等它回来视频早就起来了 —— 海报等于没做。
    private final ExecutorService posterLoader = Executors.newSingleThreadExecutor();
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
    private boolean landscapeVideo;   // 当前视频是横屏：海报要一直垫底，不能撤
    private boolean frameReady;       // 首帧已经画出来：完整海报到此为止，不许再冒出来盖视频
    private boolean active;
    // 刷剧形态被「挂起」（切到别的 tab / 进详情 / 看全集）。挂起期间不恢复播放、不抢沉浸态，
    // 播放器与进度原样保留，resume() 回来就能接着播 —— 不用重新 loadShow，也就不会闪传统首页。
    private boolean suspended;

    // ---- 跟手拖拽（上下滑换剧）----
    private ImageView neighbor;          // 「下一部」的画面，拖拽时垫在视频层上面跟着手指走
    private boolean dragging;
    private int dragDirection;           // 0=未定 1=下一部 -1=上一部
    private float dragOffset;

    private TextureView texture;         // PlayerView 内部的 TextureView（surface_type=texture_view）

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
        /* 图层顺序（下 → 上）：海报底图 → 播放器 → 完整海报 → 拖拽用的下一部 → 错误提示。
           海报必须在播放器【下面】：它是「垫底」，不是「盖住」。盖在上面时，封面一到位就把
           已经在播的视频整块糊住（用户原话：海报怎么还叠到视频上面去了）。
           垫在下面的好处：横屏视频上下两条黑边由它填满，竖屏则被画面完全遮住，互不影响。

           播放器一直挂着、从不 GONE / INVISIBLE —— TextureView 一藏一显会重建 SurfaceTexture，
           表现就是「有声音、画面全白」。首帧没来之前由 posterFit 盖住那块黑。 */
        // 下一部（neighbor）是邻页，静止时整个躺在视频层边界之外。
        // FrameLayout 默认 clipChildren=true，会把它裁得一点不剩 ——
        // 拖拽时手指让开的那一条就只剩窗口底色（一片白），用户原话「下面全是白色的」。
        videoLayer.setClipChildren(false);

        poster = new ImageView(activity());
        poster.setScaleType(ImageView.ScaleType.CENTER_CROP);
        poster.setVisibility(View.GONE);
        poster.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        videoLayer.addView(poster);

        playerView = (PlayerView) activity().getLayoutInflater()
                .inflate(R.layout.episode_player, videoLayer, false);
        playerView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        // 快门默认可能是黑的，那样垫在下面的海报一点都透不出来
        try { playerView.setShutterBackgroundColor(Color.TRANSPARENT); } catch (Throwable ignored) { }
        videoLayer.addView(playerView);

        posterFit = new ImageView(activity());
        // CENTER_CROP 而不是 FIT_CENTER：邻页(neighbor)是铺满的，切过去的瞬间
        // 如果变成「居中小图 + 模糊底」，画面会明显跳一下。取景一致才是平滑过渡。
        // 模糊那张 poster 仍然垫在播放器下面，专门用来填横屏视频的上下黑边。
        posterFit.setScaleType(ImageView.ScaleType.CENTER_CROP);
        posterFit.setVisibility(View.GONE);
        posterFit.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        videoLayer.addView(posterFit);

        /* 换剧时「下一部」的画面：只在跟手拖拽过程中显示，承接手指并顶住换页的那一瞬间。
           它是【独立的一层】，与 videoLayer 平级（插在 videoLayer 与 webView 之间），
           不是 videoLayer 的子视图。

           为什么不能做子视图：子视图要偏移 ±屏高才能停在屏幕外，等于把内容画到父布局
           边界之外，只能靠 setClipChildren(false) 兜 —— 硬件加速下这条路各家实现不一致，
           实测就是一点都画不出来（用户：连半张都没了），也解释不了「有时有半张」。

           独立层自身就是全屏大小，只是整体平移，绘制内容永远在自己 bounds 内，
           由 root 裁到屏幕范围，不依赖任何 clip 开关，必定画得出来。
           位移因此也不再受父层带动：自己算 ±屏高 + 手指位移，天然 1:1。 */
        neighbor = new ImageView(activity());
        neighbor.setScaleType(ImageView.ScaleType.CENTER_CROP);
        // 封面是异步解的，没解出来之前它是透明的，露出来就是一片白。垫个黑底。
        neighbor.setBackgroundColor(0xFF000000);
        neighbor.setVisibility(View.GONE);
        FrameLayout.LayoutParams nlp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        ViewGroup host = (videoLayer.getParent() instanceof ViewGroup)
                ? (ViewGroup) videoLayer.getParent() : null;
        if (host != null) {
            int at = host.indexOfChild(videoLayer);
            host.addView(neighbor, at >= 0 ? at + 1 : host.getChildCount(), nlp);
        } else {
            videoLayer.addView(neighbor, nlp);   // 兜底：拿不到父布局就退回原来的位置
        }

        View surface = playerView.getVideoSurfaceView();
        if (surface instanceof TextureView) texture = (TextureView) surface;

        message = new TextView(activity());
        message.setTextColor(0xCCFFFFFF);
        message.setTextSize(13);
        message.setGravity(Gravity.CENTER);
        message.setPadding(dp(24), dp(12), dp(24), dp(12));
        message.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
        videoLayer.addView(message);

        // 兜底黑底：海报还没下载下来、播放器还没出首帧的那几百毫秒里，
        // 这一层是纯透明的 —— 底下没有东西，屏幕上就是一片白，用户骂的就是这个。
        // 铺一层黑，中间态是黑场而不是白场，视觉上就是「正常起播」。
        videoLayer.setBackgroundColor(0xFF000000);
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
            suspended = false;
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
        suspended = false;
        releasePlayer();
        videoLayer.setVisibility(View.GONE);
        showBars();
        activity().setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
    }

    public void onResume() {
        // 挂起期间（切到别的 tab / 在详情页 / 在看全集）不要自作主张恢复播放，也不要去抢沉浸态
        if (!active || suspended) return;
        hideBars();
        if (player != null) player.setPlayWhenReady(true);
        handler.post(tick);
    }

    /** 挂起：只暂停 + 存进度，播放器与当前剧原样保留（切 tab / 进详情 / 看全集都走这里）。*/
    public void pause() {
        suspended = true;
        if (player != null) {
            player.setPlayWhenReady(false);
            saveProgress(false);
        }
        handler.removeCallbacks(tick);
        // 切到别的 tab 时整层藏掉：原来只暂停播放，视频画面还挂在页面底下，
        // 从页面没盖住的地方（状态栏那一截）透出来，就是「画面顶到状态栏」。
        // 用 INVISIBLE 不用 GONE：GONE 会重建 TextureView 的 SurfaceTexture。
        videoLayer.setVisibility(View.INVISIBLE);
        // 邻页现在是与 videoLayer 平级的独立层，不会跟着父层藏，得自己收
        if (neighbor != null) { neighbor.animate().cancel(); neighbor.setVisibility(View.GONE); }
        // 必须把系统栏放回来：进刷剧时 hideBars() 隐藏了状态栏，WebView 的
        // safe-area-inset-top 随之变 0，切到底栏其它页时内容就顶到屏幕最上面去了
        // （用户截图：搜索框贴着顶边、状态栏整个没了）。
        showBars();
    }

    /** 从挂起恢复：同一个播放器接着播，不重新 loadShow（因此不会闪一下传统首页）。*/
    public void resume() {
        if (!active) { videoLayer.setVisibility(View.GONE); return; }
        suspended = false;
        videoLayer.setVisibility(View.VISIBLE);
        // 先 cancel 再归零：残留的位移动画会用最后一帧把视频层推回屏幕外
        videoLayer.animate().cancel();
        videoLayer.setTranslationY(0f);
        if (neighbor != null) { neighbor.animate().cancel(); neighbor.setVisibility(View.GONE); }
        // TextureView 被藏起来过，回来时补一次重绘，否则画面要等下一次布局才刷新
        if (texture != null) videoLayer.post(() -> texture.invalidate());
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
        posterLoader.shutdown();
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
        landscapeVideo = false;
        frameReady = false;
        detail = null;
        currentSource = null;
        message.setVisibility(View.GONE);
        // 播放器不动它（见 buildVideoLayer 注释），只把海报盖上去
        playerView.setAlpha(1f);
        playerView.setVisibility(View.VISIBLE);
        releasePlayer();
        poster.setVisibility(View.VISIBLE);
        // 不主动清空上一张：清了就是一次「有 -> 无 -> 有」的闪白。
        // 新封面到位才替换；新封面取不到时至少还是上一部的图，不是白板。
        posterFit.setVisibility(View.GONE);
        loadPoster(currentCover);
        prefetchNeighborCovers();   // 先把手边上一部/下一部的封面垫进缓存，滑动时才能秒出
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
                    if (state == Player.STATE_READY) {
                        message.setVisibility(View.GONE);
                        // READY 通常早于首帧，这里只催重绘；真要撤海报等 onVideoSizeChanged
                        // 拿到尺寸后再排（见下），否则就是「有声音、画面一片空白」。
                        forceRepaint();
                    }
                    else if (state == Player.STATE_ENDED) {
                        saveProgress(true);
                        onEpisodeEnded();
                    }
                }

                @Override public void onRenderedFirstFrame() {
                    if (destroyed || !active) return;
                    frameReady = true;
                    // TextureView 拿到首帧后不保证自己排一次重绘，表现就是「声音有了、画面还是黑的，
                    // 手指一动才刷出来」。这里显式催一次。
                    forceRepaint();
                    scheduleHidePoster();
                }

                @Override public void onVideoSizeChanged(VideoSize size) {
                    landscapeVideo = size.width > 0 && size.width > size.height;
                    playerView.setResizeMode(landscapeVideo
                            ? AspectRatioFrameLayout.RESIZE_MODE_FIT
                            : AspectRatioFrameLayout.RESIZE_MODE_ZOOM);
                    if (landscapeVideo) {
                        // 横屏视频上下是两条黑边，很秃 —— 海报垫底填满（用户明确要求）
                        Bitmap bmp;
                        synchronized (posterCache) { bmp = posterCache.get(currentCover); }
                        if (bmp != null) applyPosterMode(bmp, true, false);
                    }
                    forceRepaint();
                    // 拿到尺寸说明解码器真的出画了，这时才排撤海报
                    scheduleHidePoster(420);
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
            playerView.setAlpha(1f);
            playerView.setVisibility(View.VISIBLE);
            // 兜底：READY / onRenderedFirstFrame 在 TextureView 上不一定都到，
            // 到了也不保证真的画上去。表现就是「声音有了、画面一片空白，
            // 手指一动才刷出来」。这里按时间点补两次强制重绘 + 撤海报。
            final int token2 = loadToken;
            for (long delay : new long[]{300, 900, 1800}) {
                handler.postDelayed(() -> {
                    if (destroyed || !active || token2 != loadToken) return;
                    forceRepaint();
                    // 首帧回调在某些机型上不来，这里按「真的在播了」补判定：
                    // READY + 播放位置已经往前走了 = 画面肯定出过，可以撤掉盖在上面的海报。
                    if (!frameReady && player != null
                            && player.getPlaybackState() == Player.STATE_READY
                            && player.getCurrentPosition() > 0) {
                        frameReady = true;
                        hidePoster();
                    }
                }, delay);
            }
        } catch (Throwable error) {
            if (destroyed || !active) return;
            try { releasePlayer(); } catch (Exception ignored) { }
            cb.onShowFailed("播放启动失败: " + error.getMessage() + "\n上滑换一部");
        }
    }

    /** TextureView 拿不到可靠的首帧通知，这里一次性把该催的都催一遍。 */
    private void forceRepaint() {
        if (texture != null) texture.invalidate();
        playerView.invalidate();
        videoLayer.invalidate();
        videoLayer.postInvalidateOnAnimation();
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

    /* ---- 跟手拖拽：手指按住时画面就跟着走，松手才决定切不切 ----
     * 手指在 WebView 上，位移由 JS 逐帧同步过来（Bridge.bingeDrag）。
     * 规则（和红果一致）：
     *   · 慢滑：位移超过屏高 22% 才切
     *   · 快滑：速度超过 780 px/s（且位移超过 18dp）直接切，抬手就到位
     *   · 边界：位移打三折（阻尼），松手必定回弹
     * 拖拽期间把「下一部」的海报垫进来，看起来是真的翻了一页，而不是闪一下。 */

    public void dragStart() {
        if (!active || animating || suspended || pool == null) return;
        dragging = true;
        dragDirection = 0;
        dragOffset = 0f;
        videoLayer.animate().cancel();
        videoLayer.setTranslationY(0f);
        // 不暂停：PlayerActivity.handleGesture 拖拽时画面是照常在播的，跟着手指走。
        // 原来这里一按就停播，手指拖过去的那一屏是张静止画，看着像卡住。
        if (neighbor != null) {
            neighbor.animate().cancel();
            neighbor.setVisibility(View.GONE);
            neighbor.setTranslationY(0f);
        }
    }

    public void dragMove(float dy) {
        if (!dragging) return;
        int direction = dy < 0 ? 1 : -1;
        boolean blocked = !hasNeighbor(direction);
        // 照抄 PlayerActivity.handleGesture：位移 1:1 跟手，边界也不做阻尼
        // （原来给 0.26 阻尼，手指拽着画面不跟，手感就是「拖不动」）。
        // 边界只表现为「没有下一部可以接上来」，抬手照样回弹。
        float limit = Math.max(1f, videoLayer.getHeight());
        dragOffset = Math.max(-limit, Math.min(limit, dy));
        videoLayer.setTranslationY(dragOffset);
        if (blocked) {
            if (neighbor != null) neighbor.setVisibility(View.GONE);
            dragDirection = 0;
            return;
        }
        if (dragDirection != direction) {
            dragDirection = direction;
            loadNeighbor(direction);
        }
        if (neighbor != null) {
            float height = Math.max(1f, videoLayer.getHeight());
            /* 独立层：自己算「停在屏幕外 + 跟着手指进来」。
               videoLayer 平移 dragOffset，邻页平移 (±屏高 + dragOffset)，
               两者同步，露出的一条恰好等于手指让开的一条 —— 真 1:1，不多不少。 */
            neighbor.setTranslationY((direction > 0 ? height : -height) + dragOffset);
            if (neighbor.getVisibility() != View.VISIBLE) neighbor.setVisibility(View.VISIBLE);
        }
    }

    public void dragEnd(float dy, float velocity) {
        if (!dragging) return;
        dragging = false;
        float height = Math.max(1f, videoLayer.getHeight());
        int direction = dy < 0 ? 1 : -1;
        boolean blocked = !hasNeighbor(direction);
        float moved = Math.abs(dy);
        // 阈值照抄 PlayerActivity：Math.max(dp(76), height * 0.12f)。
        // 原来用 22%，要拖过五分之一屏才切，正常手一划根本够不着 —— 就是「滑不动」。
        // 阈值再放低一档：红果那种「轻轻一划就翻」的手感来自低阈值 + 速度优先。
        // 12%/76dp 是播放页切集的参数，刷剧是整屏翻页，手指行程本来就短，照搬偏重。
        boolean far = moved > Math.max(dp(64), height * 0.10f);
        boolean fling = Math.abs(velocity) > 600f && moved > dp(14);
        boolean commit = !blocked && (far || fling);

        if (!commit) {
            animating = true;
            videoLayer.animate().translationY(0f).setDuration(180).start();
            if (neighbor != null) {
                neighbor.animate()
                        .translationY(direction > 0 ? height : -height).setDuration(180)
                        .withEndAction(() -> { if (neighbor != null) neighbor.setVisibility(View.GONE); })
                        .start();
            }
            handler.postDelayed(() -> { animating = false; }, 180);
            return;
        }

        animating = true;
        final int target = index + direction;
        // 时长按「还剩多少距离」收：已经拖过去八成了还要走满 260ms，手感就是拖不动。
        final long duration = Math.max(140L, Math.min(260L,
                (long) (260f * Math.max(0.25f, 1f - moved / height))));
        videoLayer.animate().translationY(direction > 0 ? -height : height).setDuration(duration).start();
        // 独立层必须自己走：当前页滑出屏幕的同时，邻页滑到 0 补上 —— 两帧对齐，
        // 视觉上就是「下一页被手指推上来」，中间不会露底。
        if (neighbor != null) {
            neighbor.animate().translationY(0f).setDuration(duration).start();
        }
        handler.postDelayed(() -> {
            if (destroyed || !active) { animating = false; return; }
            if (player != null) player.setPlayWhenReady(false);
            index = target;
            loadShow();
            // 新一页就位：视频层立刻归零。
            // 必须先 cancel 掉「滑出」那个动画再手设位移 —— 不加 cancel 的话，滑出动画的
            // 最后一帧可能晚于这行执行，把视频层又推回 ±屏高之外：画面整个跑到屏幕外，
            // 声音照常播，手指一动（dragStart 里 cancel + setTranslationY(0)）才拉回来。
            // 用户说的「声音都出来了、手稍微动一下画面才出来」就是这个。
            videoLayer.animate().cancel();
            videoLayer.setTranslationY(0f);
            if (neighbor != null) {
                neighbor.animate().cancel();
                neighbor.setVisibility(View.GONE);
                neighbor.setTranslationY(0f);
            }
            animating = false;
        }, duration);
    }

    private boolean hasNeighbor(int direction) {
        if (pool == null) return false;
        int target = index + direction;
        return target >= 0 && target < pool.length();
    }

    /** 把手边上一部 / 下一部的封面提前解出来。拖拽时才去拉网络图，滑到一半是空白，切过去就闪。 */
    private void prefetchNeighborCovers() {
        if (pool == null) return;
        for (int delta = 1; delta >= -1; delta -= 2) {
            int i = index + delta;
            if (i < 0 || i >= pool.length()) continue;
            JSONObject item = pool.optJSONObject(i);
            if (item == null) continue;
            String cover = item.optString("cover");
            if (cover.isEmpty()) continue;
            synchronized (posterCache) { if (posterCache.get(cover) != null) continue; }
            posterLoader.execute(() -> decodeCover(cover));
        }
    }

    /** 解码一张封面进 posterCache。失败静默 —— 它只影响手感，不影响播放。 */
    private void decodeCover(String url) {
        try {
            synchronized (posterCache) { if (posterCache.get(url) != null) return; }
            String data = repository.coverData(url);
            if (data == null || data.isEmpty()) return;
            int comma = data.indexOf(',');
            if (comma < 0) return;
            byte[] bytes = Base64.decode(data.substring(comma + 1), Base64.DEFAULT);
            Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            if (bitmap == null || destroyed) return;
            synchronized (posterCache) { posterCache.put(url, bitmap); }
        } catch (Throwable ignored) { }
    }

    /** 预铺「下一部」的画面：优先用海报缓存，没有就现拉一张（只影响拖拽手感，失败不报错）。 */
    private void loadNeighbor(int direction) {
        if (neighbor == null || pool == null) return;
        JSONObject e = entry(index + direction);
        if (e == null) return;
        String cover = e.optString("cover");
        if (cover.isEmpty()) { neighbor.setImageDrawable(null); return; }
        Bitmap cached;
        synchronized (posterCache) { cached = posterCache.get(cover); }
        if (cached != null) { neighbor.setImageBitmap(cached); return; }
        neighbor.setImageDrawable(null);
        final String url = cover;
        // 走 posterLoader：和详情 / 选集解析分开排队，轮不到就一直排在后面
        posterLoader.execute(() -> {
            decodeCover(url);
            Bitmap bitmap;
            synchronized (posterCache) { bitmap = posterCache.get(url); }
            if (bitmap == null) return;
            final Bitmap ready = bitmap;
            handler.post(() -> {
                if (destroyed || neighbor == null) return;
                // 只有还停在这个方向上才贴图，避免快速来回划时贴错
                if (dragging && dragDirection == direction && dragOffset != 0f) neighbor.setImageBitmap(ready);
            });
        });
    }

    // ---------- 真玻璃底板（WebView 采样不到原生视频，模糊只能在这里做） ----------

;

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
        videoLayer.animate().translationY(direction > 0 ? -height : height).setDuration(260).start();
        // 换剧的下一步只是 UI 动作：不要排进 worker（worker 可能正被 loadShow/封面解码占着，
        // 一旦排队就会在滑出动画还没播完时突然跳帧），直接按动画时长在 UI 线程对齐。
        videoLayer.postDelayed(() -> {
            if (destroyed || !active) { animating = false; return; }
            index = target;
            loadShow();
            videoLayer.setTranslationY(direction > 0 ? height : -height);
            videoLayer.animate().translationY(0).setDuration(260)
                    .withEndAction(() -> animating = false).start();
        }, 260);
    }

    // ---------- 海报 / 模糊背景 ----------

    /** 撤掉盖在播放器上的海报，露出真正的画面。 */
    private void hidePoster() {
        // poster 现在是垫底的背景（在播放器下面），永远留着：横屏填黑边、竖屏被画面盖住。
        // 只撤压在播放器上面那张完整海报 posterFit。
        posterFit.setVisibility(View.GONE);
    }

    /** 撤海报：谁先到算谁（首帧 / 拿到尺寸），切剧后作废。 */
    private void scheduleHidePoster() { scheduleHidePoster(160); }

    private void scheduleHidePoster(long delay) {
        final int token = loadToken;
        handler.postDelayed(() -> {
            if (destroyed || !active || token != loadToken) return;
            hidePoster();
        }, delay);
    }

    private void loadPoster(String url) {
        if (url == null || url.isEmpty()) return;
        Bitmap cached;
        synchronized (posterCache) { cached = posterCache.get(url); }
        if (cached != null) { applyPosterMode(cached, false, true); return; }
        posterLoader.execute(() -> {
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
        poster.setVisibility(View.VISIBLE);
        boolean blur = forceBlur || bitmap.getWidth() >= bitmap.getHeight() * 0.85f;
        if (blur) {
            poster.setImageBitmap(gaussianBlur(bitmap, 12));
            poster.setAlpha(0.72f);
        } else {
            poster.setImageBitmap(bitmap);
            poster.setAlpha(1f);
        }
        // 关键：封面是异步到的，可能比首帧还晚。原来它一到就把 posterFit 重新点亮，
        // 于是「视频早就在播了，海报却盖在上面」—— 首帧之后一律不许再显示完整海报。
        if (showFit && !frameReady) {
            posterFit.setImageBitmap(bitmap);
            posterFit.setVisibility(View.VISIBLE);
        } else {
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
