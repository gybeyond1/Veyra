package com.hongguotv.core

import org.json.JSONObject
import java.io.IOException
import java.math.BigInteger
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.TimeUnit
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * 红果 fqnovel.com 直连签名器（纯 Kotlin）。
 * 官方签名链 1:1 移植自 server/hongguo-sign.js（该实现已与 python/Go 参照在固定向量下逐字节验证）：
 *   X-Argus（SM3 派生 4+72 轮 TEA 变体 + Feistel + xor + AES-CBC 无 padding）+ X-Ladon + X-Gorgon + X-SS-STUB，
 *   配合真设备注册 log.snssdk.com device_register，video_model 取最高清晰度档（1080p）。
 * 不再依赖 Go 原生二进制 libhongguo_sign.so（该 .so 不在仓库，旧版因此直连必失败）。
 */
object HongguoSigner {
    private const val BASE = "https://api5-normal-sinfonlineb.fqnovel.com"
    private const val UA = "com.phoenix.read/73532 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)"
    private const val AID = "8662"
    private val M64 = BigInteger("ffffffffffffffff", 16)
    private val CONST_BIT = BigInteger("3dc94c3a046d678b", 16)
    private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
    private val RANDOM = SecureRandom()
    private val ARGUS_KEY = hexBytes("ac1adaae95a7af94a5114ab3b3a97dd80050aa0a39314c40528caec95256c28c")
    private val SIGN_KEY = byteArrayOf(
        0x44, 0xb9.toByte(), 0xb9.toByte(), 0xd9.toByte(), 0xa4.toByte(), 0xae.toByte(), 0xf9.toByte(), 0xfc.toByte(),
        0xa4.toByte(), 0x93.toByte(), 0xaa.toByte(), 0x75.toByte(), 0x7c.toByte(), 0xa3.toByte(), 0xc2.toByte(),
        0xc4.toByte(), 0xa4.toByte(), 0x96.toByte(), 0x93.toByte(), 0x8f.toByte()
    )

    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    // ---------- 基础工具 ----------
    private fun hexBytes(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    private fun md5(data: ByteArray): ByteArray = MessageDigest.getInstance("MD5").digest(data)

    private fun uvarint(value: BigInteger): ByteArray {
        var v = value
        val out = ArrayList<Byte>()
        while (true) {
            val b = v.and(BigInteger.valueOf(0x7f)).toInt()
            v = v.shiftRight(7)
            out.add(if (v.signum() != 0) (b or 0x80).toByte() else b.toByte())
            if (v.signum() == 0) break
        }
        return out.toByteArray()
    }

    private fun varintField(msg: ByteArray, field: Long, value: BigInteger): ByteArray =
        msg + uvarint(BigInteger.valueOf(field * 8)) + uvarint(value)

    private fun bytesField(msg: ByteArray, field: Long, value: ByteArray): ByteArray =
        msg + uvarint(BigInteger.valueOf(field * 8 + 2)) + uvarint(BigInteger.valueOf(value.size.toLong())) + value

    /** 64 位旋转：n>=0 左旋 n 位，n<0 右旋 -n 位（对齐 JS BigInt 语义，全部无符号） */
    private fun rotl64(v: BigInteger, n: Int): BigInteger {
        val s = Math.abs(n)
        return if (n >= 0) v.shiftLeft(s).or(v.shiftRight(64 - s)).and(M64)
        else v.shiftRight(s).or(v.shiftLeft(64 - s)).and(M64)
    }

    private fun le64(data: ByteArray, off: Int): BigInteger {
        var v = BigInteger.ZERO
        for (i in 7 downTo 0) v = v.shiftLeft(8).or(BigInteger.valueOf(data[off + i].u().toLong()))
        return v
    }

    private fun ByteArray.writeLe64(off: Int, v: BigInteger): ByteArray {
        var x = v
        for (i in 0 until 8) { this[off + i] = x.and(BigInteger.valueOf(0xff)).toInt().toByte(); x = x.shiftRight(8) }
        return this
    }

    private fun pad16(data: ByteArray): ByteArray {
        val p = 16 - data.size % 16
        return data + ByteArray(p) { p.toByte() }
    }

    private fun rotl8(v: Int, n: Int): Int = ((v shl n) or (v ushr (8 - n))) and 0xff
    private fun rev8(v: Int): Int {
        var x = v
        var r = 0
        for (i in 0 until 8) { r = (r shl 1) or (x and 1); x = x ushr 1 }
        return r and 0xff
    }

    private fun aesEncrypt(data: ByteArray, key: ByteArray, iv: ByteArray): ByteArray {
        val cipher = javax.crypto.Cipher.getInstance("AES/CBC/NoPadding")
        cipher.init(javax.crypto.Cipher.ENCRYPT_MODE, javax.crypto.spec.SecretKeySpec(key, "AES"), javax.crypto.spec.IvParameterSpec(iv))
        return cipher.doFinal(data)
    }

    // ---------- X-Argus（与 server/hongguo-sign.js hongguoArgus 1:1） ----------
    private fun hongguoArgus(query: String, body: ByteArray?, ts: Long, deviceId: String, nonce: ByteArray): String {
        var bodyHash = sm3(ByteArray(16))
        if (body != null && body.isNotEmpty()) bodyHash = sm3(md5(body))
        val queryHash = sm3(query.toByteArray(Charsets.UTF_8))

        val counters = varintField(
            varintField(varintField(varintField(ByteArray(0), 1, BigInteger.ONE), 2, BigInteger.ONE), 3, BigInteger.ONE),
            7, BigInteger.valueOf(3348294860)
        )
        var environment = bytesField(ByteArray(0), 1, "25053RT47C".toByteArray())
        environment = bytesField(environment, 2, "16".toByteArray())
        environment = bytesField(environment, 3, "update_64".toByteArray())
        environment = varintField(environment, 4, BigInteger.valueOf(2147483648))

        var message = varintField(ByteArray(0), 1, BigInteger.valueOf(0x20200929L * 2))
        message = varintField(message, 2, BigInteger.valueOf(2))
        if (nonce.size >= 10) {
            val n = (nonce[6].u() or (nonce[7].u() shl 8) or (nonce[8].u() shl 16) or (nonce[9].u() shl 24)) and 0x7fffffff
            message = varintField(message, 3, BigInteger.valueOf(n.toLong()))
        }
        message = bytesField(message, 4, AID.toByteArray())
        message = bytesField(message, 5, deviceId.toByteArray(Charsets.UTF_8))
        message = bytesField(message, 6, "1611921764".toByteArray())
        message = bytesField(message, 7, "7.3.5.32".toByteArray())
        message = bytesField(message, 8, "v04.07.01-ml-android".toByteArray())
        message = varintField(message, 9, BigInteger.valueOf(135135744))
        message = bytesField(message, 10, ByteArray(8))
        message = varintField(message, 11, BigInteger.ZERO)
        message = varintField(message, 12, BigInteger.valueOf(ts * 2))
        message = bytesField(message, 13, bodyHash.copyOfRange(0, 6))
        message = bytesField(message, 14, queryHash.copyOfRange(0, 6))
        message = bytesField(message, 15, counters)
        message = bytesField(message, 16, ByteArray(0))
        message = bytesField(message, 20, "none".toByteArray())
        message = varintField(message, 21, BigInteger.valueOf(738))
        message = bytesField(message, 23, environment)
        message = varintField(message, 25, BigInteger.valueOf(2))

        var data = pad16(message)
        val seed = ARGUS_KEY + byteArrayOf(0x3c.toByte(), 0xcc.toByte(), 0x56.toByte(), 0x7b.toByte()) + ARGUS_KEY
        val derived = sm3(seed)
        val rounds = ArrayList<BigInteger>()
        for (i in 0 until 4) rounds.add(le64(derived, i * 8))
        for (i in 4 until 72) {
            val mixed = rotl64(rounds[i - 1], -3).xor(rounds[i - 3])
            val mixed2 = mixed.xor(rotl64(mixed, -1))
            val bit = CONST_BIT.shiftRight((i - 4) % 62).and(BigInteger.ONE)
            rounds.add(rounds[i - 4].not().xor(mixed2).xor(bit).xor(BigInteger.valueOf(3)).and(M64))
        }
        for (off in 0 until data.size step 16) {
            var left = le64(data, off)
            var right = le64(data, off + 8)
            for (rnd in rounds) {
                val nl = right
                val nr = left.xor(rotl64(right, 1).and(rotl64(right, 8)).xor(rotl64(right, 2)).xor(rnd)).and(M64)
                left = nl
                right = nr
            }
            data = data.writeLe64(off, left)
            data = data.writeLe64(off + 8, right)
        }
        val xor = byteArrayOf(0xd0.toByte(), 0x4f, 0xfd.toByte(), 0xff.toByte(), 0xd0.toByte(), 0x4f, 0xfd.toByte(), 0xff.toByte())
        for (i in data.indices) data[i] = (data[i].u() xor xor[i % 8].u()).toByte()
        data = xor + data
        data = data.reversedArray()
        var container = byteArrayOf(0xa6.toByte(), 0xe7.toByte(), 0x83.toByte(), 0xee.toByte(), 0x70.toByte(), 0x01.toByte(), 0x10.toByte(), 0x09.toByte(), 0x18.toByte()) + data + byteArrayOf(0x56.toByte(), 0x7b.toByte())
        container = pad16(container)
        val aesKey = md5(ARGUS_KEY.copyOfRange(0, 16))
        val aesIv = md5(ARGUS_KEY.copyOfRange(16, 32))
        container = aesEncrypt(container, aesKey, aesIv)
        return (byteArrayOf(0x3c.toByte(), 0xcc.toByte()) + container).base64()
    }

    // ---------- X-Ladon（与 server/hongguo-sign.js hongguoLadon 1:1） ----------
    private fun hongguoLadon(aid: String, ts: Long, prefix: ByteArray): String {
        val hash = md5(prefix + aid.toByteArray(Charsets.US_ASCII))
        val digest = hash.hex().toByteArray(Charsets.US_ASCII)
        var left = le64(digest, 0)
        var right = le64(digest, 8)
        val queue = ArrayDeque<BigInteger>()
        queue.add(le64(digest, 16))
        queue.add(le64(digest, 24))
        val keys = ArrayList<BigInteger>()
        for (i in 0 until 34) {
            keys.add(left)
            val mixed = rotl64(right, -8).add(left).xor(BigInteger.valueOf(i.toLong())).and(M64)
            queue.add(mixed)
            left = mixed.xor(rotl64(left, 3)).and(M64)
            right = queue.removeFirst()
        }
        var data = pad16("$ts-1611921764-$aid".toByteArray(Charsets.US_ASCII))
        for (off in 0 until data.size step 16) {
            var lv = le64(data, off)
            var rv = le64(data, off + 8)
            for (k in keys) {
                rv = k.xor(lv.add(rotl64(rv, -8)).and(M64)).and(M64)
                lv = rv.xor(rotl64(lv, 3)).and(M64)
            }
            data = data.writeLe64(off, lv)
            data = data.writeLe64(off + 8, rv)
        }
        return (prefix + data).base64()
    }

    // ---------- 完整签名头（X-Gorgon + X-Argus + X-Ladon + X-Khronos + X-SS-STUB） ----------
    private fun signPlayerRequest(rawQuery: String, body: ByteArray, ts: Long, deviceId: String): Map<String, String> {
        val queryHash = md5(rawQuery.toByteArray(Charsets.UTF_8))
        val payload = ByteArray(20)
        queryHash.copyInto(payload, 0, 0, 4)
        var stub: String? = null
        if (body.isNotEmpty()) {
            val bodyHash = md5(body)
            bodyHash.copyInto(payload, 4, 0, 4)
            stub = bodyHash.hex().uppercase()
        }
        payload[12] = 0; payload[13] = 6; payload[14] = 11; payload[15] = 28
        payload[16] = (ts ushr 24).toByte(); payload[17] = (ts ushr 16).toByte()
        payload[18] = (ts ushr 8).toByte(); payload[19] = ts.toByte()
        for (i in payload.indices) payload[i] = (payload[i].u() xor SIGN_KEY[i].u()).toByte()
        for (i in payload.indices) {
            payload[i] = (rev8(rotl8(payload[i].u(), 4) xor payload[(i + 1) % 20].u()) xor 0xff xor 20).toByte()
        }
        val gorgon = byteArrayOf(0x84.toByte(), 0x04.toByte(), 0x40.toByte(), 0x1c.toByte(), 0x00, 0x00) + payload
        val nonce = ByteArray(11).also { RANDOM.nextBytes(it) }
        val headers = linkedMapOf(
            "X-Khronos" to ts.toString(),
            "X-Gorgon" to gorgon.hex().uppercase(),
            "X-SS-Req-Ticket" to System.currentTimeMillis().toString(),
            "X-Argus" to hongguoArgus(rawQuery, body, ts, deviceId, nonce),
            "X-Ladon" to hongguoLadon(AID, ts, nonce.copyOfRange(2, 6)),
        )
        if (stub != null) headers["X-SS-STUB"] = stub
        return headers
    }

    // ---------- Go url.QueryEscape 语义（*→%2A、空格→+、~保留，字典序） ----------
    private fun goEscape(s: String): String {
        val bytes = s.toByteArray(Charsets.UTF_8)
        val sb = StringBuilder()
        for (b in bytes) {
            val c = b.u()
            when {
                c in 0x41..0x5a || c in 0x61..0x7a || c in 0x30..0x39 || c == 0x2d || c == 0x5f || c == 0x2e || c == 0x7e -> sb.append(c.toChar())
                c == 0x20 -> sb.append('+')
                else -> sb.append('%').append("%02X".format(c))
            }
        }
        return sb.toString()
    }

    private fun buildQuery(deviceId: String, installId: String, rticket: Long): String {
        val params = linkedMapOf(
            "ac" to "wifi", "aid" to AID, "app_name" to "novelread", "channel" to "update_64",
            "device_brand" to "Redmi", "device_id" to deviceId, "device_platform" to "android",
            "device_type" to "25053RT47C", "dpi" to "520", "iid" to installId, "language" to "zh",
            "manifest_version_code" to "73532", "os" to "android", "os_api" to "36", "os_version" to "16",
            "resolution" to "1280*2772", "ssmix" to "a", "update_version_code" to "73532",
            "version_code" to "73532", "version_name" to "7.3.5.32", "_rticket" to rticket.toString(),
        )
        return params.toSortedMap().entries.joinToString("&") { (k, v) -> "$k=${goEscape(v)}" }
    }

    // ---------- 设备注册 ----------
    private fun newDeviceId(): String {
        val base = 1_000_000_000_000_000_000L
        val span = 8_000_000_000_000_000_000L
        return (base + Math.floorMod(RANDOM.nextLong(), span)).toString()
    }

    private fun uuidUpper(): String {
        val bytes = ByteArray(16).also { RANDOM.nextBytes(it) }
        return bytes.hex().uppercase()
    }

    private fun registerDevice(): Pair<String, String>? {
        val nowMs = System.currentTimeMillis()
        val openudid = ByteArray(8).also { RANDOM.nextBytes(it) }.hex()
        val header = JSONObject().apply {
            put("display_name", "红果免费短剧"); put("aid", 8662); put("app_version", "7.3.5.32"); put("version_code", 73532)
            put("manifest_version_code", 73532); put("update_version_code", 73532); put("channel", "update_64"); put("package", "com.phoenix.read")
            put("app_language", "zh"); put("os", "Android"); put("os_version", "16"); put("os_api", 36); put("device_model", "25053RT47C")
            put("device_brand", "Redmi"); put("device_manufacturer", "Xiaomi"); put("cpu_abi", "arm64-v8a"); put("density_dpi", 520)
            put("display_density", "xxhdpi"); put("resolution", "2772x1280"); put("language", "zh"); put("timezone", 8); put("access", "wifi")
            put("openudid", openudid); put("clientudid", uuidUpper()); put("cdid", uuidUpper()); put("region", "CN")
            put("tz_name", "Asia/Shanghai"); put("tz_offset", 28800); put("sim_region", "cn"); put("device_platform", "android")
            put("not_request_sender", 0); put("is_system_app", 0); put("sdk_flavor", "china"); put("rom", "OS2.0"); put("rom_version", "BP2A.250605.031.A3")
        }
        val body = JSONObject().apply {
            put("magic_tag", "ss_app_log"); put("header", header); put("_gen_time", nowMs)
        }.toString()
        val q = linkedMapOf(
            "ac" to "wifi", "aid" to AID, "app_name" to "novelread", "channel" to "update_64",
            "device_brand" to "Redmi", "device_platform" to "android", "device_type" to "25053RT47C",
            "dpi" to "520", "language" to "zh", "manifest_version_code" to "73532", "os" to "android",
            "os_api" to "36", "os_version" to "16", "resolution" to "1280*2772", "ssmix" to "a",
            "update_version_code" to "73532", "version_code" to "73532", "version_name" to "7.3.5.32",
            "req_id" to uuidUpper(), "_rticket" to nowMs.toString(),
        )
        val queryStr = q.toSortedMap().entries.joinToString("&") { (k, v) -> "$k=${goEscape(v)}" }
        try {
            val req = Request.Builder().url("https://log.snssdk.com/service/2/device_register/?$queryStr")
                .post(body.toRequestBody(JSON_MEDIA))
                .header("User-Agent", UA)
                .header("Accept", "application/json")
                .build()
            http.newCall(req).execute().use { resp ->
                val text = resp.body?.string() ?: return null
                val json = JSONObject(text)
                val did = json.optString("device_id_str").ifEmpty { json.optString("device_id") }
                val iid = json.optString("install_id_str").ifEmpty { json.optString("install_id") }
                if (did.isNotEmpty() && iid.isNotEmpty() && did != "0" && iid != "0"
                    && did.matches(Regex("\\d{1,32}")) && iid.matches(Regex("\\d{1,32}"))) {
                    android.util.Log.i("HongguoSigner", "device_register 成功 device=$did iid=$iid")
                    return did to iid
                }
            }
        } catch (_: Exception) {}
        return null
    }

    // ---------- 主流程：签名取流（空响应冷却重试 + 换设备 ≤3 轮） ----------
    // ---------- 设备号缓存 ----------
    /*
     * 设备注册是一次额外的 HTTPS 往返（几百毫秒到一秒），原来每次点开一集都重注册一遍。
     * guoapp 的做法是注册一次就存下来、只有被风控才轮换，这里对齐：
     * 首次注册落盘，之后直接复用；取流连续失败才换新设备并覆盖缓存。
     */
    private fun loadDevice(): Pair<String, String>? = try {
        val prefs = AppContext.get().getSharedPreferences("hongguo-device", android.content.Context.MODE_PRIVATE)
        val did = prefs.getString("device_id", "").orEmpty()
        val iid = prefs.getString("install_id", "").orEmpty()
        if (did.matches(Regex("\\d{1,32}")) && iid.matches(Regex("\\d{1,32}")) && did != "0" && iid != "0") did to iid else null
    } catch (_: Throwable) { null }

    private fun saveDevice(device: Pair<String, String>) {
        try {
            AppContext.get().getSharedPreferences("hongguo-device", android.content.Context.MODE_PRIVATE)
                .edit().putString("device_id", device.first).putString("install_id", device.second).apply()
        } catch (_: Throwable) { }
    }

    fun resolve(vid: String): StreamInfo {
        var device = loadDevice() ?: registerDevice()?.also { saveDevice(it) } ?: (newDeviceId() to newDeviceId())
        var lastErr: Exception? = null
        var attempts = 0
        var rotations = 0
        while (attempts < 3) {
            try {
                return resolveOnce(vid, device.first, device.second)
            } catch (e: Exception) {
                lastErr = e
                if (e.message?.contains("HTTP 4") == true) throw e
                android.util.Log.w("HongguoSigner", "取流失败 attempt=$attempts: ${e.message}")
                attempts++
                if (attempts >= 2 && rotations < 2) {
                    device = registerDevice()?.also { saveDevice(it) } ?: (newDeviceId() to newDeviceId())
                    rotations++
                    attempts = 0
                    Thread.sleep(1200)
                } else {
                    Thread.sleep(1500)
                }
            }
        }
        throw lastErr ?: IOException("红果直连失败")
    }

    private fun resolveOnce(vid: String, deviceId: String, installId: String): StreamInfo {
        val now = System.currentTimeMillis()
        val ts = now / 1000
        val rawQuery = buildQuery(deviceId, installId, now)
        val body = "{\"video_id\":\"$vid\",\"content_type\":1,\"biz_param\":{\"need_all_video_definition\":true,\"video_platform\":3}}".toByteArray()
        val sign = signPlayerRequest(rawQuery, body, ts, deviceId)
        val req = Request.Builder().url("$BASE/novel/player/video_model/v1/?$rawQuery")
            .post(body.toRequestBody(JSON_MEDIA))
            .header("User-Agent", UA)
            .header("Accept", "application/json")
            .header("X-XS-From-Web", "0")
            .header("Sdk-Version", "2")
            .apply { sign.forEach { (k, v) -> header(k, v) } }
            .build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string() ?: throw IOException("空响应")
            if (text.isBlank()) throw IOException("空响应 HTTP ${resp.code}（签名校验失败）")
            if (resp.code !in 200..299) throw IOException("HTTP ${resp.code}: ${text.take(300)}")
            val json = JSONObject(text)
            val vmStr = json.optJSONObject("data")?.optString("video_model") ?: throw IOException("无 video_model: ${text.take(300)}")
            val vm = if (vmStr.trim().startsWith("{")) JSONObject(vmStr)
            else try {
                JSONObject(String(android.util.Base64.decode(vmStr.trim(), android.util.Base64.DEFAULT or android.util.Base64.URL_SAFE), Charsets.UTF_8))
            } catch (e: Exception) { throw IOException("video_model 解析失败") }
            val list = vm.optJSONArray("video_list") ?: throw IOException("无 video_list")
            var best: JSONObject? = null
            var bestScore = -1
            var bestMeta: JSONObject? = null
            for (i in 0 until list.length()) {
                val item = list.getJSONObject(i)
                val meta = item.optJSONObject("video_meta") ?: continue
                val codec = meta.optString("codec_type", "").lowercase()
                if (codec == "bytevc2") continue
                if (item.optString("gear_des_key", "").contains("bytevc2", ignoreCase = true)) continue
                var h = meta.optLong("vheight", 0)
                if (h <= 0) h = meta.optLong("vwidth", 0)
                var score = (h * 10).toInt()
                if (codec == "h264" || codec == "avc1") score++
                if (score > bestScore) { bestScore = score; best = item; bestMeta = meta }
            }
            best ?: throw IOException("无可用清晰度")
            var mainUrl = best.optString("main_url", "")
            if (!mainUrl.startsWith("http")) {
                try {
                    val d = String(android.util.Base64.decode(mainUrl.trim(), android.util.Base64.DEFAULT or android.util.Base64.URL_SAFE), Charsets.UTF_8).trim()
                    if (d.startsWith("http")) mainUrl = d
                } catch (_: Exception) {}
            }
            if (!mainUrl.startsWith("http")) throw IOException("无可用播放地址")
            val spadeA = best.optJSONObject("encrypt_info")?.optString("spade_a", "") ?: ""
            val key = if (spadeA.isNotEmpty()) try { MediaCrypto.deriveKey(spadeA) } catch (_: Exception) { null } else null
            val qNum = Regex("[0-9]+").find(bestMeta?.optString("definition", "") ?: "")?.value ?: ""
            android.util.Log.i("HongguoSigner", "取流成功 ${bestMeta?.optString("definition", "")} ${bestMeta?.optLong("vwidth", 0)}x${bestMeta?.optLong("vheight", 0)} key=${key?.hex() ?: "无"}")
            return StreamInfo(mainUrl, key, qNum)
        }
    }
}
