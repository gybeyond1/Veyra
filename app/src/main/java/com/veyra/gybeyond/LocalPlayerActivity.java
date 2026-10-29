package com.veyra.gybeyond;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.Player;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.Collections;
import java.util.Locale;

/**
 * 本地成品播放器：播 Download/Veyra/&lt;剧名&gt; 下已下载/已合并的 mp4；NAS 模式流播 NAS 成品。
 *
 * UI 与在线 PlayerActivity（正常刷短剧）对齐：
 *  - 顶部：返回 + 剧名 · 第N集（共X集）；
 *  - 底部圆角控制栏：播放/暂停、上一集、下一集、时间/时长、倍速、选集；细进度条在栏上方；
 *  - 点画面显隐控制栏（3 秒自动隐藏）；
 *  - 上/下滑跟手切集（当前层平移 + 相邻集预览 + 阈值切换/回弹），播完自动连播；
 *  - 已合并的整剧播合并产物（整集，无切集）。
 * NAS 模式（nasMode=true）：带 Bearer 鉴权流式播 NAS 成品（合并产物优先，404 回退逐集）。
 */
public final class LocalPlayerActivity extends Activity {

    private ExoPlayer player;
    private PlayerView view;
    private FrameLayout root;
    private FrameLayout mediaLayer;
    private FrameLayout incoming;
    private TextView incomingLabel;
    private FrameLayout topBar;
    private View bottomBar, progressLine;
    private TextView titleView;
    private ImageButton playPauseBtn, prevBtn, nextBtn;
    private TextView timeView, speedBtn, episodesBtn;
    private SeekBar seekBar;
    private LinearLayout episodePanel;
    private View episodeScrim;
    private FrameLayout.LayoutParams panelParams;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private JSONArray episodes = new JSONArray();
    private int index = 0;
    private boolean merged = false;
    private boolean nasMode = false;
    private String auth = "";
    private String title = "";
    private float manualSpeed = 1f;
    private static final float[] SPEEDS = {0.75f, 1f, 1.25f, 1.5f, 2f, 3f};

    // ---- 竖滑切集手势 ----
    private static final int GESTURE_PENDING = 0, GESTURE_VERTICAL = 2;
    private int gestureMode = GESTURE_PENDING;
    private boolean dragging = false;
    private boolean switching = false;
    private boolean controlsVisible = true;
    private float touchStartX, touchStartY;
    private float dragY;
    private int incomingDirection = 0;
    private long lastToastAt = 0;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        hideSystemBars();

        title = getIntent().getStringExtra("title");
        String path = getIntent().getStringExtra("path");
        merged = getIntent().getBooleanExtra("merged", false);
        nasMode = getIntent().getBooleanExtra("nasMode", false);
        auth = getIntent().getStringExtra("auth");
        String raw = getIntent().getStringExtra("episodes");
        try { if (raw != null && !raw.isEmpty()) episodes = new JSONArray(raw); } catch (Exception ignored) { }

        boolean isLocal = !nasMode;
        if (isLocal) {
            String resolved = resolveLocalPath(path);
            if (resolved == null) {
                Toast.makeText(this, "本地文件不存在或不可读，可能已被删除", Toast.LENGTH_LONG).show();
                finish();
                return;
            }
            path = resolved;
        }
        if (nasMode && (path == null || path.isEmpty())) {
            Toast.makeText(this, "NAS 播放地址无效", Toast.LENGTH_LONG).show();
            finish();
            return;
        }

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        root.setFitsSystemWindows(true);

