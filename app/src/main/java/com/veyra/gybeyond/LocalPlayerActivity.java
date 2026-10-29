package com.veyra.gybeyond;

import android.app.Activity;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
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

/**
 * 本地成品播放器：直接播 Download/Veyra/&lt;剧名&gt; 下已下载/已合并的 mp4，不走后端取址。
 *
 * 与在线 PlayerActivity 完全隔离（新类，不改在线播放链路），只服务「我的下载」点封面本机直看：
 *  - 合并好的整集（剧名.mp4）：单文件播放；
 *  - 未合并的分集（第NN集.mp4）：一集一个文件，播完自动接下一集，与在线播放一致的上/下滑切集
 *    （跟手平移 + 相邻集预览 + 松手阈值切换/回弹），底部按钮保留。
 *  - NAS 模式（nasMode=true）：不播本地文件，改为带 Bearer 鉴权流式播 NAS 上的成品
 *    （合并产物 files/{id}/0 优先，404 自动回退逐集 files/{id}/1..N）。
 * 内容模式隔离由 DownloadManager.localFiles 兜底（切换过模式会直接抛错，拿不到对方文件）。
 */
public final class LocalPlayerActivity extends Activity {

    private ExoPlayer player;
    private PlayerView view;
    private TextView caption;
    private LinearLayout navRow;
    private FrameLayout root;
    private FrameLayout mediaLayer;
    private FrameLayout incoming;
    private TextView incomingLabel;
    private JSONArray episodes = new JSONArray();
    private int index = 0;
    private boolean merged = false;
    private boolean nasMode = false;
    private String auth = "";
    private String title = "";
    private Player.Listener endedListener;

    // ---- 竖滑切集手势（与在线 PlayerActivity 行为对齐：跟手平移 + 阈值切换/回弹）----
    private static final int GESTURE_PENDING = 0, GESTURE_VERTICAL = 2;
    private int gestureMode = GESTURE_PENDING;
    private boolean dragging = false;
    private boolean switching = false;
    private float touchStartX, touchStartY;
    private float dragY;
    private int incomingDirection = 0;

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
        if (isLocal && (path == null || path.isEmpty() || !new File(path).canRead())) {
            Toast.makeText(this, "本地文件不存在或不可读，可能已被删除", Toast.LENGTH_LONG).show();
            finish();
            return;
        }
        if (nasMode && (path == null || path.isEmpty())) {
            Toast.makeText(this, "NAS 播放地址无效", Toast.LENGTH_LONG).show();
            finish();
            return;
        }

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        root.setFitsSystemWindows(true);

