package com.veyra.gybeyond;

import androidx.media3.exoplayer.ExoPlayer;
import org.json.JSONObject;

/**
 * 播放器寄存处。
 *
 * 用户从播放页返回详情页、几秒内又点同一集，是最常见的操作。以前每次都会新建一个
 * ExoPlayer：解码器重新 configure、缓冲清零、mp4 索引重解析，肉眼就是「又转了一圈」。
 * guoapp 那边 mpv 实例挂在播放会话上，页面来回切不重建，所以「一点就秒播」。
 *
 * 这里在播放页退出时把播放器留着（暂停、不释放），同一集再进来直接接管：
 * 解码器已就绪、缓冲还在原位，画面几乎立刻出来。超时或换集就释放。
 */
final class PlayerKeeper {
    private static final long TTL_MS = 3 * 60 * 1000L;

    static final class Session {
        final ExoPlayer player;
        final String key;
        final String source;
        final String mime;
        final long position;
        final boolean firstFrame;
        final JSONObject media;

        Session(ExoPlayer player, String key, String source, String mime,
                long position, boolean firstFrame, JSONObject media) {
            this.player = player; this.key = key; this.source = source; this.mime = mime;
            this.position = position; this.firstFrame = firstFrame; this.media = media;
        }
    }

    private static ExoPlayer player;
    private static String key, source, mime;
    private static long position, keptAt;
    private static boolean firstFrame;
    private static JSONObject media;

    private static final android.os.Handler HANDLER =
            new android.os.Handler(android.os.Looper.getMainLooper());
    private static final Runnable EVICT = () -> {
        synchronized (PlayerKeeper.class) {
            if (player != null && System.currentTimeMillis() - keptAt > TTL_MS) releaseLocked();
        }
    };

    static synchronized void keep(ExoPlayer engine, String sessionKey, String sessionSource,
                                  String sessionMime, long at, boolean hasFrame, JSONObject data) {
        if (engine == null || sessionKey == null) return;
        releaseLocked();
        player = engine; key = sessionKey; source = sessionSource; mime = sessionMime;
        position = at; firstFrame = hasFrame; media = data; keptAt = System.currentTimeMillis();
        // 没人来取就自己清掉，别让解码器和内存一直挂着
        HANDLER.removeCallbacks(EVICT);
        HANDLER.postDelayed(EVICT, TTL_MS + 1_000L);
    }

    /** 同 key 且未过期才交还，并把这个实例从寄存处摘走。 */
    static synchronized Session take(String sessionKey) {
        if (player == null || key == null) return null;
        if (System.currentTimeMillis() - keptAt > TTL_MS) { releaseLocked(); return null; }
        if (sessionKey == null || !sessionKey.equals(key)) { releaseLocked(); return null; }
        Session session = new Session(player, key, source, mime, position, firstFrame, media);
        player = null; key = null; source = null; mime = null; media = null; firstFrame = false;
        return session;
    }

    /** 换集、换剧、进后台太久时清掉，别把解码器一直挂着。 */
    static synchronized void release() { releaseLocked(); }

    private static void releaseLocked() {
        ExoPlayer stale = player;
        player = null; key = null; source = null; mime = null; media = null; firstFrame = false;
        if (stale != null) {
            try { stale.release(); } catch (Throwable ignored) { }
        }
    }
}
