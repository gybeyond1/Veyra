package com.veyra.gybeyond;

import android.net.Uri;
import androidx.media3.common.C;
import androidx.media3.datasource.BaseDataSource;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DataSpec;
import com.hongguotv.core.RemoteVideo;
import com.hongguotv.core.StreamInfo;
import java.io.IOException;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
final class HongguoPlayback {
    private static final Map<String, StreamInfo> STREAMS = new LinkedHashMap<String, StreamInfo>() {
        @Override protected boolean removeEldestEntry(Map.Entry<String, StreamInfo> entry) { return size() > 48; }
    };

    /*
     * 预热实例池。
     *
     * 原来 open() 里每次都 new RemoteVideo(...).prepare()：一次 256KB Range 请求 +
     * moov 解析（CENC 还得解 box），点开一集先干等一个网络来回。guoapp 点开即播，
     * 是因为它把「取流 + 首片」放在点之前就做完了。
     *
     * 现在详情页/点击播放的瞬间就在后台把播放地址解析好、把 RemoteVideo prepare 好、
     * 顺手把首 4MB 铺上；播放器 open() 直接把这个实例拿走，等于零等待。
     * 池子只留 3 个，超过 5 分钟没用就丢掉，避免常驻内存。
     */
    private static final int READY_LIMIT = 3;
    private static final long READY_TTL_MS = 300_000L;
    private static final Map<String, Ready> READY = new LinkedHashMap<String, Ready>(8, 0.75f, true);
    private static final Map<String, Long> PENDING = new HashMap<>();
    private static final ExecutorService WARM_POOL = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "hongguo-playback-warm");
        thread.setDaemon(true);
        return thread;
    });

    private static final class Ready {
        final RemoteVideo video;
        final long at;
        Ready(RemoteVideo video) { this.video = video; this.at = System.currentTimeMillis(); }
    }

    static synchronized void register(StreamInfo info) { if (info != null) STREAMS.put(info.getUrl(), info); }

    private static synchronized StreamInfo info(String url) { return STREAMS.get(url); }

    /**
     * 后台把这一集的播放实例准备到「打开即可读」。重复调用会被合并，
     * 同一地址并发只跑一次 prepare。
     */
    static void warm(final String url) {
        if (url == null || url.isEmpty()) return;
        StreamInfo found;
        synchronized (HongguoPlayback.class) {
            found = STREAMS.get(url);
            if (found == null) return;
            evictExpiredLocked();
            if (READY.containsKey(url) || PENDING.containsKey(url)) return;
            PENDING.put(url, System.currentTimeMillis());
        }
        final StreamInfo stream = found;
        try {
            WARM_POOL.execute(() -> {
                RemoteVideo video = null;
                try {
                    video = new RemoteVideo(stream).prepare();
                } catch (Throwable error) {
                    // 预热失败不影响正常播放：点开时还会再走一次同步 prepare
                }
                synchronized (HongguoPlayback.class) {
                    PENDING.remove(url);
                    if (video == null) return;
                    READY.put(url, new Ready(video));
                    evictLocked();
                }
            });
        } catch (Throwable error) {
            synchronized (HongguoPlayback.class) { PENDING.remove(url); }
        }
    }

    /** 清掉过期的预热实例，避免长期占着几兆内存。 */
    private static void evictExpiredLocked() {
        long now = System.currentTimeMillis();
        Iterator<Map.Entry<String, Ready>> it = READY.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<String, Ready> entry = it.next();
            if (now - entry.getValue().at > READY_TTL_MS) {
                it.remove();
                try { entry.getValue().video.close(); } catch (Throwable ignored) { }
            }
        }
    }

    private static void evictLocked() {
        evictExpiredLocked();
        while (READY.size() > READY_LIMIT) {
            Iterator<Map.Entry<String, Ready>> it = READY.entrySet().iterator();
            if (!it.hasNext()) return;
            Map.Entry<String, Ready> eldest = it.next();
            it.remove();
            try { eldest.getValue().video.close(); } catch (Throwable ignored) { }
        }
    }

    /** 取走预热实例（每个实例只能被一个数据源独占使用）。 */
    private static synchronized RemoteVideo take(String url) {
        evictExpiredLocked();
        Ready ready = READY.remove(url);
        return ready == null ? null : ready.video;
    }

    /**
     * 用完放回池里，而不是直接销毁。
     *
     * 拖动进度条时 ExoPlayer 会 close() 再 open() 同一个数据源；如果 close 就把
     * RemoteVideo 销毁，每次拖动都要重新拉 256KB 头 + 重解析 moov，seek 会明显发涩。
     * 放回池里下一次 open 直接命中，同时也让「退出播放器马上又点进来」不用再取一次流。
     */
    static synchronized void recycle(String url, RemoteVideo video) {
        if (url == null || url.isEmpty() || video == null) return;
        evictExpiredLocked();
        if (READY.containsKey(url) || PENDING.containsKey(url)) {
            try { video.close(); } catch (Throwable ignored) { }
            return;
        }
        READY.put(url, new Ready(video));
        evictLocked();
    }

    /** 有预热就直接用；没有就现场 prepare（回到旧行为，只是慢一点）。 */
    static RemoteVideo obtain(String url) throws IOException {
        RemoteVideo ready = take(url);
        if (ready != null) return ready;
        StreamInfo stream = info(url);
        if (stream == null) throw new IOException("播放地址已失效，请重新选集");
        return new RemoteVideo(stream).prepare();
    }

    static DataSource.Factory factory() { return Source::new; }

    private static final class Source extends BaseDataSource {
        private RemoteVideo video;
        private Uri uri;
        private long position, remaining;
        private byte[] buffer = new byte[0];
        private int offset;
        private boolean opened;
        Source() { super(true); }
        @Override public long open(DataSpec spec) throws IOException {
            transferInitializing(spec); uri = spec.uri;
            try {
                // 命中预热时这里几乎没有耗时，播放器拿到首帧不用再等一次网络来回
                video = obtain(uri.toString());
                position = spec.position;
                if (position > video.getTotal()) throw new IOException("读取位置超出视频长度");
                remaining = spec.length == C.LENGTH_UNSET ? video.getTotal() - position : Math.min(spec.length, video.getTotal() - position);
                buffer = new byte[0]; offset = 0; opened = true; transferStarted(spec);
                return remaining;
            } catch (RuntimeException error) { close(); throw new IOException("视频索引读取失败", error); }
            catch (IOException error) { close(); throw error; }
        }
        @Override public int read(byte[] target, int targetOffset, int length) throws IOException {
            if (length == 0) return 0;
            if (remaining == 0) return C.RESULT_END_OF_INPUT;
            try {
                if (offset >= buffer.length) { buffer = video.read(position, (int)Math.min(512 * 1024, remaining)); offset = 0; }
                if (buffer.length == 0) throw new IOException("视频分段意外结束");
                int count = (int)Math.min(Math.min(length, buffer.length - offset), remaining);
                System.arraycopy(buffer, offset, target, targetOffset, count);
                offset += count; position += count; remaining -= count; bytesTransferred(count);
                return count;
            } catch (RuntimeException error) { throw new IOException("视频分段处理失败", error); }
        }
        @Override public Uri getUri() { return uri; }
        @Override public void close() {
            RemoteVideo current = video;
            String url = uri == null ? null : uri.toString();
            video = null; uri = null; buffer = new byte[0];
            if (current != null) {
                // 读过的位置和 moov 都还在，放回池里让 seek / 重开直接命中
                if (opened) recycle(url, current);
                else { try { current.close(); } catch (Throwable ignored) { } }
            }
            if (opened) { opened = false; transferEnded(); }
        }
    }
}