        view = new PlayerView(this);
        view.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT);
        view.setUseController(true);
        // 播放器层包一层 mediaLayer：竖滑时整体平移，跟手
        mediaLayer = new FrameLayout(this);
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
        incomingLabel.setTextSize(14f);
        incomingLabel.setGravity(Gravity.CENTER);
        incoming.addView(incomingLabel, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
        root.addView(incoming, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        caption = new TextView(this);
        caption.setTextColor(Color.WHITE);
        caption.setTextSize(14f);
        caption.setPadding(40, 32, 40, 0);
        caption.setText(isLocal ? labelLocal(path) : labelNas(path));
        root.addView(caption, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT));

        if (!merged && episodes.length() > 1) {
            navRow = new LinearLayout(this);
            navRow.setOrientation(LinearLayout.HORIZONTAL);
            navRow.setGravity(Gravity.CENTER);
            navRow.setPadding(0, 0, 0, 48);
            Button prev = new Button(this);
            prev.setText("上一集");
            prev.setOnClickListener(v -> advance(-1));
            Button next = new Button(this);
            next.setText("下一集");
            next.setOnClickListener(v -> advance(1));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            lp.setMargins(24, 0, 24, 0);
            navRow.addView(prev, lp);
            navRow.addView(next, lp);
            FrameLayout.LayoutParams navLp = new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT);
            navLp.gravity = Gravity.BOTTOM;
            root.addView(navRow, navLp);
        }

        ExoPlayer.Builder builder = new ExoPlayer.Builder(this);
        if (nasMode) {
            // NAS 成品走 HTTP 流式 + Bearer 鉴权（sendFile 支持 Range，可拖进度条）
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
        endedListener = new Player.Listener() {
            @Override public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_ENDED) advance(1);
            }
        };
        play(path, true);
        setContentView(root);

        root.setOnTouchListener((target, event) -> handleGesture(event));
    }

    private String labelLocal(String path) {
        String file = new File(path).getName();
        String base = title == null || title.isEmpty() ? file : title;
        if (merged) return base + " · 整集合并版";
        return base + " · " + file.replace(".mp4", "") + "（共 " + episodes.length() + " 集）";
    }

    private String labelNas(String path) {
        String base = title == null || title.isEmpty() ? "NAS 下载" : title;
        // path 是合并产物 URL；播放的是第几集时 advance 会刷新标题
        return base + " · 整集合并版（NAS 流播）";
    }

    private void play(String pathOrUrl, boolean first) {
        if (player == null) return;
        Uri uri = pathOrUrl.startsWith("http") ? Uri.parse(pathOrUrl) : Uri.fromFile(new File(pathOrUrl));
        MediaItem item = new MediaItem.Builder()
                .setUri(uri)
                .setMimeType(MimeTypes.VIDEO_MP4)
                .build();
        if (first) {
            // NAS 模式：合并产物可能不存在（任务未合并）——首帧打不开就回退第 1 集逐集播
            player.addListener(new Player.Listener() {
                @Override public void onPlayerError(androidx.media3.common.PlaybackException error) {
                    player.removeListener(this);
                    if (nasMode && episodes.length() > 0) {
                        merged = false;
                        JSONObject ep = episodes.optJSONObject(0);
                        String url = ep == null ? "" : ep.optString("url", "");
                        if (!url.isEmpty()) {
                            index = 0;
                            caption.setText(title + " · 第01集（共 " + episodes.length() + " 集，NAS 流播）");
                            play(url, true);
                            return;
                        }
                    }
                    Toast.makeText(LocalPlayerActivity.this, "播放失败：" + error.getMessage(), Toast.LENGTH_LONG).show();
                }
            });
        }
        player.setMediaItem(item);
        player.prepare();
        player.setPlayWhenReady(true);
        if (endedListener != null) player.addListener(endedListener);
    }

    /** 分集播放：播完自动连播，上/下滑或底部按钮切集。合并版没有下一集。 */
    private void advance(int delta) {
        if (merged || episodes.length() == 0) {
            if (merged) Toast.makeText(this, "整集合并版没有分集，拖进度条即可", Toast.LENGTH_SHORT).show();
            return;
        }
        int next = index + delta;
        if (next < 0) next = 0;
        if (next >= episodes.length()) {
            Toast.makeText(this, "已播完最后一集", Toast.LENGTH_SHORT).show();
            return;
        }
        JSONObject ep = episodes.optJSONObject(next);
        String path = ep == null ? "" : ep.optString(nasMode ? "url" : "path", "");
        if (path.isEmpty() || (!nasMode && !new File(path).canRead())) {
            Toast.makeText(this, "第 " + (next + 1) + " 集文件不可读", Toast.LENGTH_LONG).show();
            return;
        }
        index = next;
        play(path, false);
        if (caption != null) caption.setText(nasMode
                ? title + " · 第" + String.format(java.util.Locale.US, "%02d", next + 1) + "集（共 " + episodes.length() + " 集，NAS 流播）"
                : labelLocal(path));
    }

    // ---- 竖滑切集：跟手平移当前层、相邻集预览层滑入，松手过阈值切换/不足回弹 ----

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    private String epLabel(int i) {
        String base = title == null || title.isEmpty() ? "本剧" : title;
        return base + " · 第" + String.format(java.util.Locale.US, "%02d", i + 1) + "集";
    }

    /** 目标集的播放地址；不可用返回 null。 */
    private String epSource(int i) {
        JSONObject ep = episodes.optJSONObject(i);
        String s = ep == null ? "" : ep.optString(nasMode ? "url" : "path", "");
        if (s.isEmpty() || (!nasMode && !new File(s).canRead())) return null;
        return s;
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
                        incoming.setTranslationY((direction > 0 ? root.getHeight() : -root.getHeight()));
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
                if (gestureMode != GESTURE_VERTICAL) { gestureMode = GESTURE_PENDING; return true; }
                gestureMode = GESTURE_PENDING;
                int moveDirection = dragY < 0 ? 1 : -1;
                int target = index + moveDirection;
                String src = (!merged && episodes.length() > 0 && target >= 0 && target < episodes.length())
                        ? epSource(target) : null;
                if (!cancelled && Math.abs(dragY) > Math.max(dp(76), root.getHeight() * 0.12f) && src != null) {
                    // 切换：当前层滑出、预览层滑入，动画结束真正换片源
                    switching = true;
                    int height = root.getHeight();
                    if (player != null) player.pause();
                    final String nextSrc = src;
                    final int nextIndex = target;
                    mediaLayer.animate().translationY(moveDirection > 0 ? -height : height).setDuration(260).start();
                    incoming.animate().translationY(0).setDuration(260).withEndAction(() -> {
                        index = nextIndex;
                        play(nextSrc, false);
                        if (caption != null) caption.setText(nasMode ? epLabel(nextIndex) + "（NAS 流播）" : labelLocal(nextSrc));
                        mediaLayer.setTranslationY(0);
                        mediaLayer.animate().setDuration(1).withEndAction(() -> switching = false).start();
                        incoming.setVisibility(View.GONE);
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
                }
                return true;
            }
        }
        return true;
    }

    private long lastToastAt = 0;
    private void toastOnce(String msg) {
        long now = System.currentTimeMillis();
        if (now - lastToastAt < 1200) return;
        lastToastAt = now;
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }

    @Override public boolean onTouchEvent(MotionEvent event) { return handleGesture(event) || super.onTouchEvent(event); }

    @Override protected void onResume() { super.onResume(); if (player != null) player.setPlayWhenReady(true); hideSystemBars(); }
    @Override protected void onPause() { super.onPause(); if (player != null) player.setPlayWhenReady(false); }

    @Override protected void onDestroy() {
        super.onDestroy();
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
