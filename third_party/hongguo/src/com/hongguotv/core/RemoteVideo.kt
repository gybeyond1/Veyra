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

    /*
     * 缓存从「一个越拼越大的 ByteArray」改成「分段窗口」。
     *
     * 旧写法是 prefix = prefix + chunk：顺序播放时 warmUntil 跟着播放头一路涨，
     * 这个数组就一路涨到整部片子那么大，而且每拼一次都要 Arrays.copyOf 出一块更大的新内存。
     * 电视盒子堆只有 48MB（growth limit 50331648），拼到 9MB 时再要 10MB 连续内存就
     * OutOfMemoryError: Failed to allocate a 10485776 byte allocation —— 就是这次崩溃。
     *
     * 现在每段最多 1MB，总长有上限，超了从头部丢引用（不拷贝数据），播放头前进时窗口跟着滑。
     * 任何时刻的单次分配都不超过 1MB。
     */
    private val segments = ArrayDeque<ByteArray>()
    private var cacheBase = 0L
    private var cacheSize = 0L
    /** 堆的 1/8，夹在 4MB~12MB：电视 48MB 堆 → 6MB，手机 256MB 堆 → 12MB。 */
    private val cacheCap = (Runtime.getRuntime().maxMemory() / 8).coerceIn(4L shl 20, 12L shl 20)
    private val KEEP_BEHIND = 256L * 1024L
    private val EMPTY = ByteArray(0)

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
                        /*
                         * 服务器忽略了 Range，把整部片子倒回来。
                         * 原来是 body.bytes() 一次全读进内存，长片子必然 OOM；
                         * 这里跳过 start 之前的部分，只取需要的那一段。
                         */
                        val declared = body.contentLength()
                        val source = body.source()
                        // okio 各版本 source.skip() 的返回值不一样（Boolean / Long 都出现过），
                        // 这里自己读一块丢一块，不依赖它的签名
                        val discard = ByteArray(64 * 1024)
                        var skipped = 0L
                        while (skipped < start) {
                            val take = minOf(discard.size.toLong(), start - skipped).toInt()
                            val step = source.read(discard, 0, take)
                            if (step < 0) break
                            skipped += step
                        }
                        val want = (end - start + 1).toInt()
                        val bytes = ByteArray(want)
                        var got = 0
                        while (got < want) {
                            val step = source.read(bytes, got, want - got)
                            if (step < 0) break
                            got += step
                        }
                        if (total == 0L) total = if (declared > 0) declared else start + got
                        Range(if (got == want) bytes else bytes.copyOf(got), total)
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
        val end = MediaCrypto.headerEnd(first.bytes, total)
        val header = if (end > first.bytes.size)
            first.bytes + range(first.bytes.size.toLong(), end - 1L).bytes
        else
            first.bytes.copyOf(end)
        // 头部本来就是连续的一段，直接当窗口第 0 段，预热时不用重复拉
        synchronized(prefixLock) {
            segments.clear()
            segments.addLast(header)
            cacheBase = 0L
            cacheSize = header.size.toLong()
        }
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
        kickWarm()
    }

    private fun kickWarm() {
        if (closed || warming) return
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

    /** 窗口已经满了就先不叫醒预热线程，等 read() 把老的段丢掉腾出空间。 */
    private fun kickWarmIfRoom() {
        if (warming || closed) return
        if (synchronized(prefixLock) { cacheSize < cacheCap }) kickWarm()
    }

    private fun drainWarm() {
        try {
            while (!closed) {
                val target = warmUntil
                val from = synchronized(prefixLock) {
                    if (cacheSize >= cacheCap) -1L else cacheBase + cacheSize
                }
                if (from < 0L) return                  // 窗口满了，等播放头推进
                if (from >= target) return
                val end = minOf(target, from + PREFETCH_UNIT) - 1
                if (end < from) return
                val chunk = try { range(from, end).bytes } catch (_: IOException) { return }
                if (chunk.isEmpty()) return
                synchronized(prefixLock) {
                    // 期间窗口被别的线程滑过就不拼，避免错位
                    if (cacheBase + cacheSize != from) return
                    appendLocked(chunk)
                }
            }
        } catch (error: OutOfMemoryError) {
            // 预热只是加速，宁可把缓存丢了也不能让整个进程被 OOM 带走
            synchronized(prefixLock) {
                segments.clear()
                cacheBase = 0L
                cacheSize = 0L
            }
        } catch (_: Throwable) {
        } finally {
            warming = false
        }
    }

    /** 丢掉播放头之前的老段：往后回拖 256KB 内还能命中，再往前就把窗口整个挪回来。 */
    private fun trimLocked(start: Long) {
        if (start < cacheBase) {
            // 往回拖出了窗口：旧段全部作废，窗口从当前位置重新起
            segments.clear()
            cacheBase = start
            cacheSize = 0L
            warmUntil = minOf(warmUntil, start)
            return
        }
        val keepFrom = maxOf(0L, start - KEEP_BEHIND)
        while (segments.isNotEmpty()) {
            val head = segments.first()
            if (cacheBase + head.size > keepFrom) break
            segments.removeFirst()
            cacheBase += head.size
            cacheSize -= head.size
        }
    }

    private fun appendLocked(chunk: ByteArray) {
        segments.addLast(chunk)
        cacheSize += chunk.size
        while (cacheSize > cacheCap && segments.size > 1) {
            val head = segments.removeFirst()
            cacheBase += head.size
            cacheSize -= head.size
        }
    }

    private fun sliceLocked(from: Long, to: Long): ByteArray {
        if (to <= from) return EMPTY
        val out = ByteArray((to - from).toInt())
        var at = cacheBase
        for (segment in segments) {
            val segmentEnd = at + segment.size
            if (segmentEnd <= from) { at = segmentEnd; continue }
            if (at >= to) break
            val begin = maxOf(from, at)
            val stop = minOf(to, segmentEnd)
            System.arraycopy(segment, (begin - at).toInt(), out, (begin - from).toInt(), (stop - begin).toInt())
            at = segmentEnd
        }
        return out
    }

    fun read(start: Long, length: Int): ByteArray {
        require(length in 1..1024 * 1024 && start >= 0)
        if (closed) throw IOException("播放请求已取消")
        if (start >= total) return byteArrayOf()
        val end = minOf(total, start + length)

        // 命中窗口的部分直接切出来，剩下的按需补网络
        var hit = EMPTY
        var hitFrom = start
        var hitTo = start
        synchronized(prefixLock) {
            trimLocked(start)
            val tail = cacheBase + cacheSize
            if (start >= cacheBase && start < tail) {
                hitFrom = start
                hitTo = minOf(end, tail)
                val slice = sliceLocked(hitFrom, hitTo)
                if (slice.size.toLong() == hitTo - hitFrom) hit = slice else hitTo = start
            }
        }
        val raw = when {
            hit.size.toLong() == end - start -> hit                  // 整段命中
            hit.isNotEmpty() -> hit + range(hitTo, end - 1).bytes    // 前段命中
            else -> range(start, end - 1).bytes                      // 没命中
        }
        // 顺序往下读时，把播放头之后两兆先备好，下一次 read 直接命中内存
        val next = start + length
        if (next < total) {
            requestWarm(next + 2 * PREFETCH_UNIT)
            kickWarmIfRoom()
        }
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
        synchronized(prefixLock) {
            segments.clear()
            cacheBase = 0L
            cacheSize = 0L
        }
    }
}
