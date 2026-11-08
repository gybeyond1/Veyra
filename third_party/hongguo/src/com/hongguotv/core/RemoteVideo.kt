// SPDX-License-Identifier: GPL-3.0-only
package com.hongguotv.core

import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.Closeable
import java.io.IOException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** One playback stream. No listening socket or local HTTP service. */
class RemoteVideo(val info: StreamInfo) : Closeable {
    @Volatile private var closed = false
    private val calls = mutableSetOf<okhttp3.Call>()
    data class Range(val bytes: ByteArray, val total: Long)
    var total: Long = 0; private set
    private lateinit var prepared: MediaCrypto.Prepared
    @Volatile private var prefix = byteArrayOf()

    /*
     * 预热从前台挪到后台。
     * 原先 prepare() 里同步拉满 4MB 才返回，播放器的 open() 就得干等这一整段下载，
     * 点开一集先转圈一到三秒。现在 header 解析完立刻返回，预热在后台线程继续跑，
     * 播放器读到的部分要么命中内存、要么按需补，首帧不用等满 4MB。
     */
    private val prefixLock = Any()
    @Volatile private var warmUntil = 0L
    @Volatile private var warming = false
    private var warmPool: ExecutorService? = null
    private val PREFETCH_UNIT = 1024L * 1024L
    private val WARM_FLOOR = 4L * 1024L * 1024L

    // Dedicated client with longer timeouts; CDN may stall on mobile networks.
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private fun rangeOnce(start: Long, end: Long): Range {
        val request = Request.Builder().url(info.url)
            .header("User-Agent", VendorConstants.VIDEO_UA)
            .header("Referer", "https://novel.snssdk.com/")
            .header("Range", "bytes=$start-$end")
            .header("Accept-Encoding", "identity")
            .header("Cache-Control", "no-cache")
            .build()
        val call = http.newCall(request)
        synchronized(calls) { if (closed) throw IOException("播放请求已取消"); calls += call }
        try {
            return RequestScope.execute(call) { response ->
                when (response.code) {
                    206 -> {
                        val cr = response.header("Content-Range").orEmpty()
                        var begin = start
                        var finish = end
                        var full = total
                        val m = Regex("bytes\\s+(\\d+)-(\\d+)/(\\d+)").find(cr)
                        if (m != null) {
                            begin = m.groupValues[1].toLong()
                            finish = m.groupValues[2].toLong()
                            full = m.groupValues[3].toLong()
                        }
                        val body = response.body ?: throw IOException("视频分段为空")
                        val expectedLen = (finish - begin + 1).toInt()
                        val bytes = body.source().readByteArray(expectedLen.toLong())
                        if (total == 0L) total = full
                        Range(bytes, full)
                    }
                    200 -> {
                        val body = response.body ?: throw IOException("视频响应为空")
                        val bytes = body.bytes()
                        if (total == 0L) total = bytes.size.toLong()
                        Range(bytes, total)
                    }
                    else -> throw IOException("视频服务器错误 HTTP ${response.code}")
                }
            }
        } finally { synchronized(calls) { calls -= call } }
    }

    private fun range(start: Long, end: Long): Range {
        if (closed) throw IOException("播放请求已取消")
        require(start >= 0 && end >= start && end - start < 8 * 1024 * 1024)
        var lastErr: IOException? = null
        for (attempt in 0 until 5) {
            try {
                return rangeOnce(start, end)
            } catch (e: IOException) {
                lastErr = e
                if (closed) throw e
                // Exponential backoff: 200ms, 400ms, 800ms, 1600ms, 3200ms
                try { Thread.sleep(200L * (1 shl attempt)) } catch (_: InterruptedException) {}
            }
        }
        throw lastErr ?: IOException("分段读取失败")
    }

    @Synchronized fun prepare(): RemoteVideo {
        if (::prepared.isInitialized) return this
        val first = range(0, 256 * 1024 - 1); total = first.total
        prefix = first.bytes
        val end = MediaCrypto.headerEnd(first.bytes, total)
        val header = if (end > first.bytes.size)
            first.bytes + range(first.bytes.size.toLong(), end - 1L).bytes
        else
            first.bytes.copyOf(end)
        prepared = MediaCrypto.prepare(header, info.key)
        if (prepared.samples.any { it.end > total }) throw IOException("视频样本超出资源大小")
        requestWarm(WARM_FLOOR)
        return this
    }

    /** 保留旧入口：不再阻塞调用线程，只是把后台预热窗口提前。 */
    @Synchronized fun warm(): RemoteVideo {
        requestWarm(WARM_FLOOR)
        return this
    }

    /**
     * 扩展预热窗口。目标位置只增不减，顺序播放时缓存会一路跟着播放头走，
     * 而不是像原来那样过了前 4MB 就每读 512KB 同步等一个来回。
     */
    private fun requestWarm(until: Long) {
        if (closed || !::prepared.isInitialized) return
        val target = minOf(total, maxOf(until, WARM_FLOOR))
        if (target <= warmUntil) return
        warmUntil = target
        if (warming) return
        warming = true
        val pool = warmPool ?: Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "hongguo-warm").apply { isDaemon = true }
        }.also { warmPool = it }
        try {
            pool.execute { drainWarm() }
        } catch (_: Throwable) {
            warming = false
        }
    }

    private fun drainWarm() {
        try {
            while (!closed) {
                val target = warmUntil
                val from = synchronized(prefixLock) { prefix.size.toLong() }
                if (from >= target) return
                val end = minOf(target, from + PREFETCH_UNIT) - 1
                if (end < from) return
                val chunk = try { range(from, end).bytes } catch (_: IOException) { return }
                if (chunk.isEmpty()) return
                synchronized(prefixLock) {
                    // 期间被别的线程改过就不拼接，避免错位
                    if (prefix.size.toLong() == from) prefix = prefix + chunk
                }
            }
        } finally {
            warming = false
        }
    }

    fun read(start: Long, length: Int): ByteArray {
        require(length in 1..1024 * 1024 && start >= 0)
        if (closed) throw IOException("播放请求已取消")
        if (start >= total) return byteArrayOf()
        val cached = prefix; val end = minOf(total, start + length)
        val available = (minOf(end, cached.size.toLong()) - start).coerceAtLeast(0).toInt()
        val first = if (available > 0) cached.copyOfRange(start.toInt(), start.toInt() + available) else byteArrayOf()
        val raw = if (start + available < end)
            first + range(start + available, end - 1).bytes
        else
            first
        // 顺序往下读时，把播放头之后两兆先备好，下一次 read 直接命中内存
        val next = start + length
        if (next < total && start <= cached.size + 512L * 1024L) requestWarm(next + 2 * PREFETCH_UNIT)
        return MediaCrypto.decrypt(raw, start, info.key, prepared)
    }

    override fun close() {
        synchronized(calls) {
            closed = true
            calls.toList().forEach { it.cancel() }
            calls.clear()
        }
        warmPool?.shutdownNow()
        warmPool = null
    }
}
