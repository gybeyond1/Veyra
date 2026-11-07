package com.veyra.gybeyond;

import android.app.Activity;
import android.app.AlertDialog;
import android.animation.ValueAnimator;
import android.os.Build;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.animation.PathInterpolator;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;
import android.widget.FrameLayout;
import android.widget.GridLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.TextView;

import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.C;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.SeekParameters;
import androidx.media3.ui.PlayerView;
import androidx.media3.ui.AspectRatioFrameLayout;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Set;
import java.util.concurrent.Future;
import android.view.TextureView;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
public final class PlayerActivity extends Activity {
    private static final int YELLOW = Color.rgb(255, 212, 91);
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newFixedThreadPool(3);
    private final Map<String, JSONObject> episodeCache = new LinkedHashMap<String, JSONObject>() {
        @Override protected boolean removeEldestEntry(Map.Entry<String, JSONObject> eldest) { return size() > 32; }
    };
    /* 预取/预热各用独立线程池：单线程时只要有一集取流卡住（接口超时 20s），
       后面所有预取都排在它后面，表现就是「这几集怎么切都转圈」 */
    private final ExecutorService prefetchWorker = Executors.newFixedThreadPool(2);
    private final ExecutorService warmWorker = Executors.newFixedThreadPool(2);
    private final Set<String> warming = Collections.synchronizedSet(new HashSet<String>());
    private Future<?> sourceTask;
    private Future<?> sequelTask;
    private final Map<String, JSONArray> sequelCache = new HashMap<>();
    private JSONArray sequelCandidates = new JSONArray();
    private LinearLayout sequelOverlay;
    private boolean seasonEnded;
    private boolean openingSequel;
    private Future<?> prefetchTask;
    private int prefetchToken;
    private boolean foreground;
    private boolean destroyed;
    private boolean activeFirstFrame;
    private boolean switching;
    /** 上一集自然播完，这次切集是「连播」——不要加载圈、不要骨架屏 */
    private boolean seamlessNext;
    /** 无缝连播后的一小段缓冲期：这期间即使 STATE_BUFFERING 也不弹加载圈 */
    private long suppressLoadingUntil;
    /**
     * 复用预取播放器的看门狗。
     *
     * 预取的播放器（standby）在后台已经 prepare 到 READY，切集时直接提升为主播放器，
     * 省掉重建解码器的时间。但电视盒子上复用一个「一直是暂停状态」的播放器时，
     * 提升后偶尔不输出首帧，界面就永远停在加载中 —— 切回上一集再切回来（走重建
     * 路径）又好了，正是这个原因。这里放一个 2.5 秒的兜底：到点还没出首帧，
     * 立刻退回「重建播放器 + 已解析好的地址」，保证不会一直转圈。
     */
    private ExoPlayer reuseGuardPlayer;
    private final Runnable reuseGuard = new Runnable() {
        @Override public void run() {
            ExoPlayer guarded = reuseGuardPlayer;
            reuseGuardPlayer = null;
            if (guarded == null || destroyed || isFinishing()) return;
            if (guarded != player || activeFirstFrame) return;
            Log.w("HuangGuoPlayback", "reuse-timeout " + cacheKey(currentId, currentEpisode)
                    + " state=" + guarded.getPlaybackState());
            rebuildCurrentEpisode();
        }
    };
    private long switchStartedAt;
    private int incomingDirection;
    private ExoPlayer standbyPlayer;
    private EpisodeLoadControl standbyLoadControl;
    private String standbyKey;
    private String standbySource;
    private String failedStandbyKey;
    private long failedStandbyAt;
    private long standbyPreparedAt;
    private boolean standbyFirstFrame;
    /** 「从头播放」：只在本次起播的第一集生效，用来跳过 resumePosition */
    private boolean restartPending;
    /** 手机投屏带过来的起播位置：只在第一集生效，之后照常按本地进度续播 */
    private boolean startPositionPending;
    private long startPosition;
    private PlayerView activeView;
    private PlayerView standbyView;
    private final Map<String, Bitmap> posterCache = new HashMap<>();
    private DualContentRepository repository;
    private AppStore store;
    private ExoPlayer player;
    private ExoPlayer previewPlayer;
    private FrameLayout root;
    private FrameLayout mediaLayer;
    private ShimmerView skeleton;
    private ImageView poster;
    private ImageView incoming;
    private ProgressBar loading;
    private TextView title;
    private TextView episodeText;
    private TextView timeText;
    private TextView message;
    private ImageButton playButton;
    private ImageButton centerToggle;
    private SeekBar seekBar;
    private SeekBar landscapeSeek;
    private SeekBar volumeSeek;
    private LinearLayout previewBubble;
    private PlayerView previewView;
    private ProgressBar previewLoading;
    private TextView previewTime;
    private TextView previewHint;
    private ImageButton volumeButton;
    private ImageButton fullscreenButton;
    private ImageButton bookmarkButton;
    private ImageButton castButton;
    private LinearLayout titleBar;
    private LinearLayout controls;
    private FrameLayout miniProgress;
    private View miniProgressFill;
    private float miniProgressFraction;
    private boolean controlsShown = true;
    private int controlTransitionToken;
    private LinearLayout episodePanel;
    private View episodeScrim;
    private TextView episodeTrigger;
    private TextView speedTrigger;
    /* ---- 电视端：暂停后的控件条 / 分组选集面板（遥控器专用，手机端不创建） ---- */
    private LinearLayout tvBar;
    private final java.util.List<TextView> tvBarItems = new java.util.ArrayList<>();
    private int tvBarIndex;
    private boolean tvBarShown;
    private LinearLayout tvEpPanel;
    private final java.util.List<TextView> tvEpGroups = new java.util.ArrayList<>();
    private final java.util.List<TextView> tvEpCells = new java.util.ArrayList<>();
    private int tvEpFocusArea;   /* 0 = 分组条，1 = 集数网格 */
    private int tvEpIndex;
    private int tvEpGroup;
    private int tvEpPageCount;      /* 当前分组实际有几集（最后一组可能不满 20） */
    private TextView tvEpSub;
    private android.widget.GridLayout tvEpGrid;
    private static final int TV_EP_PAGE = 20;
    private View speedScrim;
    private LinearLayout speedPanel;
    private JSONArray queue;
    private JSONArray episodes;
    private JSONObject currentItem;
    private String group;
    private String currentId;
    private int currentEpisode;
    private int queueIndex;
    private int loadToken;
    private long lastSaved;
    private boolean seeking;
    private String currentSource;
    private String currentMime = MimeTypes.APPLICATION_M3U8;
    private String standbyMime = MimeTypes.APPLICATION_M3U8;
    private long previewTarget;
    private long previewBucket = -1;
    private long lastPreviewRequest;
    private boolean previewSeekScheduled;
    private final Runnable previewSeek = () -> {
        previewSeekScheduled = false;
        if (!seeking || currentSource == null || player == null || player.getDuration() <= 0) return;
        long bucket = Math.min(player.getDuration(), (previewTarget / 5000) * 5000);
        if (bucket == previewBucket) return;
        previewBucket = bucket;
        lastPreviewRequest = SystemClock.uptimeMillis();
        if (previewPlayer == null) ensurePreviewPlayer();
        else {
            // 切过通道模式后按当前模式重建数据源与预览项，保证预览走当前通道
            MediaItem previewItem = new MediaItem.Builder().setUri(currentSource).setMimeType(currentMime).build();
            previewPlayer.setMediaSource(VideoPlaybackCache.sources(this).createMediaSource(previewItem));
            previewPlayer.pause();
            previewPlayer.seekTo(bucket);
            previewPlayer.prepare();
        }
    };
    private static final int GESTURE_PENDING = 0;
    private static final int GESTURE_VERTICAL = 1;
    private static final int GESTURE_HORIZONTAL = 2;
    private static final int GESTURE_HOLD = 3;
    private static final float[] SPEEDS = {0.5f, 0.75f, 1f, 1.25f, 2f, 3f};
    private float manualSpeed = 1f;
    private boolean speedLocked;
    private boolean speedHoldActive;
    private boolean holdToggled;
    private int gestureMode = GESTURE_PENDING;
    private float touchStartX;
    private float touchStartY;
    private float dragY;
    private boolean dragging;
    private boolean doubleTapCandidate;
    private long gestureSeekStart;
    private long gestureSeekTarget;
    private long lastTapAt;
    private float lastTapX;
    private float lastTapY;
    private final Runnable singleTap = () -> {
        if (controlsShown) concealControls();
        else revealControls();
    };
    private final Runnable longPress = () -> {
        if (!dragging || gestureMode != GESTURE_PENDING) return;
        gestureMode = GESTURE_HOLD;
        lastTapAt = 0;
        holdToggled = false;
        if (player == null || !player.isPlaying()) return;
        if (!speedLocked) {
            speedHoldActive = true;
            applyPlaybackSpeed(2f);
        }
        revealControls();
    };
    private boolean episodesOpen;
    private int sourceRetryCount;
    private boolean fullscreenMode;
    private boolean videoLandscape;
    private int navigationInsetBottom;
    private OnBackInvokedCallback backCallback;

