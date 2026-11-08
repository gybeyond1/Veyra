package com.veyra.gybeyond;

import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.LoadControl;

/** A standby player becomes a normal player without rebuilding its decoder or buffers. */
@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
final class EpisodeLoadControl extends DefaultLoadControl {
    static final long STANDBY_BUFFER_US = 5_000_000L;
    static final int STANDBY_BYTES = 4 * 1024 * 1024;

    /*
     * 起播门槛。
     *
     * DefaultLoadControl 默认要缓冲 2500ms（重缓冲 5000ms）才放行，短剧一集才一两分钟，
     * 这两秒半纯粹是干等 —— 点开一集先黑一下、转个圈，guoapp（mpv）那边 threshold 几乎是 0，
     * 所以它「一点就播」。
     *
     * 数据本来就是边读边解密的本地流，300ms 足够让首帧出来又不至于抖。
     */
    private static final long START_BUFFER_US = 300_000L;
    private static final long RESTART_BUFFER_US = 1_200_000L;

    private volatile boolean standby;

    EpisodeLoadControl(boolean standby) { this.standby = standby; }
    void promote() { standby = false; }

    @Override public boolean shouldContinueLoading(LoadControl.Parameters parameters) {
        if (standby && (parameters.bufferedDurationUs >= STANDBY_BUFFER_US
                || getAllocator(parameters.playerId).getTotalBytesAllocated() >= STANDBY_BYTES)) return false;
        return super.shouldContinueLoading(parameters);
    }

    @Override public boolean shouldStartPlayback(LoadControl.Parameters parameters) {
        long threshold = parameters.rebuffering ? RESTART_BUFFER_US : START_BUFFER_US;
        if (parameters.bufferedDurationUs >= threshold) return true;
        if (standby && parameters.bufferedDurationUs >= 500_000) return true;
        // 兜底：真的只剩片尾那一点点时，别让它死在最后 0.3 秒
        return super.shouldStartPlayback(parameters);
    }
}
