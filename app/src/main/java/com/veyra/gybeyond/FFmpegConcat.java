package com.veyra.gybeyond;

import java.io.File;
import java.util.List;

/**
 * 自写合并引擎：Java 只调一个 native 函数，concat 全部逻辑在 C 层直调 ffmpeg C API，
 * 1:1 复刻后端 server/downloader.js 的 concat 阶段：
 *   -f concat -safe 0 -c copy -video_track_timescale 90000 -movflags +faststart -tag:v avc3/hev1
 * 编译产物 libffconcat.so（NDK aarch64，静态链接 libavformat/libavcodec/libavutil），
 * 单 .so 无外部依赖，无 JavaCPP 依赖闭包/空壳问题。
 * C 层每阶段写 native 阶段日志（logPath），native 崩溃时也能定位到具体阶段。
 * 注：v0.18.32 起黄果 ts→mp4 已改走 DownloadManager.mergeTsToMp4（Java Cipher 解密 +
 *  MediaExtractor/MediaMuxer），本类不再含 JavaCPP ffmpeg 实现，m3u8ToMp4 已移除。
 */
final class FFmpegConcat {

    /** native 库加载异常缓存（System.loadLibrary 失败时保留，concat() 转 IOException）。 */
    private static Throwable LOAD_ERROR;

    static {
        try {
            System.loadLibrary("ffconcat");
        } catch (Throwable t) {
            LOAD_ERROR = t;
        }
    }

    /** 与 ffmpeg CLI concat 合并 1:1。tag: "hvc1" 或 "avc1"（**不要**用 hev1/avc3，见下）。
     *  输出失败抛 IOException（带 ffmpeg 阶段信息）。
     *  keys：每集 CENC 解密密钥（hex 字符串，可为空串表示明文源），顺序与 inputs 一一对应。
     *  ⚠️ tag 必须是 avc1 / hvc1（参数集只在 avcC 里）。avc3 / hev1 是「参数集放样本内」的
     *  变体，规范上合法、ffmpeg 也能正确生成，但很多 Android 解码器按 stsd 四码匹配，
     *  遇到 avc3/hev1 直接判不支持 → 文件能打开、时长正确、画面全黑，容器校验查不出来。 */
    static void concat(List<File> inputs, List<String> keys, File output, String tag, StringBuilder debug, File nativeLog) throws Exception {
        if (LOAD_ERROR != null) {
            throw new java.io.IOException("ffmpeg 库加载失败: " + LOAD_ERROR, LOAD_ERROR);
        }
        if (inputs == null || inputs.isEmpty()) {
            throw new java.io.IOException("分集数=0，无法合并");
        }
        if (nativeLog != null) {
            try {
                java.nio.file.Files.write(nativeLog.toPath(), new byte[0]);   // 清空 native 阶段日志
            } catch (Exception ignored) { }
        }
        String[] paths = new String[inputs.size()];
        for (int i = 0; i < inputs.size(); i++) paths[i] = inputs.get(i).getAbsolutePath();
        String[] keyArr = new String[inputs.size()];
        for (int i = 0; i < keyArr.length; i++) {
            keyArr[i] = (keys != null && i < keys.size()) ? keys.get(i) : "";
        }
        debug.append("concat 列表: ").append(paths.length).append(" 集 → ").append(output.getAbsolutePath()).append('\n');
        String logArg = nativeLog != null ? nativeLog.getAbsolutePath() : "";
        String err = nativeConcat(paths, keyArr, output.getAbsolutePath(), tag, logArg, true);
        if (err != null && err.contains("音频整轨重建")) {
            /* 音频整轨重建是这条链路里唯一「新增编码」的分支（AAC 帧长混装时才启用）。
             * 它失败绝不能把整部剧拖死：清空产物与日志，关掉重建开关，退回纯 copy 重跑一次。
             * 降级后的行为 = 0.28.33 及以前（逐集 copy + concat），最坏也不会比以前更差。 */
            debug.append("音频整轨重建失败，降级纯 copy 重试：\n").append(err).append('\n');
            try { if (output.exists()) output.delete(); } catch (Exception ignored) { }
            if (nativeLog != null) {
                try { java.nio.file.Files.write(nativeLog.toPath(), new byte[0]); } catch (Exception ignored) { }
            }
            err = nativeConcat(paths, keyArr, output.getAbsolutePath(), tag, logArg, false);
            if (err == null) debug.append("降级纯 copy 合并成功（音轨未统一，可能有接缝）\n");
        }
        // 无论成败，把 native 阶段日志（含 [norm] 音轨诊断 / [gap] 跳跃检测）并入 debug，供「复制合并日志」查看
        if (nativeLog != null && nativeLog.exists()) {
            try {
                String nl = new String(java.nio.file.Files.readAllBytes(nativeLog.toPath()), "UTF-8");
                if (!nl.isEmpty()) debug.append("--- native 阶段日志 ---\n").append(nl);
            } catch (Exception ignored) { }
        }
        if (err != null) {
            // C 层返回的错误消息已含「失败阶段 + 异常 + 细节」，直接抛出供详细日志展示
            throw new java.io.IOException(err);
        }
        if (!output.exists() || output.length() == 0) {
            throw new java.io.IOException("合并产物为空");
        }
        verifyAudio(inputs, output, debug);
        debug.append("concat 合并完成\n");
    }