    /* ---- 电视端：没有触摸、没有焦点导航，只有遥控器按键和一个常显的进度条 ---- */
    private boolean tvMode;
    private boolean tvInfoShown;
    /* 控件条唤出时右上角常驻的「当前 / 总长」，控件条收起就一起消失。
       以前是用 toast 在顶部弹一下，左右快进每按一次弹一次，很吵。 */
    private TextView tvClock;
    private android.app.Dialog exitDialog;
    private final Runnable hideTvInfo = () -> {
        if (!tvInfoShown) return;
        tvInfoShown = false;
        updateTitleVisibility();
    };

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (player != null && player.getDuration() > 0) {
                long position = player.getCurrentPosition();
                long duration = player.getDuration();
                if (!seeking) seekBar.setProgress((int) Math.min(1000, position * 1000 / duration));
                if (!seeking && landscapeSeek != null) landscapeSeek.setProgress((int) Math.min(1000, position * 1000 / duration));
                updateMiniProgress(position, duration);
                timeText.setText(clock(position) + " / " + clock(duration));
                if (tvClock != null && tvClock.getVisibility() == View.VISIBLE) {
                    tvClock.setText(clock(position) + " / " + clock(duration));
                }
                if (System.currentTimeMillis() - lastSaved > 5000) saveProgress(false);
                maybePrepareNext();
            }
            handler.postDelayed(this, 500);
        }
    };

    private static final class Selection {
        final JSONObject item;
        final int index;
        final int episode;
        Selection(JSONObject item, int index, int episode) {
            this.item = item; this.index = index; this.episode = episode;
        }
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        tvMode = DeviceProfile.isTv(this);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= 29) getWindow().setNavigationBarContrastEnforced(false);
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        // 不再一进来就锁竖屏：平板横着用的时候，播放页跟着横过来，别又缩成一列
        updateSystemBars();
        if (Build.VERSION.SDK_INT >= 33) {
            backCallback = this::handlePlayerBack;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCallback);
        }
        repository = new DualContentRepository(this);
        store = new AppStore(this);
        try {
            JSONObject payload = new JSONObject(getIntent().getStringExtra("payload"));
            ContentMode.get(this).require(payload.optString("source", ContentMode.get(this).active()));
            currentItem = payload.optJSONObject("item");
            if (currentItem == null) throw new IllegalArgumentException("没有影片信息");
            group = payload.optString("group");
            queue = payload.optJSONArray("queue");
            if (queue == null) queue = new JSONArray();
            episodes = payload.optJSONArray("episodes");
            if (episodes == null && payload.optJSONObject("detail") != null) {
                episodes = payload.optJSONObject("detail").optJSONArray("episodes");
            }
            if (episodes == null) episodes = new JSONArray();
            queueIndex = payload.optInt("index", 0);
            currentId = currentItem.optString("id");
            currentEpisode = payload.optInt("episode", 1);
            restartPending = payload.optBoolean("restart", false);
            startPosition = Math.max(0, payload.optLong("position", 0));
            startPositionPending = startPosition > 0;
        } catch (Exception error) { finish(); return; }

        buildUi();
        player = createEpisodePlayer(false);
        activeView.setPlayer(player);
        loadSelection();
        handler.post(tick);
    }

    private ExoPlayer createEpisodePlayer(boolean standby) {
        EpisodeLoadControl control = new EpisodeLoadControl(standby);
        ExoPlayer engine = new ExoPlayer.Builder(this).setLoadControl(control)
                .setMediaSourceFactory(VideoPlaybackCache.sources(this)).build();
        if (standby) standbyLoadControl = control;
        engine.addListener(new Player.Listener() {
            @Override public void onPlaybackStateChanged(int state) {
                if (engine != player || currentSource == null || destroyed) return;
                if (state == Player.STATE_READY) {
                    if (seasonEnded) { seasonEnded=false; hideSequelEnd(); }
                    if (activeFirstFrame) loading.setVisibility(View.GONE);
                    message.setVisibility(View.GONE);
                    maybePrepareNext();
                } else if (state == Player.STATE_BUFFERING) {
                    /* 连播那一下会短暂 BUFFERING，此时弹加载圈等于每集闪一次 */
                    if (SystemClock.elapsedRealtime() > suppressLoadingUntil) {
                        loading.setVisibility(View.VISIBLE);
                    }
                    // 这里原来会 cancelPrefetch()：主播放器稍一卡顿，刚预取好的下一集就被丢掉，
                    // 切集时只能从头重新拉，表现就是「切下一集要等很久」。standby 自己有
                    // 5s / 4MB 的上限，不会无限抢带宽，留着它更划算。
                } else if (state == Player.STATE_ENDED) {
                    saveProgress(true);
                    if (!isAiQueue()) {
                        Selection next = adjacent(1);
                        /* 下一集已经预取好了，直接接上：不弹加载、不显示海报 */
                        if (next != null) { seamlessNext = true; switchTo(next); }
                        else if (isHongguoFinalEpisode()) { seasonEnded = true; showSequelEnd(false); }
                    }
                }
            }
            @Override public void onRenderedFirstFrame() {
                if (destroyed) return;
                if (engine == standbyPlayer) { standbyFirstFrame = true; return; }
                if (engine != player || currentSource == null) return;
                activeFirstFrame = true;
                disarmReuseGuard();
                showActiveFrame();
                /* 首帧一到就先问一次预取：电视端看短剧基本不会等满 5 秒缓冲，
                   只在 tick 里碰运气的话常常整集都没预取到下一集。 */
                maybePrepareNext();
                scheduleWarmNeighbors();
                Log.d("HuangGuoPlayback", "first-frame " + cacheKey(currentId, currentEpisode)
                        + " after " + (SystemClock.elapsedRealtime() - switchStartedAt) + "ms");
            }
            @Override public void onIsPlayingChanged(boolean playing) {
                if (engine != player || destroyed) return;
                if (playing) disarmReuseGuard();
                playButton.setImageResource(playing ? R.drawable.player_pause : R.drawable.player_play);
                centerToggle.setImageResource(playing ? R.drawable.player_pause : R.drawable.player_play);
                if (tvMode) {
                    /* 只在真正开播时收控件条。暂停不在这里弹：自动切下一集时
                       loadSelection() 内部会 player.pause()，从这儿弹就是每集结束
                       闪一次控件条；用户按暂停键走 tvTogglePlay，那里已经显式弹了。 */
                    if (playing || player.getPlayWhenReady()) hideTvBar();
                } else {
                    revealControls();
                }
            }
            @Override public void onVideoSizeChanged(androidx.media3.common.VideoSize size) {
                if (engine == standbyPlayer) resizeVideo(standbyView, size);
                if (engine == player) updateVideoGeometry(size);
            }
            @Override public void onPlayerError(PlaybackException error) {
                if (engine == standbyPlayer) {
                    failedStandbyKey = standbyKey;
                    failedStandbyAt = SystemClock.elapsedRealtime();
                    releaseStandby();
                    Log.w("HuangGuoPlayback", "Next episode preparation failed", error);
                    return;
                }
                if (engine != player || currentSource == null || destroyed) return;
                synchronized (episodeCache) { episodeCache.remove(cacheKey(currentId, currentEpisode)); }
                cancelPrefetch();
                if (hasTimeout(error) && sourceRetryCount < 2) {
                    int attempt = ++sourceRetryCount;
                    int token = loadToken;
                    long position = engine.getCurrentPosition();
                    loading.setVisibility(View.VISIBLE);
                    message.setVisibility(View.GONE);
                    handler.postDelayed(() -> {
                        if (token != loadToken || engine != player || destroyed || isFinishing()) return;
                        engine.prepare();
                        engine.seekTo(position);
                        engine.setPlayWhenReady(foreground);
                    }, 700L * attempt);
                    return;
                }
                loading.setVisibility(View.GONE);
                message.setText("播放失败，点击重试");
                message.setVisibility(View.VISIBLE);
                message.setOnClickListener(view -> loadSelection());
                Log.e("HuangGuo", "Player error", error);
            }
        });
        return engine;
    }

    private void resizeVideo(PlayerView view, androidx.media3.common.VideoSize size) {
        // 统一 FIT：竖屏短剧视频完整显示、保持原始比例，不做 ZOOM 裁剪。
        // 此前竖屏视频（宽/高 < 0.9）走 ZOOM 会放大铺满 view，左右/上下溢出部分被裁掉，丢画面。
        view.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT);
    }

    private void updateVideoGeometry(androidx.media3.common.VideoSize size) {
        resizeVideo(activeView, size);
        if (size.width > 0 && size.height > 0) {
            videoLandscape = (double) size.width * size.pixelWidthHeightRatio >= size.height;
            if (fullscreenMode) applyFullscreenOrientation();
        }
    }

    private void showActiveFrame() {
        poster.setVisibility(View.GONE);
        skeleton.setVisibility(View.GONE);
        loading.setVisibility(View.GONE);
        sourceRetryCount = 0;
    }

    private int dp(float value) { return (int) (value * getResources().getDisplayMetrics().density + 0.5f); }

    private void updateSystemBars() {
        int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
        if (fullscreenMode && Build.VERSION.SDK_INT < 30) flags |= View.SYSTEM_UI_FLAG_FULLSCREEN;
        getWindow().getDecorView().setSystemUiVisibility(flags);
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.setSystemBarsAppearance(0,
                        WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS |
                                WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
                controller.show(WindowInsets.Type.navigationBars());
                if (fullscreenMode) controller.hide(WindowInsets.Type.statusBars());
                else controller.show(WindowInsets.Type.statusBars());
            }
        }
    }

    private void applyFullscreenOrientation() {
        // 只有「全屏 + 横版视频」才明确要横屏；退出全屏就交还给系统，
        // 平板本来横着用，不该被这一下翻回竖屏
        int target = fullscreenMode && videoLandscape ? ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
                : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
        if (getRequestedOrientation() != target) setRequestedOrientation(target);
    }

    private void setFullscreenMode(boolean enabled) {
        if (fullscreenMode == enabled) return;
        fullscreenMode = enabled;
        fullscreenButton.setImageResource(enabled ? R.drawable.player_shrink : R.drawable.player_fullscreen);
        fullscreenButton.setContentDescription(enabled ? "退出全屏" : "全屏");
        updateSystemBars();
        applyFullscreenOrientation();
        root.requestApplyInsets();
        revealControls();
    }

    private boolean isLandscapeFullscreen() {
        return fullscreenMode && getResources().getConfiguration().orientation == Configuration.ORIENTATION_LANDSCAPE;
    }

    private int collapsedProgressBottomMargin(int navigationInset) {
        float remainingGap = isLandscapeFullscreen() ? 0.30f : 0.50f;
        return Math.max(dp(1), Math.round((navigationInset + dp(7)) * remainingGap));
    }

    private boolean edgeGestureStart(float y) {
        int top = dp(64);
        int bottom = dp(88);
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsets insets = root.getRootWindowInsets();
            if (insets != null) {
                android.graphics.Insets gestures = insets.getInsets(WindowInsets.Type.systemGestures());
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                top = Math.max(top, Math.max(gestures.top, bars.top) + dp(24));
                bottom = Math.max(bottom, Math.max(gestures.bottom, bars.bottom) + dp(24));
            }
        }
        return y < top || y > root.getHeight() - bottom;
    }

    private GradientDrawable background(int color, int radius) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(radius));
        return drawable;
    }

    private TextView label(String value, int size, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setGravity(Gravity.CENTER_VERTICAL);
        return view;
    }

    private ImageButton icon(int resource, String description) {
        ImageButton button = new ImageButton(this);
        button.setImageResource(resource);
        button.setColorFilter(Color.WHITE);
        button.setContentDescription(description);
        button.setBackground(background(0x7A000000, 18));
        button.setPadding(dp(8), dp(8), dp(8), dp(8));
        return button;
    }

    private void buildUi() {
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        setContentView(root);
        mediaLayer = new FrameLayout(this);
        activeView = (PlayerView) getLayoutInflater().inflate(R.layout.episode_player, mediaLayer, false);
        standbyView = (PlayerView) getLayoutInflater().inflate(R.layout.episode_player, mediaLayer, false);
        standbyView.setAlpha(0f);
        mediaLayer.addView(activeView);
        mediaLayer.addView(standbyView);
        skeleton = new ShimmerView(this);
        mediaLayer.addView(skeleton, new FrameLayout.LayoutParams(-1, -1));
        poster = new ImageView(this);
        poster.setScaleType(ImageView.ScaleType.CENTER_CROP);
        poster.setVisibility(View.INVISIBLE);
        mediaLayer.addView(poster, new FrameLayout.LayoutParams(-1, -1));
        root.addView(mediaLayer, new FrameLayout.LayoutParams(-1, -1));
        incoming = new ImageView(this);
        incoming.setScaleType(ImageView.ScaleType.CENTER_CROP);
        incoming.setBackgroundColor(0xFF242321);
        incoming.setVisibility(View.GONE);
        root.addView(incoming, new FrameLayout.LayoutParams(-1, -1));

        View gesture = new View(this);
        root.addView(gesture, new FrameLayout.LayoutParams(-1, -1));
        gesture.setOnTouchListener((target, event) -> handleGesture(event));

        LinearLayout top = new LinearLayout(this);
        titleBar = top;
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.setPadding(dp(4), dp(12), dp(16), dp(10));
        // 电视端的返回靠遥控器返回键，标题栏里那颗按钮既用不上、又会被焦点框选中
        if (!tvMode) {
            ImageButton back = icon(R.drawable.player_back, "返回详情");
            back.setOnClickListener(v -> handlePlayerBack());
            top.addView(back, new LinearLayout.LayoutParams(dp(38), dp(38)));
        }
        title = label("", 16, Color.WHITE);
        title.setTypeface(null, Typeface.BOLD);
        title.setSingleLine(true);
        title.setEllipsize(android.text.TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(0, dp(42), 1);
        titleParams.leftMargin = dp(12);
        top.addView(title, titleParams);
        if (tvMode) {
            /* 标题靠左占满，时间贴右边。只在控件条唤出期间可见 */
            tvClock = label("", 14, 0xFFD5D0CD);
            tvClock.setGravity(Gravity.CENTER_VERTICAL);
            tvClock.setIncludeFontPadding(false);
            tvClock.setVisibility(View.GONE);
            LinearLayout.LayoutParams clockParams = new LinearLayout.LayoutParams(-2, -2);
            clockParams.leftMargin = dp(16);
            top.addView(tvClock, clockParams);
        }
        FrameLayout.LayoutParams topParams = new FrameLayout.LayoutParams(-1, dp(70), Gravity.TOP);
        topParams.topMargin = dp(24);
        root.addView(top, topParams);

        loading = new ProgressBar(this);
        loading.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(YELLOW));
        root.addView(loading, new FrameLayout.LayoutParams(dp(44), dp(44), Gravity.CENTER));
        centerToggle = icon(R.drawable.player_play, "播放或暂停");
        /* 电视端暂停时的中心提示：半透明圆底 + 白色三角，不抢画面，
           但一眼能看出「现在是停着的」。手机端仍是原来的小圆钮。 */
        GradientDrawable centerBackground = background(tvMode ? 0x59101114 : 0xA8101114, 34);
        centerBackground.setStroke(dp(1), tvMode ? 0x40FFFFFF : 0x99FFFFFF);
        centerToggle.setBackground(centerBackground);
        centerToggle.setPadding(dp(tvMode ? 26 : 8), dp(tvMode ? 26 : 8),
                dp(tvMode ? 26 : 8), dp(tvMode ? 26 : 8));
        centerToggle.setElevation(dp(10));
        centerToggle.setVisibility(View.GONE);
        centerToggle.setOnClickListener(buttonView -> {
            if (player != null) player.setPlayWhenReady(!player.getPlayWhenReady());
            revealControls();
        });
        int centerSize = tvMode ? 116 : 62;
        root.addView(centerToggle, new FrameLayout.LayoutParams(dp(centerSize), dp(centerSize), Gravity.CENTER));
        message = label("", 14, Color.WHITE);
        message.setGravity(Gravity.CENTER);
        message.setBackground(background(0xCC16191B, 10));
        message.setPadding(dp(16), dp(10), dp(16), dp(10));
        message.setVisibility(View.GONE);
        root.addView(message, new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER));

        controls = new LinearLayout(this);
        controls.setOrientation(LinearLayout.VERTICAL);
        controls.setGravity(Gravity.CENTER_HORIZONTAL);
        controls.setPadding(dp(15), dp(38), dp(15), dp(16));
        controls.setBackground(new GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP,
                new int[]{0xDD000000, 0x00000000}));
        episodeText = label("", 13, 0xFFFFD45B);
        episodeText.setVisibility(View.GONE);
        LinearLayout timeline = new LinearLayout(this);
        timeline.setGravity(Gravity.CENTER_VERTICAL);
        seekBar = new SeekBar(this);
        seekBar.setMax(1000);
        seekBar.setProgressTintList(android.content.res.ColorStateList.valueOf(YELLOW));
        seekBar.setThumbTintList(android.content.res.ColorStateList.valueOf(YELLOW));
        seekBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onStartTrackingTouch(SeekBar bar) { startSeekPreview(bar); }
            @Override public void onStopTrackingTouch(SeekBar bar) { finishSeekPreview(bar); }
            @Override public void onProgressChanged(SeekBar bar, int progress, boolean fromUser) {
                if (fromUser && seeking) updateSeekPreview(bar, progress);
            }
        });
        timeline.addView(seekBar, new LinearLayout.LayoutParams(-1, dp(34)));
        timeText = label("0:00 / 0:00", 11, Color.WHITE);
        controls.addView(timeline, new LinearLayout.LayoutParams(-1, dp(37)));
        LinearLayout buttons = new LinearLayout(this);
        buttons.setGravity(Gravity.CENTER_VERTICAL);
        buttons.setPadding(dp(7), 0, dp(7), 0);
        GradientDrawable remote = background(0xF2292720, 12);
        remote.setStroke(dp(1), 0xFF796D53);
        buttons.setBackground(remote);
        buttons.setElevation(dp(12));
        playButton = icon(R.drawable.player_play, "播放或暂停");
        playButton.setBackgroundColor(Color.TRANSPARENT);
        playButton.setOnClickListener(v -> { if (player != null) player.setPlayWhenReady(!player.getPlayWhenReady()); revealControls(); });
        buttons.addView(playButton, new LinearLayout.LayoutParams(dp(38), dp(38)));
        ImageButton next = icon(R.drawable.player_next, "下一集");
        next.setBackgroundColor(Color.TRANSPARENT);
        next.setOnClickListener(v -> { Selection item = adjacent(1); if (item != null) animateSwitch(item, 1); else toast("已经是最后一集"); });
        LinearLayout.LayoutParams nextParams = new LinearLayout.LayoutParams(dp(38), dp(38));
        nextParams.leftMargin = dp(3);
        buttons.addView(next, nextParams);
        LinearLayout.LayoutParams timeParams = new LinearLayout.LayoutParams(dp(77), dp(38));
        timeParams.leftMargin = dp(4);
        timeText.setTextSize(10);
        timeText.setGravity(Gravity.CENTER);
        buttons.addView(timeText, timeParams);
        landscapeSeek = new SeekBar(this);
        landscapeSeek.setMax(1000);
        landscapeSeek.setProgressTintList(android.content.res.ColorStateList.valueOf(YELLOW));
        landscapeSeek.setThumbTintList(android.content.res.ColorStateList.valueOf(YELLOW));
        landscapeSeek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onStartTrackingTouch(SeekBar bar) { startSeekPreview(bar); }
            @Override public void onStopTrackingTouch(SeekBar bar) { finishSeekPreview(bar); }
            @Override public void onProgressChanged(SeekBar bar, int progress, boolean fromUser) {
                if (fromUser && seeking) updateSeekPreview(bar, progress);
            }
        });
        buttons.addView(landscapeSeek, new LinearLayout.LayoutParams(dp(90), dp(38)));
        volumeButton = icon(R.drawable.player_volume, "静音");
        volumeButton.setBackgroundColor(Color.TRANSPARENT);
        volumeButton.setOnClickListener(v -> {
            if (player == null) return;
            boolean mute = player.getVolume() > 0;
            player.setVolume(mute ? 0 : Math.max(.2f, volumeSeek.getProgress() / 100f));
            volumeButton.setImageResource(mute ? R.drawable.player_mute : R.drawable.player_volume);
        });
        buttons.addView(volumeButton, new LinearLayout.LayoutParams(dp(34), dp(38)));
        volumeSeek = new SeekBar(this);
        volumeSeek.setMax(100);
        volumeSeek.setProgress(100);
        volumeSeek.setProgressTintList(android.content.res.ColorStateList.valueOf(YELLOW));
        volumeSeek.setThumbTintList(android.content.res.ColorStateList.valueOf(YELLOW));
        volumeSeek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar bar, int progress, boolean fromUser) {
                if (fromUser && player != null) {
                    player.setVolume(progress / 100f);
                    volumeButton.setImageResource(progress == 0 ? R.drawable.player_mute : R.drawable.player_volume);
                }
            }
            @Override public void onStartTrackingTouch(SeekBar bar) { revealControls(); }
            @Override public void onStopTrackingTouch(SeekBar bar) { revealControls(); }
        });
        buttons.addView(volumeSeek, new LinearLayout.LayoutParams(dp(68), dp(38)));
        castButton = icon(R.drawable.player_cast, "投到电视");
        castButton.setBackgroundColor(Color.TRANSPARENT);
        castButton.setOnClickListener(v -> { showCastDevices(); revealControls(); });
        buttons.addView(castButton, new LinearLayout.LayoutParams(dp(36), dp(38)));
        fullscreenButton = icon(R.drawable.player_fullscreen, "全屏");
        fullscreenButton.setBackgroundColor(Color.TRANSPARENT);
        fullscreenButton.setOnClickListener(v -> setFullscreenMode(!fullscreenMode));
        buttons.addView(fullscreenButton, new LinearLayout.LayoutParams(dp(36), dp(38)));
        speedTrigger = label("1×", 12, 0xFFF5D782);
        speedTrigger.setGravity(Gravity.CENTER);
        speedTrigger.setBackgroundColor(Color.TRANSPARENT);
        speedTrigger.setContentDescription("播放倍速");
        speedTrigger.setOnClickListener(v -> showSpeedPanel());
        buttons.addView(speedTrigger, new LinearLayout.LayoutParams(dp(46), dp(38)));
        episodeTrigger = label("选集", 13, 0xFFF5D782);
        episodeTrigger.setGravity(Gravity.CENTER);
        episodeTrigger.setBackgroundColor(Color.TRANSPARENT);
        episodeTrigger.setOnClickListener(v -> showEpisodes());
        buttons.addView(episodeTrigger, new LinearLayout.LayoutParams(dp(49), dp(38)));
        bookmarkButton = icon(R.drawable.player_bookmark, "收藏作品");
        bookmarkButton.setBackgroundColor(Color.TRANSPARENT);
        bookmarkButton.setOnClickListener(v -> {
            if (currentItem == null) return;
            try {
                boolean saved = store.toggleBookmark(currentItem);
                updateBookmarkButton();
                toast(saved ? "已加入收藏" : "已取消收藏");
                AccountService cloud = new AccountService(getApplicationContext(), store);
                if (cloud.isLoggedIn()) worker.execute(() -> {
                    try { cloud.sync(); }
                    catch (Exception error) { Log.w("HongGuo", "收藏稍后同步", error); }
                });
            } catch (Exception error) { toast("收藏未保存，请重试"); }
            revealControls();
        });
        buttons.addView(bookmarkButton, new LinearLayout.LayoutParams(dp(36), dp(38)));
        controls.addView(buttons, new LinearLayout.LayoutParams(-2, dp(52)));
        root.addView(controls, new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM));
        // 电视端整条控件栏都不要：遥控器上左右是拖进度、确定是暂停，没有用鼠标去点按钮的场景
        if (tvMode) controls.setVisibility(View.GONE);
        buildSeekPreview();
        miniProgress = new FrameLayout(this);
        miniProgress.setVisibility(View.GONE);
        miniProgressFill = new View(this);
        miniProgressFill.setBackgroundColor(YELLOW);
        miniProgress.addView(miniProgressFill, new FrameLayout.LayoutParams(0, -1, Gravity.LEFT));
        // 电视端这条黄条是常显的（也是唯一保留的进度反馈），做粗一点、通栏
        FrameLayout.LayoutParams miniParams = new FrameLayout.LayoutParams(-1, dp(tvMode ? 5 : 3), Gravity.BOTTOM);
        miniParams.leftMargin = dp(tvMode ? 0 : 5);
        miniParams.rightMargin = dp(tvMode ? 0 : 5);
        miniParams.bottomMargin = collapsedProgressBottomMargin(0);
        root.addView(miniProgress, miniParams);
        root.setOnApplyWindowInsetsListener((viewRoot, insets) -> {
            int topInset = Build.VERSION.SDK_INT >= 30
                    ? insets.getInsets(WindowInsets.Type.statusBars()).top : insets.getSystemWindowInsetTop();
            int bottomInset = Build.VERSION.SDK_INT >= 30
                    ? insets.getInsets(WindowInsets.Type.navigationBars()).bottom : insets.getSystemWindowInsetBottom();
            navigationInsetBottom = bottomInset;
            FrameLayout.LayoutParams titleLayout = (FrameLayout.LayoutParams) top.getLayoutParams();
            int titleMargin = Math.max(dp(24), topInset + dp(8));
            if (isLandscapeFullscreen()) titleMargin = Math.round(titleMargin * 0.50f);
            if (titleLayout.topMargin != titleMargin) {
                titleLayout.topMargin = titleMargin;
                top.setLayoutParams(titleLayout);
            }
            FrameLayout.LayoutParams controlsLayout = (FrameLayout.LayoutParams) controls.getLayoutParams();
            if (controlsLayout.bottomMargin != bottomInset) {
                controlsLayout.bottomMargin = bottomInset;
                controls.setLayoutParams(controlsLayout);
            }
            FrameLayout.LayoutParams progressLayout = (FrameLayout.LayoutParams) miniProgress.getLayoutParams();
            int progressMargin = collapsedProgressBottomMargin(bottomInset);
            if (progressLayout.bottomMargin != progressMargin) {
                progressLayout.bottomMargin = progressMargin;
                miniProgress.setLayoutParams(progressLayout);
            }
            return insets;
        });
        root.requestApplyInsets();
        updateSystemBars();
        updateControlLayout();
        if (tvMode) {
            /* 起播先露 4 秒标题，之后自动收掉；想再看按一下确定键。
               底部那条常显的黄进度条不再画：整块压在画面上太破坏沉浸感，
               拖进度时靠标题条 + 左右键松开后的时间气泡做反馈。 */
            tvInfoShown = true;
            updateTitleVisibility();
            handler.postDelayed(hideTvInfo, 4000);
            buildTvBar();
        }
    }

    private static String speedLabel(float speed) {
        return (speed == (int) speed ? String.valueOf((int) speed) : String.valueOf(speed)) + "×";
    }

    private void applyPlaybackSpeed(float speed) {
        if (player != null) player.setPlaybackSpeed(speed);
        if (speedTrigger != null) speedTrigger.setText(speedLocked ? "2×锁" : speedLabel(speed));
    }

    private void closeSpeedPanel() {
        if (speedPanel == null) return;
        root.removeView(speedPanel);
        root.removeView(speedScrim);
        speedPanel = null;
        speedScrim = null;
        revealControls();
    }

    private void showSpeedPanel() {
        if (speedPanel != null) { closeSpeedPanel(); return; }
        revealControls();
        handler.removeCallbacks(hideControls);
        speedScrim = new View(this);
        speedScrim.setOnClickListener(v -> closeSpeedPanel());
        root.addView(speedScrim, new FrameLayout.LayoutParams(-1, -1));
        speedPanel = new LinearLayout(this);
        speedPanel.setOrientation(LinearLayout.VERTICAL);
        speedPanel.setPadding(dp(10), dp(9), dp(10), dp(10));
        GradientDrawable background = background(0xF326292A, 13);
        background.setStroke(dp(1), 0xFF796D53);
        speedPanel.setBackground(background);
        speedPanel.setElevation(dp(18));
        TextView heading = label("播放速度", 13, Color.WHITE);
        heading.setGravity(Gravity.CENTER);
        speedPanel.addView(heading, new LinearLayout.LayoutParams(-1, dp(28)));
        GridLayout grid = new GridLayout(this);
        grid.setColumnCount(3);
        for (float speed : SPEEDS) {
            TextView option = label(speedLabel(speed), 13, speed == manualSpeed ? Color.BLACK : Color.WHITE);
            option.setGravity(Gravity.CENTER);
            option.setBackground(background(speed == manualSpeed ? YELLOW : 0xFF3B4042, 8));
            GridLayout.LayoutParams params = new GridLayout.LayoutParams();
            params.width = dp(67);
            params.height = dp(39);
            params.setMargins(dp(2), dp(2), dp(2), dp(2));
            grid.addView(option, params);
            option.setOnClickListener(v -> {
                manualSpeed = speed;
                speedLocked = false;
                speedHoldActive = false;
                applyPlaybackSpeed(speed);
                closeSpeedPanel();
            });
        }
        speedPanel.addView(grid);
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        params.bottomMargin = navigationInsetBottom + dp(90);
        root.addView(speedPanel, params);
    }

    private void buildSeekPreview() {
        previewBubble = new LinearLayout(this);
        previewBubble.setOrientation(LinearLayout.VERTICAL);
        previewBubble.setPadding(dp(5), dp(5), dp(5), dp(3));
        GradientDrawable bubble = background(0xF2222528, 11);
        bubble.setStroke(dp(1), 0xFF8D7A4E);
        previewBubble.setBackground(bubble);
        previewBubble.setElevation(dp(16));
        FrameLayout frame = new FrameLayout(this);
        frame.setBackgroundColor(0xFF151719);
        previewView = new PlayerView(this);
        previewView.setUseController(false);
        previewView.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT);
        frame.addView(previewView, new FrameLayout.LayoutParams(-1, -1));
        previewHint = label("暂无法预览", 11, 0xFFD4D0C6);
        previewHint.setGravity(Gravity.CENTER);
        previewHint.setVisibility(View.GONE);
        frame.addView(previewHint, new FrameLayout.LayoutParams(-1, -1));
        previewLoading = new ProgressBar(this);
        previewLoading.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(YELLOW));
        frame.addView(previewLoading, new FrameLayout.LayoutParams(dp(18), dp(18), Gravity.CENTER));
        previewBubble.addView(frame, new LinearLayout.LayoutParams(-1, 0, 1));
        previewTime = label("0:00", 12, Color.WHITE);
        previewTime.setGravity(Gravity.CENTER);
        previewBubble.addView(previewTime, new LinearLayout.LayoutParams(-1, dp(22)));
        previewBubble.setVisibility(View.GONE);
        root.addView(previewBubble, new FrameLayout.LayoutParams(dp(136), dp(105), Gravity.TOP | Gravity.LEFT));
    }

    private void startSeekPreview(SeekBar bar) {
        seeking = true;
        cancelPrefetch();
        revealControls();
        handler.removeCallbacks(hideControls);
        previewHint.setVisibility(View.GONE);
        previewLoading.setVisibility(View.VISIBLE);
        updateSeekPreview(bar, bar.getProgress());
    }

    private void updateSeekPreview(SeekBar bar, int progress) {
        if (player == null || player.getDuration() <= 0) return;
        previewTarget = player.getDuration() * progress / 1000;
        previewTime.setText(clock(previewTarget));
        int landscape = getResources().getConfiguration().orientation == Configuration.ORIENTATION_LANDSCAPE ? 1 : 0;
        int width = dp(landscape == 1 ? 160 : 136);
        int height = dp(landscape == 1 ? 112 : 105);
        int[] barLocation = new int[2];
        int[] rootLocation = new int[2];
        bar.getLocationOnScreen(barLocation);
        root.getLocationOnScreen(rootLocation);
        int usable = Math.max(1, bar.getWidth() - bar.getPaddingLeft() - bar.getPaddingRight());
        int thumbX = barLocation[0] - rootLocation[0] + bar.getPaddingLeft() + usable * progress / 1000;
        FrameLayout.LayoutParams params = (FrameLayout.LayoutParams) previewBubble.getLayoutParams();
        params.width = width;
        params.height = height;
        params.leftMargin = Math.max(dp(8), Math.min(root.getWidth() - width - dp(8), thumbX - width / 2));
        params.topMargin = Math.max(dp(72), barLocation[1] - rootLocation[1] - height - dp(12));
        previewBubble.setLayoutParams(params);
        previewBubble.setVisibility(View.VISIBLE);
        if (currentSource == null || previewSeekScheduled) return;
        long elapsed = SystemClock.uptimeMillis() - lastPreviewRequest;
        long delay = lastPreviewRequest == 0 ? 120 : Math.max(0, 350 - elapsed);
        previewSeekScheduled = true;
        handler.postDelayed(previewSeek, delay);
    }

    private void ensurePreviewPlayer() {
        if (previewPlayer != null) return;
        cancelPrefetch();
        previewPlayer = new ExoPlayer.Builder(this)
                .setLoadControl(new EpisodeLoadControl(true))
                .setMediaSourceFactory(VideoPlaybackCache.sources(this)).build();
        previewPlayer.setTrackSelectionParameters(previewPlayer.getTrackSelectionParameters().buildUpon()
                .setTrackTypeDisabled(C.TRACK_TYPE_AUDIO, true).build());
        previewPlayer.setSeekParameters(SeekParameters.CLOSEST_SYNC);
        previewPlayer.setVolume(0f);
        previewView.setPlayer(previewPlayer);
        previewPlayer.addListener(new Player.Listener() {
            @Override public void onRenderedFirstFrame() {
                previewLoading.setVisibility(View.GONE);
                previewHint.setVisibility(View.GONE);
            }
            @Override public void onPlayerError(PlaybackException error) {
                previewLoading.setVisibility(View.GONE);
                previewHint.setText("暂无法预览");
                previewHint.setVisibility(View.VISIBLE);
                Log.w("HuangGuo", "Seek preview unavailable", error);
            }
        });
        previewPlayer.setMediaItem(new MediaItem.Builder().setUri(currentSource)
                .setMimeType(currentMime).build());
        previewPlayer.pause();
        previewPlayer.seekTo(previewBucket);
        previewPlayer.prepare();
    }

    private void finishSeekPreview(SeekBar bar) {
        stopSeekPreview();
        if (player != null && player.getDuration() > 0) player.seekTo(player.getDuration() * bar.getProgress() / 1000);
        saveProgress(false);
        revealControls();
    }

    private void stopSeekPreview() {
        seeking = false;
        handler.removeCallbacks(previewSeek);
        previewSeekScheduled = false;
        previewBubble.setVisibility(View.GONE);
        previewView.setPlayer(null);
        if (previewPlayer != null) { previewPlayer.release(); previewPlayer = null; }
        previewBucket = -1;
        lastPreviewRequest = 0;
    }

    private static String clock(long millis) {
        long seconds = Math.max(0, millis / 1000);
        return seconds / 60 + ":" + String.format(java.util.Locale.ROOT, "%02d", seconds % 60);
    }

    private static boolean hasTimeout(Throwable error) {
        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
            if (cause instanceof java.net.SocketTimeoutException) return true;
        }
        return false;
    }

    private boolean isAiQueue() { return "ai-huanlian".equals(group) || "ai-mogai".equals(group); }
    private String cacheKey(String id, int episode) { return id + ":" + episode; }

    private Selection adjacent(int direction) {
        if (isAiQueue()) {
            int index = queueIndex + direction;
            JSONObject item = queue.optJSONObject(index);
            return item == null ? null : new Selection(item, index, 1);
        }
        int currentIndex = -1;
        for (int i = 0; i < episodes.length(); i++) {
            if (episodes.optJSONObject(i).optInt("number") == currentEpisode) { currentIndex = i; break; }
        }
        if (currentIndex < 0) return null;
        JSONObject next = episodes.optJSONObject(currentIndex + direction);
        return next == null ? null : new Selection(currentItem, queueIndex, next.optInt("number"));
    }

    private void loadPoster(JSONObject item, ImageView target) {
        String url = item.optString("cover");
        if (url.isEmpty()) return;
        target.setTag(url);
        Bitmap cached;
        synchronized (posterCache) { cached = posterCache.get(url); }
        if (cached != null) {
            target.setImageBitmap(cached);
            if (target == poster && !activeFirstFrame) { target.setVisibility(View.VISIBLE); skeleton.setVisibility(View.GONE); }
            return;
        }
        worker.execute(() -> {
            try {
                String data = repository.coverData(url);
                byte[] bytes = Base64.decode(data.substring(data.indexOf(',') + 1), Base64.DEFAULT);
                Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                if (bitmap == null) return;
                synchronized (posterCache) { posterCache.put(url, bitmap); }
                runOnUiThread(() -> {
                    if (!destroyed && !isFinishing() && url.equals(target.getTag())) {
                        target.setImageBitmap(bitmap);
                        if (target == poster && !activeFirstFrame) { target.setVisibility(View.VISIBLE); skeleton.setVisibility(View.GONE); }
                    }
                });
            } catch (Exception ignored) { }
        });
    }

    private boolean isHongguoFinalEpisode() {
        return !ContentMode.PRIVATE.equals(store.source) && !isAiQueue() && episodes.length()>0
                && episodes.optJSONObject(episodes.length()-1)!=null
                && currentEpisode==episodes.optJSONObject(episodes.length()-1).optInt("number");
    }
    private void prepareSequels() {
        if (sequelTask!=null) sequelTask.cancel(true);
        sequelCandidates=new JSONArray();
        if (!isHongguoFinalEpisode()) return;
        String id=currentItem.optString("id");
        JSONArray cached=sequelCache.get(id);
        if(cached!=null) { sequelCandidates=cached; return; }
        JSONObject item=currentItem;
        sequelTask=worker.submit(() -> {
            JSONArray rows;
            try { rows=repository.sequelCandidates(item); } catch(Exception ignored) { rows=new JSONArray(); }
            if(Thread.currentThread().isInterrupted()) return;
            JSONArray ready=rows;
            runOnUiThread(() -> {
                if(destroyed || isFinishing() || !id.equals(currentItem.optString("id")) || !isHongguoFinalEpisode()) return;
                sequelCache.put(id,ready);
                sequelCandidates=ready;
                if(seasonEnded) showSequelEnd(false);
            });
        });
    }
    private void hideSequelEnd() {
        if(sequelOverlay!=null) { root.removeView(sequelOverlay); sequelOverlay=null; }
    }
    private int sequelEpisode(JSONObject item, JSONArray list) {
        JSONObject progress=store.latestProgress(item.optString("id"));
        int number=progress==null?1:progress.optInt("episode",1);
        if(progress!=null && progress.optBoolean("completed") && number<list.length()) number++;
        for(int i=0;i<list.length();i++) if(list.optJSONObject(i).optInt("number")==number) return number;
        return list.length()>0?list.optJSONObject(0).optInt("number",1):1;
    }
    private void openSequel(JSONObject item) {
        if(openingSequel) return;
        openingSequel=true;
        String previousId=currentItem.optString("id");
        worker.submit(() -> {
            try {
                JSONObject detail=repository.detail(item.optString("id"));
                JSONArray list=detail.getJSONArray("episodes");
                if(list.length()==0) throw new IllegalStateException("没有分集");
                runOnUiThread(() -> {
                    if(destroyed || isFinishing() || !seasonEnded || !previousId.equals(currentItem.optString("id"))) return;
                    saveProgress(true);
                    currentSource=null;
                    episodes=list;
                    switchTo(new Selection(item,0,sequelEpisode(item,list)));
                });
            } catch(Exception ignored) {
                runOnUiThread(() -> {
                    if(destroyed || !previousId.equals(currentItem.optString("id"))) return;
                    openingSequel=false;
                    if(seasonEnded) showSequelEnd(false);
                    toast("续作加载失败，请再试一次");
                });
            }
        });
    }
    private void addSequelCard(LinearLayout parent, JSONObject item) {
        LinearLayout card=new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(16),dp(16),dp(16),dp(16));
        card.setBackground(background(0xF0252527,16));
        LinearLayout row=new LinearLayout(this);
        ImageView cover=new ImageView(this);
        cover.setScaleType(ImageView.ScaleType.CENTER_CROP);
        cover.setBackground(background(0xFF383638,8));
        cover.setClipToOutline(true);
        row.addView(cover,new LinearLayout.LayoutParams(dp(78),dp(106)));
        loadPoster(item,cover);
        LinearLayout info=new LinearLayout(this);
        info.setOrientation(LinearLayout.VERTICAL);
        info.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams infoParams=new LinearLayout.LayoutParams(0,-1,1);
        infoParams.leftMargin=dp(14);
        row.addView(info,infoParams);
        info.addView(label("可能的续作",12,0xFFFFAD70));
        TextView name=label(item.optString("title"),17,Color.WHITE);
        name.setTypeface(null,Typeface.BOLD);
        name.setMaxLines(2);
        name.setEllipsize(android.text.TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams nameParams=new LinearLayout.LayoutParams(-1,-2);
        nameParams.topMargin=dp(6);
        info.addView(name,nameParams);
        String count=item.optString("episodeLabel");
        if(!count.isEmpty()) info.addView(label(count,13,0xFFD5D0CD));
        JSONObject progress=store.latestProgress(item.optString("id"));
        if(progress!=null) {
            TextView hint=label("上次看到第 "+progress.optInt("episode",1)+" 集 · "+clock(progress.optLong("position")),12,0xFFD5D0CD);
            LinearLayout.LayoutParams hintParams=new LinearLayout.LayoutParams(-1,-2);
            hintParams.topMargin=dp(8);
            info.addView(hint,hintParams);
        }
        card.addView(row,new LinearLayout.LayoutParams(-1,dp(128)));
        TextView action=label(progress==null?"查看续作":"继续观看续作",16,Color.BLACK);
        action.setTypeface(null,Typeface.BOLD);
        action.setGravity(Gravity.CENTER);
        action.setBackground(background(0xFFFF882C,12));
        action.setOnClickListener(v -> {
            if(openingSequel) return;
            action.setText("正在加载续作…");
            action.setEnabled(false);
            openSequel(item);
        });
        LinearLayout.LayoutParams buttonParams=new LinearLayout.LayoutParams(-1,dp(48));
        buttonParams.topMargin=dp(14);
        card.addView(action,buttonParams);
        LinearLayout.LayoutParams cardParams=new LinearLayout.LayoutParams(-1,-2);
        cardParams.topMargin=dp(12);
        parent.addView(card,cardParams);
    }
    private void showSequelEnd(boolean list) {
        hideSequelEnd();
        revealControls();
        handler.removeCallbacks(hideControls);
        centerToggle.setVisibility(View.GONE);
        sequelOverlay=new LinearLayout(this);
        sequelOverlay.setOrientation(LinearLayout.VERTICAL);
        sequelOverlay.setPadding(dp(20),dp(18),dp(20),dp(18));
        sequelOverlay.setBackground(background(0xA8000000,18));
        sequelOverlay.setClickable(true);
        TextView heading=label("本季已看完",22,Color.WHITE);
        heading.setTypeface(null,Typeface.BOLD);
        heading.setGravity(Gravity.CENTER);
        sequelOverlay.addView(heading,new LinearLayout.LayoutParams(-1,-2));
        if(sequelCandidates.length()==1) {
            ScrollView scroll=new ScrollView(this);
            LinearLayout cards=new LinearLayout(this);
            cards.setOrientation(LinearLayout.VERTICAL);
            addSequelCard(cards,sequelCandidates.optJSONObject(0));
            scroll.addView(cards);
            int room=Math.max(dp(96),root.getHeight()-dp(280));
            sequelOverlay.addView(scroll,new LinearLayout.LayoutParams(-1,Math.min(dp(238),room)));
        }
        else if(sequelCandidates.length()>1 && !list) {
            TextView action=label("查看可能的续作（"+sequelCandidates.length()+"）",16,Color.BLACK);
            action.setGravity(Gravity.CENTER);
            action.setBackground(background(0xFFFF882C,12));
            action.setOnClickListener(v -> showSequelEnd(true));
            LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,dp(48));
            params.topMargin=dp(18);
            sequelOverlay.addView(action,params);
        } else if(list) {
            ScrollView scroll=new ScrollView(this);
            LinearLayout cards=new LinearLayout(this);
            cards.setOrientation(LinearLayout.VERTICAL);
            for(int i=0;i<sequelCandidates.length();i++) addSequelCard(cards,sequelCandidates.optJSONObject(i));
            scroll.addView(cards);
            sequelOverlay.addView(scroll,new LinearLayout.LayoutParams(-1,Math.min(dp(300),Math.max(dp(96),root.getHeight()-dp(280)))));
        }
        int availableWidth=(int)(getResources().getDisplayMetrics().widthPixels/getResources().getDisplayMetrics().density);
        FrameLayout.LayoutParams params=new FrameLayout.LayoutParams(dp(Math.min(400,availableWidth-32)),-2,Gravity.CENTER);
        root.addView(sequelOverlay,params);
    }

    private long resumePosition(String id, int episode) {
        // 详情页按了「从头播放」：这一集忽略历史进度，播完这集之后照旧续播
        if (restartPending) { restartPending = false; return 0; }
        if (startPositionPending) { startPositionPending = false; return startPosition; }
        JSONObject progress = store.getProgress(id, episode);
        if (progress == null || progress.optBoolean("completed")) return 0;
        long position = progress.optLong("position");
        return position > 0 && position < progress.optLong("duration") ? position : 0;
    }

    private void loadSelection() {
        disarmReuseGuard();
        hideSequelEnd();
        seasonEnded = false;
        openingSequel = false;
        prepareSequels();
        final int token = ++loadToken;
        final String id = currentItem.optString("id");
        final int episode = currentEpisode;
        final String key = cacheKey(id, episode);
        switchStartedAt = SystemClock.elapsedRealtime();
        if (sourceTask != null) sourceTask.cancel(true);
        stopSeekPreview();
        boolean reuse = key.equals(standbyKey) && standbyPlayer != null
                && standbyPlayer.getPlayerError() == null
                /* 还没 READY 的预取播放器不要复用：它的缓冲只到一半，提升过来
                   还得接着等，等于把「预取完成」和「从零开始」的坏处各吃一遍 */
                && standbyPlayer.getPlaybackState() == Player.STATE_READY;
        /* 预取到的播放地址是有时效的。停了很久再切过去，standby 里的地址可能已经过期，
           prepare 直接失败 —— 表现就是「这一集一直转圈」。超过 2 分半就丢掉重取。 */
        if (reuse && standbyPreparedAt > 0 && SystemClock.elapsedRealtime() - standbyPreparedAt > 150_000) {
            synchronized (episodeCache) { episodeCache.remove(key); }
            releaseStandby();
            reuse = false;
            Log.d("HuangGuoPlayback", "standby stale, refetch " + key);
        }
        Log.d("HuangGuoPlayback", "open " + key + " standby=" + key.equals(standbyKey) + " reuse=" + reuse);
        float volume = player.getVolume();
        /* 自动连播：上一集播完直接切下一集，且预取的那份已经 READY ——
           这种时候一个加载圈、一行海报都不该出现，画面直接接上。
           做不到无缝（standby 没就绪）就退回原来的加载表现。 */
        boolean seamless = seamlessNext && reuse;
        seamlessNext = false;
        if (!seamless) {
            player.pause();
            seekBar.setProgress(0);
            landscapeSeek.setProgress(0);
            updateMiniProgress(0, 1);
            timeText.setText("0:00 / 0:00");
            skeleton.setVisibility(View.VISIBLE);
            poster.setVisibility(View.INVISIBLE);
            poster.setImageDrawable(null);
            loading.setVisibility(View.VISIBLE);
            centerToggle.setVisibility(View.GONE);
            message.setVisibility(View.GONE);
        }
        currentSource = null;
        activeFirstFrame = false;
        failedStandbyKey = null;
        currentId = id;
        updateBookmarkButton();
        title.setText(currentItem.optString("title") + " · 第 " + episode + " 集");
        episodeText.setText(isAiQueue() ? "AI 作品" : "第 " + episode + " 集");
        sourceRetryCount = 0;
        if (reuse) {
            ExoPlayer old = player;
            activeView.setPlayer(null);
            activeView.setAlpha(0f);
            PlayerView oldView = activeView;
            activeView = standbyView;
            standbyView = oldView;
            player = standbyPlayer;
            currentSource = standbySource;
            currentMime = standbyMime;
            activeFirstFrame = standbyFirstFrame;
            standbyLoadControl.promote();
            standbyPlayer = null;
            standbyKey = null;
            standbySource = null;
            standbyFirstFrame = false;
            cancelPrefetch();
            old.release();
            activeView.setAlpha(1f);
            player.setVolume(volume);
            applyPlaybackSpeed(speedLocked ? 2f : manualSpeed);
            updateVideoGeometry(player.getVideoSize());
            if (seamless) {
                /* 连播时连海报和骨架都不要：先按「已有画面」处理，
                   真没出首帧也就是黑一两帧，比闪一张海报自然 */
                showActiveFrame();
                suppressLoadingUntil = SystemClock.elapsedRealtime() + 2000;
            } else if (activeFirstFrame) showActiveFrame();
            else loadPoster(currentItem, poster);
            player.setPlayWhenReady(foreground);
            armReuseGuard(player);
            Log.d("HuangGuoPlayback", "reuse " + key + " firstFrame=" + activeFirstFrame
                    + " state=" + player.getPlaybackState());
            maybePrepareNext();
            return;
        }
        cancelPrefetch();
        loadPoster(currentItem, poster);
        player.stop();
        player.clearMediaItems();
        sourceTask = worker.submit(() -> {
            try {
                JSONObject data;
                synchronized (episodeCache) { data = episodeCache.get(key); }
                if (data == null) data = repository.episode(id, episode);
                if (Thread.currentThread().isInterrupted()) return;
                JSONObject ready = data;
                synchronized (episodeCache) { episodeCache.put(key, ready); }
                runOnUiThread(() -> {
                    if (token != loadToken || destroyed || isFinishing()) return;
                    currentSource = ready.optString("source");
                    currentMime = ready.optString("mimeType", MimeTypes.APPLICATION_M3U8);
                    // 直连模式：把后端随播放地址下发的 Referer / 签名 Cookie 交给数据源
                    MediaRequestContext.set(ready, currentSource);
                    // 每次开播按当前通道模式重建数据源（直连/代理/后端转发切换立即生效）
                    MediaItem mediaItem = new MediaItem.Builder().setUri(currentSource).setMediaId(key)
                            .setMimeType(currentMime).build();
                    player.setMediaSource(VideoPlaybackCache.sources(this).createMediaSource(mediaItem),
                            resumePosition(id, episode));
                    applyPlaybackSpeed(speedLocked ? 2f : manualSpeed);
                    player.prepare();
                    player.setPlayWhenReady(foreground);
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    if (token != loadToken || destroyed || isFinishing()) return;
                    loading.setVisibility(View.GONE);
                    message.setText("加载失败: " + error.getMessage() + "\n点击重试");
                    message.setVisibility(View.VISIBLE);
                    message.setOnClickListener(view -> loadSelection());
                });
                if (!Thread.currentThread().isInterrupted()) Log.e("HuangGuo", "Episode failed", error);
            }
        });
    }

    /**
     * 取流预热：把当前集前后几集的播放地址先解析好放进 episodeCache。
     *
     * 切集慢的一大半不是解码，是切过去才开始调 episode 接口解析地址（一次几百 ms 到几秒，
     * 还要签名/风控）。预取播放器只提前准备「下一集」，往回切、跳两集都赶不上，
     * 所以单独预热一圈 —— 只解析地址，不建播放器、不占解码器，几乎不吃带宽。
     */
    private int warmToken;
    private void scheduleWarmNeighbors() {
        final String id = currentId;
        final int episode = currentEpisode;
        if (id == null || id.isEmpty()) return;
        final int token = ++warmToken;
        handler.postDelayed(() -> {
            if (token != warmToken || destroyed || isFinishing()) return;
            warmEpisode(id, episode + 1);
            warmEpisode(id, episode + 2);
            warmEpisode(id, episode - 1);
        }, 1_500);
    }

    private boolean hasEpisode(int number) {
        for (int i = 0; i < episodes.length(); i++) {
            if (episodes.optJSONObject(i).optInt("number") == number) return true;
        }
        return false;
    }

    private void warmEpisode(String id, int number) {
        if (number < 1 || !hasEpisode(number)) return;
        final String key = cacheKey(id, number);
        synchronized (episodeCache) {
            if (episodeCache.containsKey(key)) return;
        }
        if (!warming.add(key)) return;
        warmWorker.execute(() -> {
            try {
                JSONObject data = repository.episode(id, number);
                if (data != null) {
                    synchronized (episodeCache) { episodeCache.put(key, data); }
                    Log.d("HuangGuoPlayback", "warm " + key + " ok");
                }
            } catch (Exception error) {
                Log.d("HuangGuoPlayback", "warm " + key + " failed: " + error.getMessage());
            } finally {
                warming.remove(key);
            }
        });
    }

    private void armReuseGuard(ExoPlayer engine) {
        reuseGuardPlayer = engine;
        handler.removeCallbacks(reuseGuard);
        handler.postDelayed(reuseGuard, 2_500);
    }

    private void disarmReuseGuard() {
        reuseGuardPlayer = null;
        handler.removeCallbacks(reuseGuard);
    }

    /**
     * 预取播放器提升后不出帧时的兜底：丢掉它，用 episodeCache 里已经解析好的
     * 播放地址重新建一个播放器。这条路径和手动切集完全一样，不会再卡。
     */
    private void rebuildCurrentEpisode() {
        if (destroyed || isFinishing() || player == null) return;
        float volume = player.getVolume();
        ExoPlayer stalled = player;
        player = createEpisodePlayer(false);
        activeView.setPlayer(player);
        player.setVolume(volume);
        stalled.release();
        releaseStandby();
        loadSelection();
    }

    private void maybePrepareNext() {
        if (!foreground || destroyed || seeking || previewPlayer != null || switching || player == null
                || currentSource == null || !activeFirstFrame || player.getPlaybackState() != Player.STATE_READY) return;
        long ahead = player.getBufferedPosition() - player.getCurrentPosition();
        long duration = player.getDuration();
        boolean fullyBuffered = duration > 0 && player.getBufferedPosition() >= duration;
        // 缓冲真的见底才把预取撤掉（原来是 2 秒，稍微抖一下就撤，撤了又建，来回拉锯）
        /* 150ms 见底才撤。800ms 太敏感：短剧在网络稍抖时会被来回撤/建，
           预取永远建不完，切集只能从头拉。 */
        if (!fullyBuffered && ahead < 150 && standbyPlayer != null) cancelPrefetch();
        // 快播完了就别再等 10 秒缓冲：短剧一集才一两分钟，等 10 秒等于等掉半集
        boolean nearEnd = duration > 0 && duration - player.getCurrentPosition() < 25_000;
        // 短剧（4 分钟以内）1.2 秒就开始预取下一集：等 5 秒的话一集才 60 秒，
        // 预取还没起来就已经播完了，切下一集只能从头拉，就是「切集要转圈好几秒」。
        long warmAhead = duration > 0 && duration < 240_000 ? 1_200 : 5_000;
        if (ahead < warmAhead && !fullyBuffered && !nearEnd) return;
        Selection next = adjacent(1);
        if (next == null) return;
        String id = next.item.optString("id");
        String key = cacheKey(id, next.episode);
        if (standbyPlayer != null || prefetchTask != null) return;
        /* 失败只退避 5 秒。以前是永久屏蔽：某一集取流失败一次，之后再也不预取，
           每次切到它都要现拉地址，看起来就是「这一集永远卡」。 */
        if (key.equals(failedStandbyKey) && SystemClock.elapsedRealtime() - failedStandbyAt < 5_000) return;
        int token = ++prefetchToken;
        int selectionToken = loadToken;
        prefetchTask = prefetchWorker.submit(() -> {
            try {
                JSONObject data;
                synchronized (episodeCache) { data = episodeCache.get(key); }
                if (data == null) data = repository.episode(id, next.episode);
                if (Thread.currentThread().isInterrupted()) return;
                JSONObject ready = data;
                synchronized (episodeCache) { episodeCache.put(key, ready); }
                runOnUiThread(() -> {
                    if (token != prefetchToken || selectionToken != loadToken || destroyed) return;
                    prefetchTask = null;
                    /* 只预热「播放地址」，不再提前建一个 standby 播放器。
                       提前建播放器确实能省掉 prepare 的两三百毫秒，但电视盒子上
                       把它提升为主播放器后经常不出首帧，界面一直停在加载中 ——
                       切回上一集再切回来（走重建）又好了。宁可按确定的路径重建，
                       地址已经在 episodeCache 里，切集不会再走网络解析。 */
                    Log.d("HuangGuoPlayback", "prefetch-address " + key + " ok");
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    if (token != prefetchToken || destroyed) return;
                    prefetchTask = null;
                    failedStandbyKey = key;
                });
            }
        });
    }

    private void releaseStandby() {
        if (standbyView != null) {
            standbyView.setPlayer(null);
            standbyView.setAlpha(0f);
        }
        if (standbyPlayer != null) standbyPlayer.release();
        standbyPlayer = null;
        standbyLoadControl = null;
        standbyKey = null;
        standbySource = null;
        standbyFirstFrame = false;
        standbyPreparedAt = 0;
    }

    private void cancelPrefetch() {
        ++prefetchToken;
        if (prefetchTask != null) prefetchTask.cancel(true);
        prefetchTask = null;
        releaseStandby();
    }

    private void showIncoming(Selection selection, int direction) {
        incoming.setImageDrawable(null);
        incoming.setTag(null);
        incoming.setVisibility(View.VISIBLE);
        incomingDirection = direction;
        if (standbyFirstFrame && cacheKey(selection.item.optString("id"), selection.episode).equals(standbyKey)
                && standbyView.getVideoSurfaceView() instanceof TextureView) {
            Bitmap frame = ((TextureView) standbyView.getVideoSurfaceView()).getBitmap();
            if (frame != null) {
                incoming.setScaleType(ImageView.ScaleType.FIT_CENTER);
                incoming.setImageBitmap(frame);
                return;
            }
        }
        /* 没预取到下一集时，先用当前这一集的画面顶上，切过去再等首帧 ——
           比直接闪一张海报自然，也不会让人觉得「点了没反应」。 */
        if (activeView.getVideoSurfaceView() instanceof TextureView) {
            Bitmap frame = ((TextureView) activeView.getVideoSurfaceView()).getBitmap();
            if (frame != null) {
                incoming.setScaleType(ImageView.ScaleType.FIT_CENTER);
                incoming.setImageBitmap(frame);
                return;
            }
        }
        incoming.setScaleType(ImageView.ScaleType.CENTER_CROP);
        loadPoster(selection.item, incoming);
    }

    private void switchTo(Selection selection) {
        switching = false;
        mediaLayer.animate().cancel();
        incoming.animate().cancel();
        closeSpeedPanel();
        if (episodesOpen) closeEpisodes();
        saveProgress(false);
        boolean wasAi = isAiQueue();
        int oldIndex = queueIndex;
        currentItem = selection.item;
        queueIndex = selection.index;
        currentEpisode = selection.episode;
        mediaLayer.setTranslationY(0);
        incoming.setTranslationY(0);
        incoming.setVisibility(View.GONE);
        incoming.setImageDrawable(null);
        loadSelection();
        if (wasAi && oldIndex != queueIndex) toast(oldIndex < queueIndex ? "跳转至下一部作品" : "返回上一部作品");
    }

    private void animateSwitch(Selection selection, int direction) {
        if (dragging || switching) return;
        switching = true;
        int height = Math.max(1, root.getHeight());
        showIncoming(selection, direction);
        incoming.setTranslationY(direction > 0 ? height : -height);
        player.pause();
        mediaLayer.animate().translationY(direction > 0 ? -height : height).setDuration(290).start();
        incoming.animate().translationY(0).setDuration(290).withEndAction(() -> switchTo(selection)).start();
    }

    private boolean handleGesture(MotionEvent event) {
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                if (switching) return true;
                mediaLayer.animate().cancel();
                incoming.animate().cancel();
                if (edgeGestureStart(event.getY())) {
                    dragging = false;
                    return false;
                }
                touchStartX = event.getX();
                touchStartY = event.getY();
                dragY = 0;
                dragging = true;
                gestureMode = GESTURE_PENDING;
                doubleTapCandidate = SystemClock.uptimeMillis() - lastTapAt < ViewConfiguration.getDoubleTapTimeout()
                        && Math.abs(touchStartX - lastTapX) < dp(72) && Math.abs(touchStartY - lastTapY) < dp(72);
                if (doubleTapCandidate) handler.removeCallbacks(singleTap);
                handler.postDelayed(longPress, ViewConfiguration.getLongPressTimeout());
                return true;
            case MotionEvent.ACTION_MOVE:
                if (!dragging) return true;
                float dx = event.getX() - touchStartX;
                float dy = event.getY() - touchStartY;
                if (gestureMode == GESTURE_PENDING) {
                    int slop = Math.max(dp(10), ViewConfiguration.get(this).getScaledTouchSlop());
                    if (Math.hypot(dx, dy) < slop) return true;
                    handler.removeCallbacks(longPress);
                    lastTapAt = 0;
                    gestureMode = Math.abs(dx) > Math.abs(dy) * 1.15f ? GESTURE_HORIZONTAL : GESTURE_VERTICAL;
                    if (gestureMode == GESTURE_HORIZONTAL && player != null && player.getDuration() > 0) {
                        gestureSeekStart = player.getCurrentPosition();
                        seeking = true;
                        cancelPrefetch();
                        revealControls();
                        handler.removeCallbacks(hideControls);
                    }
                }
                if (gestureMode == GESTURE_HOLD) {
                    if (!holdToggled && dy > dp(64) && player != null && player.isPlaying()) {
                        holdToggled = true;
                        speedLocked = !speedLocked;
                        speedHoldActive = false;
                        applyPlaybackSpeed(speedLocked ? 2f : manualSpeed);
                        root.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
                        toast(speedLocked ? "已锁定 2×" : "已恢复 " + speedLabel(manualSpeed));
                    }
                    return true;
                }
                if (gestureMode == GESTURE_HORIZONTAL) {
                    if (player == null || player.getDuration() <= 0) return true;
                    long duration = player.getDuration();
                    long range = duration / 5;
                    gestureSeekTarget = Math.max(0, Math.min(duration,
                            gestureSeekStart + Math.round(dx * range / Math.max(1, root.getWidth()))));
                    int progress = (int) Math.min(1000, gestureSeekTarget * 1000 / duration);
                    SeekBar bar = getResources().getConfiguration().orientation == Configuration.ORIENTATION_LANDSCAPE
                            ? landscapeSeek : seekBar;
                    seekBar.setProgress(progress);
                    landscapeSeek.setProgress(progress);
                    updateSeekPreview(bar, progress);
                    return true;
                }
                dragY = Math.max(-root.getHeight(), Math.min(root.getHeight(), event.getY() - touchStartY));
                int direction = dragY < 0 ? 1 : -1;
                Selection candidate = adjacent(direction);
                mediaLayer.setTranslationY(dragY);
                if (candidate != null) {
                    if (incoming.getVisibility() != View.VISIBLE || incomingDirection != direction)
                        showIncoming(candidate, direction);
                    incoming.setTranslationY((direction > 0 ? root.getHeight() : -root.getHeight()) + dragY);
                } else incoming.setVisibility(View.GONE);
                return true;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                if (!dragging) return true;
                dragging = false;
                handler.removeCallbacks(longPress);
                boolean cancelled = event.getActionMasked() == MotionEvent.ACTION_CANCEL;
                if (gestureMode == GESTURE_HOLD) {
                    gestureMode = GESTURE_PENDING;
                    if (speedHoldActive && !speedLocked) applyPlaybackSpeed(manualSpeed);
                    speedHoldActive = false;
                    revealControls();
                    return true;
                }
                if (gestureMode == GESTURE_HORIZONTAL) {
                    gestureMode = GESTURE_PENDING;
                    stopSeekPreview();
                    if (!cancelled && player != null && player.getDuration() > 0) {
                        player.seekTo(gestureSeekTarget);
                        saveProgress(false);
                    }
                    revealControls();
                    return true;
                }
                if (gestureMode == GESTURE_PENDING) {
                    if (cancelled) return true;
                    if (doubleTapCandidate) {
                        lastTapAt = 0;
                        if (episodesOpen) closeEpisodes();
                        if (player != null) player.setPlayWhenReady(!player.getPlayWhenReady());
                        revealControls();
                    } else {
                        lastTapAt = SystemClock.uptimeMillis();
                        lastTapX = event.getX();
                        lastTapY = event.getY();
                        handler.postDelayed(singleTap, ViewConfiguration.getDoubleTapTimeout());
                    }
                    return true;
                }
                gestureMode = GESTURE_PENDING;
                int moveDirection = dragY < 0 ? 1 : -1;
                Selection next = adjacent(moveDirection);
                if (!cancelled && Math.abs(dragY) > Math.max(dp(76), root.getHeight() * 0.12f) && next != null) {
                    switching = true;
                    int height = root.getHeight();
                    player.pause();
                    mediaLayer.animate().translationY(moveDirection > 0 ? -height : height).setDuration(260).start();
                    incoming.animate().translationY(0).setDuration(260).withEndAction(() -> switchTo(next)).start();
                } else {
                    mediaLayer.animate().translationY(0).setDuration(220).start();
                    incoming.animate().translationY(moveDirection > 0 ? root.getHeight() : -root.getHeight())
                            .setDuration(220).withEndAction(() -> incoming.setVisibility(View.GONE)).start();
                    if (!cancelled && Math.abs(dragY) > dp(76) && next == null)
                        toast(moveDirection > 0 ? "已经是最后一集" : "已经是第一集");
                }
                return true;
        }
        return true;
    }

    private void showEpisodes() {
        if (episodesOpen) { closeEpisodes(); return; }
        if (episodes.length() == 0 || isAiQueue()) { toast("当前作品没有选集"); return; }
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(18), dp(18), dp(18), dp(18));
        GradientDrawable background = background(0xF7242320, 12);
        background.setStroke(dp(1), 0xFF796D53);
        panel.setBackground(background);
        panel.setElevation(dp(18));
        panel.setClickable(true);
        TextView heading = label("选集", 20, Color.WHITE);
        heading.setTypeface(null, Typeface.BOLD);
        panel.addView(heading, new LinearLayout.LayoutParams(-1, dp(36)));
        TextView current = label("当前第 " + currentEpisode + " 集", 12, 0xFFC9C4B8);
        panel.addView(current, new LinearLayout.LayoutParams(-1, dp(30)));
        ScrollView scroll = new ScrollView(this);
        android.widget.GridLayout grid = new android.widget.GridLayout(this);
        grid.setColumnCount(4);
        for (int i = 0; i < episodes.length(); i++) {
            JSONObject item = episodes.optJSONObject(i);
            if (item == null) continue;
            int number = item.optInt("number");
            TextView button = label(String.valueOf(number), 14, number == currentEpisode ? Color.BLACK : Color.WHITE);
            button.setGravity(Gravity.CENTER);
            button.setBackground(background(number == currentEpisode ? YELLOW : 0xFF373D40, 10));
            android.widget.GridLayout.LayoutParams params = new android.widget.GridLayout.LayoutParams();
            params.width = dp(52); params.height = dp(46); params.setMargins(dp(3), dp(3), dp(3), dp(3));
            grid.addView(button, params);
            button.setOnClickListener(v -> { closeEpisodes(); switchTo(new Selection(currentItem, queueIndex, number)); });
        }
        scroll.addView(grid);
        panel.addView(scroll, new LinearLayout.LayoutParams(-1, dp(260)));
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(dp(286), -2, Gravity.BOTTOM | Gravity.RIGHT);
        params.bottomMargin = navigationInsetBottom + dp(88);
        params.rightMargin = dp(13);
        episodeScrim = new View(this);
        episodeScrim.setOnClickListener(v -> closeEpisodes());
        root.addView(episodeScrim, new FrameLayout.LayoutParams(-1, -1));
        root.addView(panel, params);
        episodePanel = panel;
        episodesOpen = true;
        episodeTrigger.setText("收起");
        panel.setPivotX(dp(286));
        panel.setPivotY(dp(380));
        panel.setAlpha(0);
        panel.setScaleX(.72f);
        panel.setScaleY(.12f);
        panel.setTranslationY(dp(10));
        panel.animate().alpha(1).scaleX(1).scaleY(1).translationY(0).setDuration(300)
                .setInterpolator(new android.view.animation.PathInterpolator(.2f, .8f, .2f, 1f)).start();
        revealControls();
    }

    private void closeEpisodes() {
        if (!episodesOpen || episodePanel == null) return;
        LinearLayout closing = episodePanel;
        episodePanel = null;
        episodesOpen = false;
        if (episodeScrim != null) {
            root.removeView(episodeScrim);
            episodeScrim = null;
        }
        episodeTrigger.setText("选集");
        closing.animate().alpha(0).scaleX(.72f).scaleY(.12f).translationY(dp(10)).setDuration(220)
                .withEndAction(() -> root.removeView(closing)).start();
        revealControls();
    }

    private void updateControlLayout() {
        boolean landscape = getResources().getConfiguration().orientation == Configuration.ORIENTATION_LANDSCAPE;
        if (landscapeSeek != null) landscapeSeek.setVisibility(landscape ? View.VISIBLE : View.GONE);
        if (volumeButton != null) volumeButton.setVisibility(landscape ? View.VISIBLE : View.GONE);
        if (volumeSeek != null) volumeSeek.setVisibility(landscape ? View.VISIBLE : View.GONE);
        if (seekBar != null) ((View) seekBar.getParent()).setVisibility(landscape ? View.GONE : View.VISIBLE);
        if (timeText != null) {
            LinearLayout.LayoutParams params = (LinearLayout.LayoutParams) timeText.getLayoutParams();
            params.width = dp(landscape ? 77 : 65);
            timeText.setLayoutParams(params);
        }
        updateTitleVisibility();
    }

    private void updateBookmarkButton() {
        if (bookmarkButton == null) return;
        boolean saved = currentId != null && store.hasBookmark(currentId);
        bookmarkButton.setImageResource(saved ? R.drawable.player_bookmark_selected : R.drawable.player_bookmark);
        bookmarkButton.setColorFilter(saved ? YELLOW : Color.WHITE);
        bookmarkButton.setSelected(saved);
        bookmarkButton.setContentDescription(saved ? "取消收藏" : "收藏作品");
    }

    private void updateTitleVisibility() {
        if (titleBar == null) return;
        if (tvMode) {
            // 电视端标题只在按下确定键后短暂出现，平时不占画面
            titleBar.setVisibility(tvInfoShown ? View.VISIBLE : View.INVISIBLE);
            return;
        }
        titleBar.setVisibility(isLandscapeFullscreen() && !controlsShown ? View.INVISIBLE : View.VISIBLE);
    }

    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        closeSpeedPanel();
        if (seeking) stopSeekPreview();
        updateControlLayout();
        root.requestApplyInsets();
        updateSystemBars();
        if (seasonEnded) showSequelEnd(false);
    }

    /**
     * 手机「投到电视」：不是 Chromecast/DLNA，而是把「哪部剧、第几集、第几秒」
     * 推给同一账号下在线的电视端。电视端拿到后仍走它自己的 open-player（同一个
     * PlayerActivity），详情、选集、自动连播、预取全部复用，没有第二套播放器。
     */
    private void showCastDevices() {
        if (ContentMode.PRIVATE.equals(ContentMode.get(this).active())) {
            toast("私密内容暂不支持投屏，切回公开内容再试");
            return;
        }
        if (currentItem == null) return;
        final AccountService cloud = new AccountService(getApplicationContext(), store);
        if (!cloud.isLoggedIn()) { toast("登录后才能投屏"); return; }
        toast("正在找同一账号的电视…");
        worker.execute(() -> {
            JSONArray devices = new JSONArray();
            String error = null;
            try {
                JSONObject data = cloud.getJson("api/devices");
                JSONArray all = data.optJSONArray("devices");
                for (int i = 0; all != null && i < all.length(); i++) {
                    JSONObject device = all.optJSONObject(i);
                    if (device == null) continue;
                    // 电视和电脑都是「同一账号下可接投屏的设备」；手机自己不在列表里
                    String platform = device.optString("platform");
                    if (!"tv".equals(platform) && !"desktop".equals(platform)) continue;
                    if (!device.optBoolean("online")) continue;
                    devices.put(device);
                }
            } catch (Exception failure) {
                error = failure.getMessage() == null ? "网络异常" : failure.getMessage();
            }
            final JSONArray found = devices;
            final String failure = error;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                if (failure != null) { toast("读取设备失败：" + failure); return; }
                if (found.length() == 0) {
                    toast("没有在线的电视/电脑：确认设备已打开并登录同一账号");
                    return;
                }
                String[] labels = new String[found.length()];
                for (int i = 0; i < found.length(); i++) {
                    JSONObject device = found.optJSONObject(i);
                    boolean pc = "desktop".equals(device.optString("platform"));
                    labels[i] = device.optString("name", pc ? "电脑" : "电视") + (pc ? " · 电脑" : " · 电视") + " · 在线";
                }
                new AlertDialog.Builder(this)
                        .setTitle("投屏到设备")
                        .setItems(labels, (dialog, which) -> {
                            JSONObject device = found.optJSONObject(which);
                            if (device != null) castTo(device, cloud);
                        })
                        .setNegativeButton("取消", null)
                        .show();
            });
        });
    }

    private void castTo(JSONObject device, AccountService cloud) {
        if (device == null) return;
        final String name = device.optString("name",
                "desktop".equals(device.optString("platform")) ? "电脑" : "电视");
        final int episode = currentEpisode;
        long position = player == null ? 0 : player.getCurrentPosition();
        long duration = player == null ? 45000 : player.getDuration();
        JSONObject body = new JSONObject();
        try {
            body.put("deviceId", device.optString("id"));
            body.put("source", ContentMode.get(this).active());
            body.put("seriesId", currentId);
            body.put("title", currentItem == null ? "" : currentItem.optString("title"));
            body.put("cover", currentItem == null ? "" : currentItem.optString("cover"));
            body.put("episode", episode);
            body.put("position", position);
            body.put("duration", duration);
        } catch (Exception ignored) { }
        toast("正在投到 " + name + "…");
        worker.execute(() -> {
            try {
                cloud.postJson("api/devices/cast", body);
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed()) return;
                    toast("已投到 " + name + " · 第 " + episode + " 集");
                    // 声音只从电视出：手机上先停住，用户还能接着点播放
                    if (player != null) player.pause();
                    revealControls();
                });
            } catch (Exception failure) {
                String message = failure.getMessage() == null ? "投屏失败" : failure.getMessage();
                runOnUiThread(() -> toast(message));
            }
        });
    }

    private void updateMiniProgress(long position, long duration) {
        miniProgressFraction = Math.max(0f, Math.min(1f, (float) position / duration));
        updateMiniProgressFill();
    }

    private void updateMiniProgressFill() {
        if (miniProgress == null || miniProgress.getWidth() == 0) return;
        FrameLayout.LayoutParams params = (FrameLayout.LayoutParams) miniProgressFill.getLayoutParams();
        int width = Math.round(miniProgress.getWidth() * miniProgressFraction);
        if (params.width != width) { params.width = width; miniProgressFill.setLayoutParams(params); }
    }

    private SeekBar visibleSeekBar() {
        return getResources().getConfiguration().orientation == Configuration.ORIENTATION_LANDSCAPE
                ? landscapeSeek : seekBar;
    }

    private float[] miniToSeekGeometry(SeekBar target) {
        int[] miniPoint = new int[2];
        int[] seekPoint = new int[2];
        miniProgress.getLocationOnScreen(miniPoint);
        target.getLocationOnScreen(seekPoint);
        float miniCenterX = miniPoint[0] + miniProgress.getWidth() / 2f;
        float miniCenterY = miniPoint[1] + miniProgress.getHeight() / 2f;
        float seekCenterX = seekPoint[0] + target.getWidth() / 2f;
        float seekCenterY = seekPoint[1] + target.getHeight() / 2f;
        float trackWidth = target.getWidth() - target.getPaddingLeft() - target.getPaddingRight();
        return new float[]{seekCenterX - miniCenterX, seekCenterY - miniCenterY,
                Math.max(.08f, trackWidth / Math.max(1f, miniProgress.getWidth()))};
    }

    private void resetMiniTransform() {
        miniProgress.setTranslationX(0);
        miniProgress.setTranslationY(0);
        miniProgress.setScaleX(1);
        miniProgress.setScaleY(1);
    }

    private void showControlsTransition() {
        controlsShown = true;
        updateTitleVisibility();
        int token = ++controlTransitionToken;
        controls.animate().cancel();
        miniProgress.animate().cancel();
        controls.setVisibility(View.VISIBLE);
        controls.setAlpha(0);
        SeekBar target = visibleSeekBar();
        target.setAlpha(0);
        miniProgress.setVisibility(View.VISIBLE);
        resetMiniTransform();
        miniProgress.post(() -> {
            if (token != controlTransitionToken || !controlsShown) return;
            updateMiniProgressFill();
            if (!ValueAnimator.areAnimatorsEnabled()) {
                controls.setAlpha(1);
                target.setAlpha(1);
                miniProgress.setVisibility(View.GONE);
                return;
            }
            float[] geometry = miniToSeekGeometry(target);
            controls.animate().alpha(1).setDuration(230).start();
            miniProgress.animate().translationX(geometry[0]).translationY(geometry[1])
                    .scaleX(geometry[2]).scaleY(1.5f).setDuration(230)
                    .setInterpolator(new PathInterpolator(.2f, .75f, .2f, 1f))
                    .withEndAction(() -> {
                        if (token != controlTransitionToken || !controlsShown) return;
                        miniProgress.setVisibility(View.GONE);
                        resetMiniTransform();
                        target.setAlpha(1);
                    }).start();
        });
    }

    private void concealControls() {
        if (tvMode) return;
        if (seasonEnded) return;
        if (!controlsShown) return;
        controlsShown = false;
        updateTitleVisibility();
        int token = ++controlTransitionToken;
        handler.removeCallbacks(hideControls);
        handler.removeCallbacks(hideCenterToggle);
        centerToggle.setVisibility(View.GONE);
        controls.animate().cancel();
        miniProgress.animate().cancel();
        controls.setVisibility(View.VISIBLE);
        controls.setAlpha(1);
        SeekBar target = visibleSeekBar();
        target.setAlpha(0);
        miniProgress.setVisibility(View.VISIBLE);
        miniProgress.post(() -> {
            if (token != controlTransitionToken || controlsShown) return;
            updateMiniProgressFill();
            float[] geometry = miniToSeekGeometry(target);
            miniProgress.setTranslationX(geometry[0]);
            miniProgress.setTranslationY(geometry[1]);
            miniProgress.setScaleX(geometry[2]);
            miniProgress.setScaleY(1.5f);
            if (!ValueAnimator.areAnimatorsEnabled()) {
                resetMiniTransform();
                controls.setVisibility(View.INVISIBLE);
                target.setAlpha(1);
                return;
            }
            controls.animate().alpha(0).setDuration(180).start();
            miniProgress.animate().translationX(0).translationY(0).scaleX(1).scaleY(1)
                    .setDuration(220).setInterpolator(new PathInterpolator(.2f, .75f, .2f, 1f))
                    .withEndAction(() -> {
                        if (token != controlTransitionToken || controlsShown) return;
                        controls.setVisibility(View.INVISIBLE);
                        controls.setAlpha(1);
                        target.setAlpha(1);
                    }).start();
        });
    }

    private void revealControls() {
        if (controls == null) return;
        if (tvMode) { showTvInfo(); return; }
        if (!controlsShown) showControlsTransition();
        else controls.setVisibility(View.VISIBLE);
        updateTitleVisibility();
        if (centerToggle != null && loading.getVisibility() != View.VISIBLE && player != null && !player.isPlaying()) {
            centerToggle.setVisibility(View.VISIBLE);
            handler.removeCallbacks(hideCenterToggle);
            handler.postDelayed(hideCenterToggle, 3000);
        } else if (centerToggle != null) centerToggle.setVisibility(View.GONE);
        handler.removeCallbacks(hideControls);
        if (seasonEnded) { centerToggle.setVisibility(View.GONE); return; }
        if (!episodesOpen && !seeking && gestureMode != GESTURE_HOLD && speedPanel == null)
            handler.postDelayed(hideControls, 3000);
    }

    private final Runnable hideControls = () -> {
        if (tvMode) return;
        if (controls != null && !seasonEnded && !seeking && gestureMode != GESTURE_HOLD && speedPanel == null)
            concealControls();
    };
    private final Runnable hideCenterToggle = () -> { if (centerToggle != null) centerToggle.setVisibility(View.GONE); };

    private void toast(String text) {
        LinearLayout bubble = new LinearLayout(this);
        bubble.setGravity(Gravity.CENTER_VERTICAL);
        bubble.setPadding(dp(13), dp(9), dp(13), dp(9));
        GradientDrawable box = background(0xF42A2D30, 8);
        box.setStroke(dp(1), 0xFF52585A);
        bubble.setBackground(box);
        View dot = new View(this);
        dot.setBackground(background(YELLOW, 4));
        bubble.addView(dot, new LinearLayout.LayoutParams(dp(8), dp(8)));
        TextView label = label(text, 13, Color.WHITE);
        LinearLayout.LayoutParams labelParams = new LinearLayout.LayoutParams(-2, -2);
        labelParams.leftMargin = dp(8);
        bubble.addView(label, labelParams);
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.CENTER_HORIZONTAL);
        params.topMargin = dp(32);
        root.addView(bubble, params);
        bubble.setAlpha(0);
        bubble.setTranslationY(-dp(12));
        bubble.animate().alpha(1).translationY(0).setDuration(220).start();
        handler.postDelayed(() -> bubble.animate().alpha(0).translationY(-dp(12)).setDuration(220)
                .withEndAction(() -> root.removeView(bubble)).start(), 2800);
    }

    private void saveProgress(boolean completed) {
        if (player == null || currentId == null || currentSource == null || player.getDuration() <= 0) return;
        try {
            JSONObject value = new JSONObject();
            value.put("id", currentId);
            value.put("episode", currentEpisode);
            value.put("episodeCount", episodes == null ? 0 : episodes.length());
            value.put("title", currentItem.optString("title"));
            value.put("cover", currentItem.optString("cover"));
            value.put("position", player.getCurrentPosition());
            value.put("duration", player.getDuration());
            value.put("completed", completed || player.getPlaybackState() == Player.STATE_ENDED);
            store.recordProgress(value);
            lastSaved = System.currentTimeMillis();
        } catch (Exception ignored) { }
    }

    @Override protected void onPause() {
        foreground = false;
        cancelPrefetch();
        switching = false;
        mediaLayer.animate().cancel();
        incoming.animate().cancel();
        mediaLayer.setTranslationY(0);
        incoming.setVisibility(View.GONE);
        handler.removeCallbacks(longPress);
        handler.removeCallbacks(singleTap);
        dragging = false;
        gestureMode = GESTURE_PENDING;
        if (speedHoldActive && !speedLocked) applyPlaybackSpeed(manualSpeed);
        speedHoldActive = false;
        closeSpeedPanel();
        stopSeekPreview();
        if (player != null) { saveProgress(false); player.pause(); }
        super.onPause();
    }

    @Override protected void onResume() {
        super.onResume();
        foreground = true;
        updateSystemBars();
        maybePrepareNext();
    }

    private void handlePlayerBack() {
        if (tvMode) {
            /* 面板 / 控件条先收，再退播放器 */
            if (tvEpPanel != null) { closeTvEpisodes(); showTvBar(); return; }
            if (tvBarShown) { hideTvBar(); return; }
            confirmExitPlayback();
            return;
        }
        if (fullscreenMode) {
            if (speedPanel != null) closeSpeedPanel();
            if (episodesOpen) closeEpisodes();
            setFullscreenMode(false);
        } else if (speedPanel != null) closeSpeedPanel();
        else if (episodesOpen) closeEpisodes();
        else finish();
    }

    /* ================= 电视端：只有遥控器 =================
       上 / 下 = 上一集 / 下一集
       左 / 右 = 后退 / 前进 10 秒（按住连发）
       确定    = 播放/暂停，顺便把标题浮现 3 秒
       返回    = 弹确认，确认后才退出
       画面上不常驻任何东西：控件栏、底部进度条都不要，只在按键后浮 3 秒标题。 */


    /* ================= 电视端：暂停后的控件条 =================
       播放中方向键仍是「左右拖进度 / 上下切集」，不弹控件；
       一旦暂停，方向键改为在控件条里走，确定键执行。 */

    private static final String[] TV_BAR_LABELS = {
            "播放/暂停", "上一集", "下一集", "选集", "倍速", "收藏"
    };

    private void buildTvBar() {
        if (!tvMode || tvBar != null) return;
        tvBar = new LinearLayout(this);
        tvBar.setOrientation(LinearLayout.HORIZONTAL);
        tvBar.setGravity(Gravity.CENTER);
        tvBar.setPadding(dp(44), dp(16), dp(44), dp(12));
        /* 贴底一条渐隐黑带，六个控件一字排开、均分宽度。
           以前是一块浮在画面下部的圆角卡片，两行八颗按钮，既挡画面又像设置面板。 */
        tvBar.setBackground(new GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP,
                new int[]{0xF2000000, 0x00000000}));
        for (int i = 0; i < TV_BAR_LABELS.length; i++) {
            final int index = i;
            TextView item = label(TV_BAR_LABELS[i], 16, Color.WHITE);
            item.setGravity(Gravity.CENTER);
            item.setTypeface(null, Typeface.BOLD);
            item.setClickable(true);
            item.setOnClickListener(v -> tvBarAction(index));
            LinearLayout.LayoutParams itemParams = new LinearLayout.LayoutParams(0, dp(50), 1f);
            itemParams.setMargins(dp(6), 0, dp(6), 0);
            tvBar.addView(item, itemParams);
            tvBarItems.add(item);
        }
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM);
        params.bottomMargin = navigationInsetBottom + dp(22);
        root.addView(tvBar, params);
        tvBar.setVisibility(View.GONE);
        paintTvBar();
    }

    private void paintTvBar() {
        for (int i = 0; i < tvBarItems.size(); i++) {
            TextView item = tvBarItems.get(i);
            boolean on = i == tvBarIndex;
            item.setBackground(background(on ? 0xFFFFFFFF : 0x00FFFFFF, 10));
            item.setTextColor(on ? 0xFF14181D : 0xFFF2F3F5);
            item.setScaleX(on ? 1.05f : 1f);
            item.setScaleY(on ? 1.05f : 1f);
        }
        if (tvBarItems.size() > 4) tvBarItems.get(4).setText("倍速 " + speedLabel(manualSpeed));
    }

    private void showTvBar() {
        if (tvBar == null) return;
        if (!tvBarShown) {
            tvBarIndex = 0;
            tvBarShown = true;
            paintTvBar();
            tvBar.setVisibility(View.VISIBLE);
            tvBar.setAlpha(0f);
            tvBar.animate().alpha(1f).setDuration(150).start();
        }
        /* 暂停时把进度线一起放出来：这时候用户需要知道播到哪儿 */
        if (miniProgress != null && miniProgress.getVisibility() != View.VISIBLE) {
            resetMiniTransform();
            miniProgress.setVisibility(View.VISIBLE);
            miniProgress.post(this::updateMiniProgressFill);
        }
        if (centerToggle != null && player != null && !player.isPlaying()) {
            centerToggle.setVisibility(View.VISIBLE);
        }
        /* 顶部时间常驻：控件条在的时候就一直显示，别用 toast 一下一下地弹 */
        if (tvClock != null) {
            tvClock.setText(player != null && player.getDuration() > 0
                    ? clock(player.getCurrentPosition()) + " / " + clock(player.getDuration()) : "");
            tvClock.setVisibility(View.VISIBLE);
        }
        tvInfoShown = true;
        handler.removeCallbacks(hideTvInfo);
        updateTitleVisibility();
    }

    private void hideTvBar() {
        tvBarShown = false;
        if (tvBar != null) tvBar.setVisibility(View.GONE);
        if (miniProgress != null) miniProgress.setVisibility(View.GONE);
        if (centerToggle != null) centerToggle.setVisibility(View.GONE);
        if (tvClock != null) tvClock.setVisibility(View.GONE);
        tvInfoShown = false;
        handler.removeCallbacks(hideTvInfo);
        updateTitleVisibility();
    }

    private void tvBarAction(int index) {
        switch (index) {
            case 0:
                tvTogglePlay();
                break;
            case 1:
                tvSwitchEpisode(-1);
                break;
            case 2:
                tvSwitchEpisode(1);
                break;
            case 3:
                showTvEpisodes();
                break;
            case 4: {
                float[] speeds = {1f, 1.25f, 1.5f, 2f, .75f};
                int at = 0;
                for (int i = 0; i < speeds.length; i++) if (Math.abs(speeds[i] - manualSpeed) < .01f) at = i;
                manualSpeed = speeds[(at + 1) % speeds.length];
                applyPlaybackSpeed(manualSpeed);
                paintTvBar();
                showTvInfo();
                break;
            }
            case 5:
                if (bookmarkButton != null) bookmarkButton.performClick();
                paintTvBar();
                break;
            default:
                break;
        }
    }

    private boolean tvBarKey(int code) {
        if (code == android.view.KeyEvent.KEYCODE_DPAD_LEFT) {
            if (tvBarIndex > 0) { tvBarIndex--; paintTvBar(); }
        } else if (code == android.view.KeyEvent.KEYCODE_DPAD_RIGHT) {
            if (tvBarIndex < tvBarItems.size() - 1) { tvBarIndex++; paintTvBar(); }
        } else if (code == android.view.KeyEvent.KEYCODE_DPAD_CENTER
                || code == android.view.KeyEvent.KEYCODE_ENTER
                || code == android.view.KeyEvent.KEYCODE_NUMPAD_ENTER) {
            tvBarAction(tvBarIndex);
        }
        return true;
    }

    /* ---------------- 选集：和详情页一样 20 集一组 ---------------- */

    private void showTvEpisodes() {
        if (episodes == null || episodes.length() == 0 || isAiQueue()) { toast("当前作品没有选集"); return; }
        hideTvBar();
        closeTvEpisodes();
        tvEpGroup = Math.max(0, (currentEpisode - 1) / TV_EP_PAGE);
        tvEpFocusArea = 1;   /* 打开先落在当前集那一格，不用再按一次下 */
        openTvEpPanel();
    }

    /* 面板只建一次：切分组只换网格内容，不整块拆了重挂。
       原来是每次切组 removeView + addView + 重新播入场动画，看起来就跟「重新打开」一样闪。 */
    private void openTvEpPanel() {
        tvEpGroups.clear();
        tvEpCells.clear();

        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(22), dp(20), dp(22), dp(20));
        GradientDrawable bg = background(0xF216181B, 20);
        bg.setStroke(dp(1), 0x33FFFFFF);
        panel.setBackground(bg);
        panel.setElevation(dp(24));
        panel.setClickable(true);

        int total = episodes.length();
        int groups = (total + TV_EP_PAGE - 1) / TV_EP_PAGE;

        TextView head = label("选集", 24, Color.WHITE);
        head.setTypeface(null, Typeface.BOLD);
        LinearLayout headRow = new LinearLayout(this);
        headRow.setGravity(Gravity.CENTER_VERTICAL);
        headRow.addView(head, new LinearLayout.LayoutParams(-2, -2));
        tvEpSub = label("", 14, 0xFFC9C4B8);
        headRow.addView(tvEpSub, new LinearLayout.LayoutParams(-2, -2));
        panel.addView(headRow, new LinearLayout.LayoutParams(-1, dp(40)));

        if (groups > 1) {
            LinearLayout groupRow = new LinearLayout(this);
            groupRow.setGravity(Gravity.CENTER_VERTICAL);
            for (int g = 0; g < groups; g++) {
                final int target = g;
                int from = g * TV_EP_PAGE + 1;
                int to = Math.min(total, (g + 1) * TV_EP_PAGE);
                TextView chip = label(from + "-" + to, 13, Color.WHITE);
                chip.setGravity(Gravity.CENTER);
                chip.setClickable(true);
                chip.setOnClickListener(v -> {
                    if (tvEpGroup == target) { tvEpFocusArea = 1; paintTvEp(); return; }
                    tvEpGroup = target;
                    tvEpFocusArea = 1;
                    fillTvEpPage();
                });
                LinearLayout.LayoutParams chipParams = new LinearLayout.LayoutParams(dp(88), dp(44));
                chipParams.setMargins(dp(4), dp(4), dp(4), dp(4));
                groupRow.addView(chip, chipParams);
                tvEpGroups.add(chip);
            }
            panel.addView(groupRow, new LinearLayout.LayoutParams(-1, dp(58)));
        } else {
            panel.addView(new View(this), new LinearLayout.LayoutParams(-1, dp(10)));
        }

        tvEpGrid = new android.widget.GridLayout(this);
        tvEpGrid.setColumnCount(8);
        for (int i = 0; i < TV_EP_PAGE; i++) {
            TextView cell = label("", 16, Color.WHITE);
            cell.setGravity(Gravity.CENTER);
            cell.setClickable(true);
            cell.setOnClickListener(v -> {
                Object tag = v.getTag();
                if (tag instanceof Integer) playTvEpisode((Integer) tag);
            });
            android.widget.GridLayout.LayoutParams cellParams = new android.widget.GridLayout.LayoutParams();
            cellParams.width = dp(88); cellParams.height = dp(58);
            cellParams.setMargins(dp(4), dp(4), dp(4), dp(4));
            tvEpGrid.addView(cell, cellParams);
            tvEpCells.add(cell);
        }
        panel.addView(tvEpGrid, new LinearLayout.LayoutParams(-2, -2));

        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER);
        root.addView(panel, params);
        tvEpPanel = panel;

        fillTvEpPage();
        panel.setAlpha(0f);
        panel.setScaleX(.94f);
        panel.setScaleY(.94f);
        panel.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(180).start();
    }

    /** 只换内容：副标题、芯片选中态、20 个格子的集号，面板本身和它的位置都不动。 */
    private void fillTvEpPage() {
        if (episodes == null) return;
        int total = episodes.length();
        int start = tvEpGroup * TV_EP_PAGE;
        int end = Math.min(total, start + TV_EP_PAGE);
        tvEpPageCount = Math.max(0, end - start);
        if (tvEpSub != null) {
            tvEpSub.setText("　第 " + (start + 1) + "-" + end + " 集 / 共 " + total + " 集");
        }
        for (int i = 0; i < tvEpCells.size(); i++) {
            TextView cell = tvEpCells.get(i);
            int index = start + i;
            if (index < end) {
                JSONObject item = episodes.optJSONObject(index);
                int number = item == null ? index + 1 : item.optInt("number", index + 1);
                cell.setText(String.valueOf(number));
                cell.setTag(number);
                cell.setVisibility(View.VISIBLE);
            } else {
                cell.setText("");
                cell.setTag(null);
                cell.setVisibility(View.INVISIBLE);
            }
        }
        tvEpIndex = (currentEpisode > start && currentEpisode <= end)
                ? currentEpisode - start - 1 : 0;
        paintTvEp();
    }

    private void paintTvEp() {
        for (int g = 0; g < tvEpGroups.size(); g++) {
            TextView chip = tvEpGroups.get(g);
            boolean on = g == tvEpGroup;
            boolean focused = on && tvEpFocusArea == 0;
            chip.setBackground(background(focused ? 0xFFFFFFFF : (on ? 0xFFC89B3C : 0x22FFFFFF), 10));
            chip.setTextColor(focused ? 0xFF14181D : (on ? 0xFF231A06 : 0xFFFFFFFF));
        }
        for (int i = 0; i < tvEpCells.size(); i++) {
            TextView cell = tvEpCells.get(i);
            if (i >= tvEpPageCount) {
                cell.setBackgroundColor(Color.TRANSPARENT);
                continue;
            }
            Object tag = cell.getTag();
            boolean playing = tag instanceof Integer && (Integer) tag == currentEpisode;
            boolean focused = i == tvEpIndex && tvEpFocusArea == 1;
            cell.setBackground(background(focused ? 0xFFFFFFFF : (playing ? 0xFFC89B3C : 0x22FFFFFF), 10));
            cell.setTextColor(focused ? 0xFF14181D : (playing ? 0xFF231A06 : 0xFFFFFFFF));
            cell.setScaleX(focused ? 1.08f : 1f);
            cell.setScaleY(focused ? 1.08f : 1f);
        }
    }

    private void playTvEpisode(int number) {
        int total = episodes == null ? 0 : episodes.length();
        closeTvEpisodes();
        if (total > 0) {
            if (number == currentEpisode) { hideTvBar(); return; }
            Selection target = new Selection(currentItem, queueIndex, number);
            switchTo(target);
        }
    }

    private void closeTvEpisodes() {
        if (tvEpPanel != null) { root.removeView(tvEpPanel); tvEpPanel = null; }
        tvEpGroups.clear();
        tvEpCells.clear();
        tvEpSub = null;
        tvEpGrid = null;
        tvEpPageCount = 0;
        tvEpFocusArea = 0;
    }

    private boolean tvEpKey(int code) {
        int columns = 8;
        if (tvEpFocusArea == 0) {
            if (code == android.view.KeyEvent.KEYCODE_DPAD_LEFT && tvEpGroup > 0) {
                tvEpGroup--;
                tvEpFocusArea = 0;
                fillTvEpPage();
            } else if (code == android.view.KeyEvent.KEYCODE_DPAD_RIGHT
                    && tvEpGroup < (episodes.length() + TV_EP_PAGE - 1) / TV_EP_PAGE - 1) {
                tvEpGroup++;
                tvEpFocusArea = 0;
                fillTvEpPage();
            } else if (code == android.view.KeyEvent.KEYCODE_DPAD_DOWN
                    || code == android.view.KeyEvent.KEYCODE_DPAD_CENTER
                    || code == android.view.KeyEvent.KEYCODE_ENTER) {
                tvEpFocusArea = 1;
                tvEpIndex = 0;
                paintTvEp();
            }
            return true;
        }
        if (code == android.view.KeyEvent.KEYCODE_DPAD_LEFT) {
            if (tvEpIndex > 0) tvEpIndex--;
        } else if (code == android.view.KeyEvent.KEYCODE_DPAD_RIGHT) {
            if (tvEpIndex < tvEpPageCount - 1) tvEpIndex++;
        } else if (code == android.view.KeyEvent.KEYCODE_DPAD_UP) {
            if (tvEpIndex >= columns) tvEpIndex -= columns;
            else if (!tvEpGroups.isEmpty()) { tvEpFocusArea = 0; }
        } else if (code == android.view.KeyEvent.KEYCODE_DPAD_DOWN) {
            if (tvEpIndex + columns < tvEpPageCount) tvEpIndex += columns;
        } else if (code == android.view.KeyEvent.KEYCODE_DPAD_CENTER
                || code == android.view.KeyEvent.KEYCODE_ENTER
                || code == android.view.KeyEvent.KEYCODE_NUMPAD_ENTER) {
            if (tvEpIndex >= 0 && tvEpIndex < tvEpPageCount) {
                Object tag = tvEpCells.get(tvEpIndex).getTag();
                if (tag instanceof Integer) playTvEpisode((Integer) tag);
            }
            return true;
        }
        paintTvEp();
        return true;
    }

    private void showTvInfo() {
        if (!tvMode) return;
        tvInfoShown = true;
        updateTitleVisibility();
        handler.removeCallbacks(hideTvInfo);
        handler.postDelayed(hideTvInfo, 3200);
    }

    private void tvTogglePlay() {
        if (player == null) return;
        boolean next = !player.getPlayWhenReady();
        player.setPlayWhenReady(next);
        if (next) hideTvBar(); else showTvBar();
        showTvInfo();
    }

    private void tvSwitchEpisode(int direction) {
        if (switching) return;
        Selection item = adjacent(direction);
        if (item == null) {
            toast(direction > 0 ? "已经是最后一集" : "已经是第一集");
            return;
        }
        animateSwitch(item, direction);
        showTvInfo();
    }

    private void tvSeekBy(long delta) {
        if (player == null || player.getDuration() <= 0) return;
        long target = Math.max(0, Math.min(player.getDuration() - 1000, player.getCurrentPosition() + delta));
        player.seekTo(target);
        showTvInfo();
    }

    private void confirmExitPlayback() {
        if (exitDialog != null && exitDialog.isShowing()) return;
        exitDialog = VeyraDialog.confirm(this, "退出播放", "确定要退出当前剧集吗？",
                "退出", "继续观看", this::finish);
        exitDialog.setOnDismissListener(dialog -> exitDialog = null);
        exitDialog.show();
    }

    @Override public boolean dispatchKeyEvent(android.view.KeyEvent event) {
        if (tvMode) return dispatchTvKey(event);
        return super.dispatchKeyEvent(event);
    }

    private boolean dispatchTvKey(android.view.KeyEvent event) {
        int code = event.getKeyCode();
        int action = event.getAction();

        if (action == android.view.KeyEvent.ACTION_DOWN) {
            /* 返回键必须排在面板前面：面板原来把 BACK 一起吃了，
               于是弹窗关不掉、人也退不出去。先收面板，再收控件条，都没有才走退出确认。 */
            if (code == android.view.KeyEvent.KEYCODE_BACK
                    || code == android.view.KeyEvent.KEYCODE_ESCAPE) {
                if (tvEpPanel != null) { closeTvEpisodes(); showTvBar(); return true; }
                if (tvBarShown) { hideTvBar(); return true; }
                return super.dispatchKeyEvent(event);
            }
            /* 选集面板 / 暂停控件条优先吃按键，别让方向键漏到下面的快进、切集 */
            if (tvEpPanel != null) return tvEpKey(code);
            if (tvBarShown) return tvBarKey(code);
            boolean paused = player != null && player.getPlaybackState() == Player.STATE_READY
                    && !player.getPlayWhenReady();
            boolean direction = code == android.view.KeyEvent.KEYCODE_DPAD_UP
                    || code == android.view.KeyEvent.KEYCODE_DPAD_DOWN
                    || code == android.view.KeyEvent.KEYCODE_DPAD_LEFT
                    || code == android.view.KeyEvent.KEYCODE_DPAD_RIGHT;
            /* 暂停时方向键用来选控件，不拖进度也不切集 */
            if (paused && direction) { showTvBar(); return true; }
            switch (code) {
                case android.view.KeyEvent.KEYCODE_DPAD_CENTER:
                case android.view.KeyEvent.KEYCODE_ENTER:
                case android.view.KeyEvent.KEYCODE_NUMPAD_ENTER:
                case android.view.KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
                    if (event.getRepeatCount() == 0) tvTogglePlay();
                    return true;
                case android.view.KeyEvent.KEYCODE_DPAD_UP:
                case android.view.KeyEvent.KEYCODE_CHANNEL_UP:
                case android.view.KeyEvent.KEYCODE_MEDIA_PREVIOUS:
                    if (event.getRepeatCount() == 0) tvSwitchEpisode(-1);
                    return true;
                case android.view.KeyEvent.KEYCODE_DPAD_DOWN:
                case android.view.KeyEvent.KEYCODE_CHANNEL_DOWN:
                case android.view.KeyEvent.KEYCODE_MEDIA_NEXT:
                    if (event.getRepeatCount() == 0) tvSwitchEpisode(1);
                    return true;
                case android.view.KeyEvent.KEYCODE_DPAD_LEFT:
                    tvSeekBy(-10_000L);
                    return true;
                case android.view.KeyEvent.KEYCODE_DPAD_RIGHT:
                    tvSeekBy(10_000L);
                    return true;
                default:
                    break;
            }
        }
        return super.dispatchKeyEvent(event);
    }

    @Override public void onBackPressed() {
        handlePlayerBack();
    }

    @Override protected void onDestroy() {
        destroyed = true;
        if (sequelTask != null) sequelTask.cancel(true);
        ++loadToken;
        cancelPrefetch();
        stopSeekPreview();
        prefetchWorker.shutdownNow();
        if (Build.VERSION.SDK_INT >= 33 && backCallback != null)
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
        handler.removeCallbacksAndMessages(null);
        worker.shutdownNow();
        if (player != null) player.release();
        super.onDestroy();
    }
}