        // 播放器层（竖滑时整体平移）
        mediaLayer = new FrameLayout(this);
        view = new PlayerView(this);
        view.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT);
        view.setUseController(false);   // 控制权交给自己的顶栏/底栏（与在线播放器一致）
        mediaLayer.addView(view, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));
        root.addView(mediaLayer, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        // 相邻集预览层（竖滑时从屏幕外跟手滑入）
        incoming = new FrameLayout(this);
        incoming.setBackgroundColor(Color.BLACK);
        incoming.setVisibility(View.GONE);
        incomingLabel = new TextView(this);
        incomingLabel.setTextColor(Color.WHITE);
        incomingLabel.setTextSize(15f);
        incomingLabel.setGravity(Gravity.CENTER);
        incoming.addView(incomingLabel, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
        root.addView(incoming, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        buildTopBar();
        buildBottomBar();

        ExoPlayer.Builder builder = new ExoPlayer.Builder(this);
        if (nasMode) {
            DefaultHttpDataSource.Factory httpFactory = new DefaultHttpDataSource.Factory()
                    .setAllowCrossProtocolRedirects(true)
                    .setConnectTimeoutMs(10000)
                    .setReadTimeoutMs(30000);
            if (auth != null && !auth.isEmpty())
                httpFactory.setDefaultRequestProperties(Collections.singletonMap("Authorization", "Bearer " + auth));
            builder.setMediaSourceFactory(new DefaultMediaSourceFactory(httpFactory));
        }
        player = builder.build();
        view.setPlayer(player);
        player.addListener(new Player.Listener() {
            @Override public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_ENDED) advance(1);
                if (state == Player.STATE_READY) refreshTime();
            }
            @Override public void onIsPlayingChanged(boolean playing) {
                playPauseBtn.setImageResource(playing ? R.drawable.player_pause : R.drawable.player_play);
            }
            @Override public void onPlayerError(androidx.media3.common.PlaybackException error) {
                // NAS 模式首播失败：合并产物可能不存在（任务未合并）→ 回退第 1 集逐集播
                if (nasMode && index == 0 && merged && episodes.length() > 0) {
                    merged = false;
                    prevBtn.setVisibility(View.VISIBLE);
                    JSONObject ep = episodes.optJSONObject(0);
                    String url = ep == null ? "" : ep.optString("url", "");
                    if (!url.isEmpty()) { play(url, false); revealControls(); return; }
                }
                toast("播放失败：" + error.getMessage());
            }
        });
        play(path, true);
        setContentView(root);

        root.setOnTouchListener((target, event) -> handleGesture(event));
        showControls();
    }

    // ---- UI 构建 ----

    private TextView label(String text, float size, int color) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextColor(color);
        tv.setTextSize(size);
        return tv;
    }

    private GradientDrawable background(int color, int radiusDp) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(dp(radiusDp));
        return d;
    }

    private void buildTopBar() {
        topBar = new FrameLayout(this);
        GradientDrawable bg = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                new int[]{0xAA000000, 0x00000000});
        topBar.setBackground(bg);
        topBar.setPadding(dp(10), dp(14), dp(16), dp(26));
        topBar.setClickable(true);

        ImageButton back = new ImageButton(this);
        back.setImageResource(R.drawable.player_back);
        back.setBackground(null);
        back.setPadding(dp(8), dp(8), dp(8), dp(8));
        back.setOnClickListener(v -> finish());
        topBar.addView(back, new FrameLayout.LayoutParams(dp(42), dp(42), Gravity.START | Gravity.CENTER_VERTICAL));

        titleView = label("", 15f, Color.WHITE);
        titleView.setSingleLine(true);
        titleView.setPadding(dp(56), dp(12), dp(8), 0);
        topBar.addView(titleView, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER_VERTICAL));

        root.addView(topBar, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP));
    }

    private void buildBottomBar() {
        LinearLayout zone = new LinearLayout(this);
        zone.setOrientation(LinearLayout.VERTICAL);
        zone.setGravity(Gravity.BOTTOM);

        // 细进度条（栏上方）
        progressLine = new SeekBar(this);
        ((SeekBar) progressLine).setMax(1000);
        ((SeekBar) progressLine).setProgress(0);
        ((SeekBar) progressLine).setThumb(null);
        ((SeekBar) progressLine).setProgressTintList(android.content.res.ColorStateList.valueOf(0xFFE8C268));
        ((SeekBar) progressLine).setProgressBackgroundTintList(android.content.res.ColorStateList.valueOf(0x66FFFFFF));
        ((SeekBar) progressLine).setPadding(0, 0, 0, 0);
        zone.addView(progressLine, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(10)));

        // 圆角控制栏
        LinearLayout bar = new LinearLayout(this);
        bottomBar = bar;
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackground(background(0xE622201E, 14));
        int h = dp(14);
        bar.setPadding(h, dp(6), h, dp(6));
        bar.setClickable(true);

        playPauseBtn = icon(R.drawable.player_pause, v -> {
            if (player != null) player.setPlayWhenReady(!player.getPlayWhenReady());
        });
        bar.addView(playPauseBtn, barLp());

        prevBtn = icon(R.drawable.player_next, v -> advance(-1));
        if (merged) prevBtn.setVisibility(View.GONE);
        prevBtn.setRotation(180f);
        bar.addView(prevBtn, barLp());

        nextBtn = icon(R.drawable.player_next, v -> advance(1));
        bar.addView(nextBtn, barLp());

        timeView = label("00:00 / 00:00", 12f, 0xFFC9C4B8);
        timeView.setPadding(dp(8), 0, dp(4), 0);
        bar.addView(timeView, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        speedBtn = label("1×", 13f, Color.WHITE);
        speedBtn.setGravity(Gravity.CENTER);
        speedBtn.setOnClickListener(v -> {
            int next = 0;
            for (int i = 0; i < SPEEDS.length; i++) if (SPEEDS[i] == manualSpeed) { next = (i + 1) % SPEEDS.length; break; }
            manualSpeed = SPEEDS[next];
            if (player != null) player.setPlaybackParameters(new androidx.media3.common.PlaybackParameters(manualSpeed));
            speedBtn.setText(speedLabel(manualSpeed));
        });
        bar.addView(speedBtn, barLp());

        episodesBtn = label("选集", 13f, Color.WHITE);
        episodesBtn.setGravity(Gravity.CENTER);
        episodesBtn.setPadding(dp(10), 0, dp(10), 0);
        episodesBtn.setOnClickListener(v -> toggleEpisodes());
        bar.addView(episodesBtn, barLp());

        zone.addView(bar, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));
        int m = dp(10);
        zone.setPadding(m, 0, m, dp(18));

        root.addView(zone, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM));

        seekBar = (SeekBar) progressLine;
        seekBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar s, int p, boolean fromUser) {
                if (fromUser && player != null && player.getDuration() > 0)
                    player.seekTo((long) (p / 1000.0 * player.getDuration()));
            }
            @Override public void onStartTrackingTouch(SeekBar s) { revealControls(); }
            @Override public void onStopTrackingTouch(SeekBar s) { revealControls(); }
        });
    }

    private ImageButton icon(int res, View.OnClickListener l) {
        ImageButton b = new ImageButton(this);
        b.setImageResource(res);
        b.setBackground(null);
        b.setPadding(dp(6), dp(6), dp(6), dp(6));
        b.setOnClickListener(l);
        return b;
    }

    private LinearLayout.LayoutParams barLp() {
        return new LinearLayout.LayoutParams(dp(38), dp(38));
    }

    private String speedLabel(float s) {
        return s == (long) s ? String.format(Locale.US, "%d×", (long) s) : String.format(Locale.US, "%.2f×", s).replaceAll("0×$", "×");
    }

    private void toggleEpisodes() {
        if (merged) { toast("整集合并版没有分集"); return; }
        if (episodes.length() == 0) { toast("本剧没有选集"); return; }
        if (episodePanel != null) { closeEpisodes(); return; }
        revealControls();

        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(14), dp(12), dp(14), dp(12));
        panel.setBackground(background(0xF0242320, 12));
        panel.setElevation(dp(14));
        panel.setClickable(true);

        TextView heading = label("选集", 16f, Color.WHITE);
        heading.setTypeface(null, android.graphics.Typeface.BOLD);
        panel.addView(heading, new LinearLayout.LayoutParams(-1, dp(30)));

        ScrollView scroll = new ScrollView(this);
        android.widget.GridLayout grid = new android.widget.GridLayout(this);
        grid.setColumnCount(5);
        for (int i = 0; i < episodes.length(); i++) {
            final int n = i;
            TextView btn = label(String.valueOf(i + 1), 13f, i == index ? Color.BLACK : Color.WHITE);
            btn.setGravity(Gravity.CENTER);
            btn.setBackground(background(i == index ? 0xFFE8C268 : 0xFF373D40, 9));
            android.widget.GridLayout.LayoutParams p = new android.widget.GridLayout.LayoutParams();
            p.width = dp(46); p.height = dp(40);
            p.setMargins(dp(3), dp(3), dp(3), dp(3));
            grid.addView(btn, p);
            btn.setOnClickListener(v -> {
                closeEpisodes();
                if (n == index) return;
                String src = epSource(n);
                if (src == null) { toast("第 " + (n + 1) + " 集文件不可读"); return; }
                index = n;
                play(src, false);
                refreshTitle();
            });
        }
        scroll.addView(grid);
        panel.addView(scroll, new LinearLayout.LayoutParams(-1, dp(236)));

        episodeScrim = new View(this);
        episodeScrim.setOnClickListener(v -> closeEpisodes());
        root.addView(episodeScrim, new FrameLayout.LayoutParams(-1, -1));
        panelParams = new FrameLayout.LayoutParams(dp(268), -2, Gravity.BOTTOM | Gravity.END);
        panelParams.bottomMargin = dp(78);
        panelParams.rightMargin = dp(10);
        root.addView(panel, panelParams);
        episodePanel = panel;
    }

    private void closeEpisodes() {
        if (episodePanel == null) return;
        root.removeView(episodePanel);
        root.removeView(episodeScrim);
        episodePanel = null;
        episodeScrim = null;
    }

    // ---- 播放控制 ----

    private void play(String pathOrUrl, boolean first) {
        Uri uri = pathOrUrl.startsWith("http") ? Uri.parse(pathOrUrl) : Uri.fromFile(new File(pathOrUrl));
        MediaItem item = new MediaItem.Builder().setUri(uri).setMimeType(MimeTypes.VIDEO_MP4).build();
        player.setMediaItem(item);
        player.prepare();
        player.setPlayWhenReady(true);
        player.setPlaybackParameters(new androidx.media3.common.PlaybackParameters(manualSpeed));
        refreshTitle();
    }

    private void refreshTitle() {
        String base = title == null || title.isEmpty() ? "本地播放" : title;
        if (merged) {
            titleView.setText(base + " · 整集合并版");
            return;
        }
        titleView.setText(base + " · 第 " + (index + 1) + " 集（共 " + episodes.length() + " 集）");
    }

    private void refreshTime() {
        if (player == null) return;
        long cur = Math.max(0, player.getCurrentPosition());
        long dur = Math.max(0, player.getDuration());
        timeView.setText(String.format(Locale.US, "%s / %s", mmss(cur), mmss(dur)));
        if (dur > 0 && !seekBar.isPressed())
            seekBar.setProgress((int) Math.min(1000, cur * 1000 / dur));
    }

    private static String mmss(long ms) {
        long s = ms / 1000;
        return String.format(Locale.US, "%d:%02d", s / 60, s % 60);
    }

    /** 分集播放：播完自动连播。合并版没有下一集。 */
    private void advance(int delta) {
        if (merged || episodes.length() == 0) {
            if (merged) toastOnce("整集合并版没有分集，拖进度条即可");
            return;
        }
        int next = index + delta;
        if (next < 0) next = 0;
        if (next >= episodes.length()) {
            toastOnce("已播完最后一集");
            return;
        }
        String src = epSource(next);
        if (src == null) { toast("第 " + (next + 1) + " 集文件不可读"); return; }
        index = next;
        play(src, false);
        revealControls();
    }

    /** 本地分集路径解析：精确文件不可读时，按「第NN集」前缀在同目录模糊匹配
     *  （兼容 ROM 的 MediaStore 给文件名加时间戳尾巴导致的漂移，避免漏集）。 */
    private String resolveLocalPath(String expected) {
        if (expected == null || expected.isEmpty()) return null;
        File f = new File(expected);
        if (f.canRead()) return expected;
        File dir = f.getParentFile();
        if (dir == null || !dir.isDirectory()) return null;
        String name = f.getName();
        java.util.regex.Matcher pm = java.util.regex.Pattern.compile("^(第\\d+集)").matcher(name);
        String prefix = pm.find() ? pm.group(1) : null;
        File best = null;
        long bestTime = -1;
        File[] kids = dir.listFiles();
        if (kids == null) return null;
        for (File c : kids) {
            if (!c.isFile() || !c.canRead()) continue;
            if (c.getName().equals(name)) { best = c; bestTime = c.lastModified(); break; }
            if (prefix != null && c.getName().startsWith(prefix) && c.getName().endsWith(".mp4")) {
                long t = c.lastModified();
                if (best == null || t > bestTime) { best = c; bestTime = t; }
            }
        }
        return best != null ? best.getAbsolutePath() : null;
    }

    private String epSource(int i) {
        JSONObject ep = episodes.optJSONObject(i);
        String s = ep == null ? "" : ep.optString(nasMode ? "url" : "path", "");
        if (nasMode) return s.isEmpty() ? null : s;
        if (s.isEmpty()) return null;
        return resolveLocalPath(s);
    }

    // ---- 控制栏显隐 ----

    private final Runnable hideControls = () -> {
        if (episodePanel != null || !controlsVisible) return;
        controlsVisible = false;
        topBar.animate().alpha(0).setDuration(200).start();
        bottomBar.animate().alpha(0).setDuration(200).start();
        seekBar.animate().alpha(0).setDuration(200).start();
    };

    private void showControls() {
        controlsVisible = true;
        topBar.animate().alpha(1).setDuration(180).start();
        bottomBar.animate().alpha(1).setDuration(180).start();
        seekBar.animate().alpha(1).setDuration(180).start();
        handler.removeCallbacks(hideControls);
        handler.postDelayed(hideControls, 3200);
    }

    private void revealControls() { showControls(); }

    // ---- 竖滑切集：跟手平移 + 相邻集预览 + 阈值切换/回弹 ----

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    private String epLabel(int i) {
        String base = title == null || title.isEmpty() ? "本剧" : title;
        return base + " · 第" + String.format(Locale.US, "%02d", i + 1) + "集";
    }

    private boolean handleGesture(MotionEvent event) {
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                if (switching) return true;
                mediaLayer.animate().cancel();
                incoming.animate().cancel();
                touchStartX = event.getX();
                touchStartY = event.getY();
                dragY = 0;
                dragging = true;
                gestureMode = GESTURE_PENDING;
                return true;
            case MotionEvent.ACTION_MOVE: {
                if (!dragging) return true;
                float dx = event.getX() - touchStartX;
                float dy = event.getY() - touchStartY;
                if (gestureMode == GESTURE_PENDING) {
                    int slop = Math.max(dp(10), ViewConfiguration.get(this).getScaledTouchSlop());
                    if (Math.hypot(dx, dy) < slop) return true;
                    gestureMode = Math.abs(dx) > Math.abs(dy) ? GESTURE_PENDING : GESTURE_VERTICAL;
                    if (gestureMode != GESTURE_VERTICAL) { dragging = false; return true; }
                }
                if (gestureMode != GESTURE_VERTICAL) return true;
                dragY = Math.max(-root.getHeight(), Math.min(root.getHeight(), event.getY() - touchStartY));
                int direction = dragY < 0 ? 1 : -1;
                int target = index + direction;
                String src = (!merged && episodes.length() > 0 && target >= 0 && target < episodes.length())
                        ? epSource(target) : null;
                mediaLayer.setTranslationY(dragY);
                if (src != null) {
                    if (incoming.getVisibility() != View.VISIBLE || incomingDirection != direction) {
                        incomingDirection = direction;
                        incomingLabel.setText(epLabel(target));
                        incoming.setTranslationY(direction > 0 ? root.getHeight() : -root.getHeight());
                        incoming.setVisibility(View.VISIBLE);
                    }
                    incoming.setTranslationY((direction > 0 ? root.getHeight() : -root.getHeight()) + dragY);
                } else incoming.setVisibility(View.GONE);
                return true;
            }
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL: {
                if (!dragging) return true;
                dragging = false;
                boolean cancelled = event.getActionMasked() == MotionEvent.ACTION_CANCEL;
                if (gestureMode != GESTURE_VERTICAL) {
                    gestureMode = GESTURE_PENDING;
                    if (!cancelled) showControls();   // 轻点画面：显隐控制栏
                    else showControls();
                    return true;
                }
                gestureMode = GESTURE_PENDING;
                int moveDirection = dragY < 0 ? 1 : -1;
                int target = index + moveDirection;
                String src = (!merged && episodes.length() > 0 && target >= 0 && target < episodes.length())
                        ? epSource(target) : null;
                if (!cancelled && Math.abs(dragY) > Math.max(dp(76), root.getHeight() * 0.12f) && src != null) {
                    switching = true;
                    int height = root.getHeight();
                    if (player != null) player.pause();
                    final String nextSrc = src;
                    final int nextIndex = target;
                    mediaLayer.animate().translationY(moveDirection > 0 ? -height : height).setDuration(260).start();
                    incoming.animate().translationY(0).setDuration(260).withEndAction(() -> {
                        index = nextIndex;
                        play(nextSrc, false);
                        mediaLayer.setTranslationY(0);
                        mediaLayer.animate().setDuration(1).withEndAction(() -> switching = false).start();
                        incoming.setVisibility(View.GONE);
                        showControls();
                    }).start();
                } else {
                    mediaLayer.animate().translationY(0).setDuration(220).start();
                    incoming.animate().translationY(moveDirection > 0 ? root.getHeight() : -root.getHeight())
                            .setDuration(220).withEndAction(() -> incoming.setVisibility(View.GONE)).start();
                    if (!cancelled && Math.abs(dragY) > dp(76)) {
                        if (merged) toastOnce("整集合并版没有分集");
                        else if (moveDirection > 0) toastOnce("已经是最后一集");
                        else toastOnce("已经是第一集");
                    }
                    showControls();
                }
                return true;
            }
        }
        return true;
    }

    private void toast(String msg) { Toast.makeText(this, msg, Toast.LENGTH_SHORT).show(); }

    private void toastOnce(String msg) {
        long now = System.currentTimeMillis();
        if (now - lastToastAt < 1200) return;
        lastToastAt = now;
        toast(msg);
    }

    @Override public boolean onTouchEvent(MotionEvent event) { return handleGesture(event) || super.onTouchEvent(event); }

    @Override protected void onResume() {
        super.onResume();
        if (player != null) player.setPlayWhenReady(true);
        hideSystemBars();
        handler.post(tick);
    }
    @Override protected void onPause() { super.onPause(); if (player != null) player.setPlayWhenReady(false); }

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (player != null) refreshTime();
            handler.postDelayed(this, 500);
        }
    };

    @Override protected void onDestroy() {
        super.onDestroy();
        handler.removeCallbacksAndMessages(null);
        if (view != null) view.setPlayer(null);
        if (player != null) player.release();
        player = null;
    }

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }
}