    /**
     * 产物级校验（供非 native 的合并路径复用，如 DownloadManager 的 MediaMuxer 合并）：
     * 回读产物检查视频轨/音频轨是否齐全、时长是否对得上，不通过抛 IOException。
     */
    static void verify(File output, List<File> inputs, StringBuilder debug) throws Exception {
        if (output == null || !output.exists() || output.length() == 0)
            throw new java.io.IOException("合并产物为空");
        verifyAudio(inputs, output, debug);
    }

    /**
     * 产物级音频校验：合并完成后回读产物，检查音频轨存在、音频时长与视频/分集总和匹配。
     * 只读容器元数据不遍历帧（快），能捕获「某段无声/丢声」这类规范化诊断看不出的产物缺陷。
     * 校验失败抛异常（分集保留，可重下重试）。
     */
    private static void verifyAudio(List<File> inputs, File output, StringBuilder debug) throws Exception {
        long expectAudioUs = 0;
        for (File f : inputs) {
            android.media.MediaExtractor ex = null;
            try {
                ex = new android.media.MediaExtractor();
                ex.setDataSource(f.getAbsolutePath());
                for (int i = 0; i < ex.getTrackCount(); i++) {
                    android.media.MediaFormat fmt = ex.getTrackFormat(i);
                    String mime = fmt.getString(android.media.MediaFormat.KEY_MIME);
                    if (mime != null && mime.startsWith("audio/") && fmt.containsKey(android.media.MediaFormat.KEY_DURATION))
                        expectAudioUs += fmt.getLong(android.media.MediaFormat.KEY_DURATION);
                }
            } catch (Exception ignored) { } finally { if (ex != null) ex.release(); }
        }
        long outAudioUs = 0, outVideoUs = 0;
        boolean hasAudio = false, hasVideo = false;
        android.media.MediaExtractor out = null;
        try {
            out = new android.media.MediaExtractor();
            out.setDataSource(output.getAbsolutePath());
            for (int i = 0; i < out.getTrackCount(); i++) {
                android.media.MediaFormat fmt = out.getTrackFormat(i);
                String mime = fmt.getString(android.media.MediaFormat.KEY_MIME);
                long d = fmt.containsKey(android.media.MediaFormat.KEY_DURATION) ? fmt.getLong(android.media.MediaFormat.KEY_DURATION) : 0;
                if (mime != null && mime.startsWith("audio/")) { hasAudio = true; outAudioUs = Math.max(outAudioUs, d); }
                else if (mime != null && mime.startsWith("video/")) { hasVideo = true; outVideoUs = Math.max(outVideoUs, d); }
            }
        } catch (Exception e) {
            throw new java.io.IOException("产物音频校验失败: " + e.getMessage(), e);
        } finally { if (out != null) out.release(); }
        debug.append("[校验] 产物音频=").append(outAudioUs / 1000).append("ms 视频=").append(outVideoUs / 1000)
                .append("ms 期望音频(分集和)=").append(expectAudioUs / 1000).append("ms ").append(boxInfo(output)).append('\n');
        if (!hasVideo) throw new java.io.IOException("产物没有视频轨，合并结果异常（" + boxInfo(output) + "）");
        // 视频轨在、时长却是 0：容器结构合法但没有任何可解画面（播放器打开就是黑屏）。
        // v0.18.68 那次「视频=0ms head=ftyp」就是这个形态，必须判失败而不是当成功。
        if (outVideoUs <= 0) throw new java.io.IOException("产物视频轨时长为 0（打开会黑屏）（" + boxInfo(output) + "）");
        if (!hasAudio) throw new java.io.IOException("产物没有音频轨（合并结果无声）：请重新下载分集后重试");
        if (outVideoUs > 0 && outAudioUs > 0 && outAudioUs < outVideoUs * 95 / 100)
            throw new java.io.IOException("产物音频不完整（音频 " + (outAudioUs / 1000) + "ms < 视频 " + (outVideoUs / 1000)
                    + "ms 的 95%）：部分段落无声，请重下异常分集后重试");
        if (expectAudioUs > 0 && outAudioUs > 0 && outAudioUs < expectAudioUs * 92 / 100)
            debug.append("[校验] 警告：产物音频明显短于分集总和（可能部分段丢声）\n");
    }

    /**
     * 产物结构快照（写进日志/异常消息）：文件大小 + 头部含 moof 与否。
     * moof 出现即说明 muxer 输出了分片 MP4（movflags 误带 delay_moov），
     * 这种文件 ffmpeg 能读、Android MediaExtractor 读不出任何轨。
     */
    private static String boxInfo(File f) {
        StringBuilder sb = new StringBuilder("大小=").append(f.length() / 1024).append("KB");
        try (java.io.FileInputStream fis = new java.io.FileInputStream(f)) {
            byte[] buf = new byte[262144];
            int n = fis.read(buf);
            if (n >= 12) sb.append(" head=").append(new String(buf, 4, 4, "ISO-8859-1").trim());
            boolean moof = false;
            for (int i = 0; i + 4 <= n; i++) {
                if (buf[i] == 'm' && buf[i + 1] == 'o' && buf[i + 2] == 'o' && buf[i + 3] == 'f') { moof = true; break; }
            }
            if (moof) sb.append(" moof=有(分片MP4,Android读不出轨)");
        } catch (Exception ignored) { }
        return sb.toString();
    }

    /**
     * native concat：
     * @return null = 成功；非 null = 失败（错误消息字符串，含失败阶段与 rc 细节）。
     */
    /** allowAudioRebuild=false 时跳过音频整轨重建，纯 copy 合并（降级路径）。 */
    private static native String nativeConcat(String[] inputPaths, String[] keys, String outputPath, String tag,
                                             String logPath, boolean allowAudioRebuild);
}
