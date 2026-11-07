package com.veyra.gybeyond;

import android.content.Context;
import androidx.media3.common.C;
import androidx.media3.database.StandaloneDatabaseProvider;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.cache.CacheDataSource;
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor;
import androidx.media3.datasource.cache.SimpleCache;
import androidx.media3.exoplayer.hls.HlsMediaSource;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.source.ProgressiveMediaSource;
import androidx.media3.exoplayer.drm.DrmSessionManagerProvider;
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy;
import java.io.File;

/** Shared by playback, the next episode and seek previews; never caches mutable playlists. */
@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
final class VideoPlaybackCache {
    static final long MAX_BYTES = 128L * 1024 * 1024;
    private static SimpleCache cache;

    private static synchronized SimpleCache get(Context context) {
        if (cache == null) {
            Context app = context.getApplicationContext();
            cache = new SimpleCache(new File(app.getCacheDir(), "video-segments"),
                    new LeastRecentlyUsedCacheEvictor(MAX_BYTES), new StandaloneDatabaseProvider(app));
        }
        return cache;
    }

    static MediaSource.Factory sources(Context context) {
        // 黄果 HLS 播放按通道模式实时选择：仅代理 → 经配置代理；直连/走后端 → 系统栈直连。
        // 后端转发时 source 本身就是后端代理 URL（直连后端即可）；红果 MP4 走 HongguoPlayback，不受影响。
        // 接口型源（剧果/野果/…）的「仅代理」由后端代走代理取流，客户端必须直连后端，
        // 否则会变成"客户端套代理去连后端"，代理只对源站有效时直接连不上。
        String proxy = "huangguo".equals(PrivateSite.get(context))
                && ProxySettings.mode(context) == ProxySettings.MODE_PROXY
                ? ProxySettings.address(context) : null;
        // 直连模式下源站要 Referer + 签名 Cookie，后端把这套头随播放地址一起下发，
        // 这里取当前这一集的凭据贴到清单 / 分片 / 密钥的每条请求上，否则第一步就 403。
        ChannelHttpDataSource.Factory upstream = new ChannelHttpDataSource.Factory(proxy)
                .setMediaHeaders(MediaRequestContext.headers(), MediaRequestContext.site());
        CacheDataSource.Factory cached = new CacheDataSource.Factory().setCache(get(context))
                .setUpstreamDataSourceFactory(upstream).setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR);
        HlsMediaSource.Factory hls = new HlsMediaSource.Factory(type -> type == C.DATA_TYPE_MANIFEST
                ? upstream.createDataSource() : cached.createDataSource());
        ProgressiveMediaSource.Factory mp4 = new ProgressiveMediaSource.Factory(HongguoPlayback.factory());
        return new MediaSource.Factory() {
            @Override public MediaSource createMediaSource(MediaItem item) {
                return item.localConfiguration != null && MimeTypes.VIDEO_MP4.equals(item.localConfiguration.mimeType)
                        ? mp4.createMediaSource(item) : hls.createMediaSource(item);
            }
            @Override public int[] getSupportedTypes() { return new int[]{C.CONTENT_TYPE_HLS, C.CONTENT_TYPE_OTHER}; }
            @Override public MediaSource.Factory setDrmSessionManagerProvider(DrmSessionManagerProvider provider) {
                hls.setDrmSessionManagerProvider(provider); mp4.setDrmSessionManagerProvider(provider); return this;
            }
            @Override public MediaSource.Factory setLoadErrorHandlingPolicy(LoadErrorHandlingPolicy policy) {
                hls.setLoadErrorHandlingPolicy(policy); mp4.setLoadErrorHandlingPolicy(policy); return this;
            }
        };
    }
}
