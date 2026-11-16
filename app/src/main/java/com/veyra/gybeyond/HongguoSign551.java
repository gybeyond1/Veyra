package com.veyra.gybeyond;

import org.bouncycastle.crypto.digests.SM3Digest;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * 红果播放接口的 551 Argus + Ladon 签名。
 *
 * 红果在 2026-10-27 之后把播放取址改成了「注册过的匿名身份 + 551 签名」：
 * 老的 x-argus（8402 那一版）和随手编的 device_id 一律回 HTTP 200 + 空正文，
 * 表现和超时/限流一模一样，但根本原因是签名对不上。这里把客户端实际发送的
 * 签名逐字节实现出来，算法常量都是客户端协议里的公开值。
 *
 *   x-argus：protobuf(设备/时间/body 摘要/query 摘要) -> Simon 72 轮
 *            -> 帧头帧尾异或 -> 逆序 -> AES-128-CBC -> base64（前缀 f281）
 *   x-ladon：md5(随机 4 字节 + aid) 生成 35 项字表，对 "ts-license-aid" 分组变换
 *
 * 两个签名都绑定「最终 query 原文 + 实际发送的 body」：query 里多编一个字符、
 * body 差一个字节，服务端算出来的摘要就对不上，还是空响应。
 */
final class HongguoSign551 {
    private static final byte[] SIGN_KEY = hex("fc78e0a9657a0c748ce51559903ccf03510e51d3cff232d71343e88a321c5304");
    private static final byte[] AES_KEY = hex("d31e3718288a1027baab59f146a09a9c");
    private static final byte[] AES_IV = hex("ea180a0336ed352fcd24e4d50018ae54");
    private static final byte[] MAGIC8 = hex("f2f7fcfff2f7fcff");
    private static final byte[] TAIL9 = hex("eafb2cfe8568519154");
    private static final long LICENSE_ID = 1611921764L;
    private static final SecureRandom RANDOM = new SecureRandom();

    private HongguoSign551() { }

    // ---------------- 基础工具 ----------------

    static byte[] hex(String s) {
        byte[] out = new byte[s.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16);
        return out;
    }

    static String hex(byte[] data) {
        StringBuilder sb = new StringBuilder(data.length * 2);
        for (byte b : data) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    static byte[] md5(byte[] data) {
        try {
            return MessageDigest.getInstance("MD5").digest(data);
        } catch (Exception error) {
            throw new IllegalStateException("MD5 不可用", error);
        }
    }

    static byte[] sha512(byte[] data) {
        try {
            return MessageDigest.getInstance("SHA-512").digest(data);
        } catch (Exception error) {
            throw new IllegalStateException("SHA-512 不可用", error);
        }
    }

    static byte[] sm3(byte[] data) {
        SM3Digest digest = new SM3Digest();
        digest.update(data, 0, data.length);
        byte[] out = new byte[32];
        digest.doFinal(out, 0);
        return out;
    }

    /** PKCS#7 补齐：固定块长，即使已经对齐也补满一整块（客户端就是这么做的）。 */
    static byte[] pad16(byte[] data) {
        int pad = 16 - data.length % 16;
        byte[] out = new byte[data.length + pad];
        System.arraycopy(data, 0, out, 0, data.length);
        for (int i = data.length; i < out.length; i++) out[i] = (byte) pad;
        return out;
    }

    /** AES-CBC/NoPadding，data 必须已按 16 字节对齐（调用方用 pad16 补齐）。 */
    static byte[] aesCbc(byte[] data, byte[] key, byte[] iv) {
        if (data.length % 16 != 0) {
            throw new IllegalStateException("AES 加密失败（正文 " + data.length + " 字节未按 16 对齐）");
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/CBC/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new IvParameterSpec(iv));
            return cipher.doFinal(data);
        } catch (Exception error) {
            throw new IllegalStateException("AES 加密失败：" + error, error);
        }
    }

    static byte[] reverse(byte[] data) {
        byte[] out = new byte[data.length];
        for (int i = 0; i < data.length; i++) out[i] = data[data.length - 1 - i];
        return out;
    }

    static long u64(int value) { return value & 0xFFFFFFFFL; }

    /** protobuf varint：值按 32 位无符号截断，负数展开成 5 字节。 */
    static byte[] varint(long value) {
        long n = value & 0xFFFFFFFFL;
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        while (n >= 128) {
            out.write((int) (n & 127) | 128);
            n >>>= 7;
        }
        out.write((int) n);
        return out.toByteArray();
    }

    /** 极简 protobuf 编码器：只要 varint / bytes / 嵌套消息三种。 */
    static final class Proto {
        private final ByteArrayOutputStream out = new ByteArrayOutputStream();

        Proto varintField(int tag, long value) {
            write(varint((long) tag << 3));
            write(varint(value));
            return this;
        }

        Proto bytesField(int tag, byte[] value) {
            write(varint(((long) tag << 3) | 2));
            write(varint(value.length));
            write(value);
            return this;
        }

        Proto utf8Field(int tag, String value) {
            return bytesField(tag, value == null ? new byte[0] : value.getBytes(StandardCharsets.UTF_8));
        }

        Proto messageField(int tag, Proto value) {
            return bytesField(tag, value.toBytes());
        }

        private void write(byte[] data) { out.write(data, 0, data.length); }

        byte[] toBytes() { return out.toByteArray(); }
    }

    /** 从 query 原文里取参数值（与服务器看到的一致；解码失败时原样返回）。 */
    static String queryParam(String query, String name) {
        if (query == null) return null;
        for (String part : query.split("&")) {
            int at = part.indexOf('=');
            String key = at < 0 ? part : part.substring(0, at);
            if (decode(key).equals(name)) return decode(at < 0 ? "" : part.substring(at + 1));
        }
        return null;
    }

    private static String decode(String value) {
        try {
            return java.net.URLDecoder.decode(value, "UTF-8");
        } catch (Exception error) {
            return value;
        }
    }

    // ---------------- Simon（4 个 u64 轮密钥字 / 72 轮） ----------------

    static long[] simonKeys(long[] key) {
        long[] expanded = new long[72];
        System.arraycopy(key, 0, expanded, 0, 4);
        for (int i = 4; i < 72; i++) {
            long tmp = Long.rotateRight(expanded[i - 1], 3) ^ expanded[i - 3];
            tmp ^= Long.rotateRight(tmp, 1);
            long bit = (0x3dc94c3a046d678bL >>> ((i - 4) % 62)) & 1L;
            expanded[i] = ~expanded[i - 4] ^ tmp ^ bit ^ 3L;
        }
        return expanded;
    }

    static long[] simonEncrypt(long left, long right, long[] roundKeys) {
        long x = left;
        long y = right;
        for (long key : roundKeys) {
            long previous = y;
            y = x ^ (Long.rotateLeft(y, 1) & Long.rotateLeft(y, 8)) ^ Long.rotateLeft(y, 2) ^ key;
            x = previous;
        }
        return new long[]{x, y};
    }

    static void writeLe64(byte[] target, int offset, long value) {
        for (int i = 0; i < 8; i++) target[offset + i] = (byte) (value >>> (8 * i));
    }

    static long readLe64(byte[] data, int offset) {
        long value = 0;
        for (int i = 7; i >= 0; i--) value = (value << 8) | (data[offset + i] & 0xFFL);
        return value;
    }

    // ---------------- 551 Argus ----------------

    static byte[] bodyHash(String stubHex) {
        byte[] source;
        if (stubHex == null || stubHex.isEmpty()) source = new byte[16];
        else if (stubHex.matches("(?i)([0-9a-f]{2})+")) source = hex(stubHex);
        else source = new byte[0];
        byte[] digest = sm3(source);
        byte[] out = new byte[6];
        System.arraycopy(digest, 0, out, 0, 6);
        return out;
    }

    static byte[] queryHash(String query) {
        byte[] digest = sm3(query == null || query.isEmpty()
                ? new byte[16] : query.getBytes(StandardCharsets.UTF_8));
        byte[] out = new byte[6];
        System.arraycopy(digest, 0, out, 0, 6);
        return out;
    }

    static String argus(String query, String stubHex, long ts, long aid, long licenseId,
                        String deviceId, String installId, int randField) {
        String versionName = queryParam(query, "version_name");
        Proto bean = new Proto()
                .varintField(1, 1077940818)
                .varintField(2, 2)
                .varintField(3, randField)
                .utf8Field(4, String.valueOf(aid == 0 ? 1967 : aid))
                .utf8Field(5, deviceId)
                .utf8Field(6, String.valueOf(licenseId == 0 ? LICENSE_ID : licenseId))
                .utf8Field(7, versionName == null ? "" : versionName)
                .utf8Field(8, "v04.04.05-ov-android")
                .varintField(9, 134744640)
                .bytesField(10, new byte[8])
                .varintField(11, 0)
                .varintField(12, ts << 1)
                .bytesField(13, bodyHash(stubHex))
                .bytesField(14, queryHash(query))
                .messageField(15, new Proto().varintField(1, 1).varintField(2, 1).varintField(3, 1).varintField(7, 0xc792ecccL))
                .utf8Field(16, installId)
                .utf8Field(20, "none")
                .varintField(21, 738)
                .messageField(23, new Proto().utf8Field(1, "NX551J").varintField(2, 8196).varintField(4, 0x80e0d800L))
                .varintField(25, 2);

        byte[] protobuf = pad16(bean.toBytes());
        long[] roundKeys = simonKeys(new long[]{
                readLe64(SIGN_KEY, 0), readLe64(SIGN_KEY, 8),
                readLe64(SIGN_KEY, 16), readLe64(SIGN_KEY, 24)});
        byte[] blocks = new byte[protobuf.length];
        for (int at = 0; at < protobuf.length; at += 16) {
            long[] encrypted = simonEncrypt(readLe64(protobuf, at), readLe64(protobuf, at + 8), roundKeys);
            writeLe64(blocks, at, encrypted[0]);
            writeLe64(blocks, at + 8, encrypted[1]);
        }
        byte[] framed = new byte[MAGIC8.length + blocks.length + TAIL9.length];
        System.arraycopy(MAGIC8, 0, framed, 0, MAGIC8.length);
        System.arraycopy(blocks, 0, framed, MAGIC8.length, blocks.length);
        System.arraycopy(TAIL9, 0, framed, MAGIC8.length + blocks.length, TAIL9.length);
        for (int i = 8; i < framed.length; i++) framed[i] ^= MAGIC8[i % 8];

        byte[] reversed = reverse(framed);
        byte[] payload = new byte[reversed.length + 2];
        System.arraycopy(reversed, 0, payload, 0, reversed.length);
        payload[reversed.length] = 'a';
        payload[reversed.length + 1] = 'o';
        byte[] cipherText = aesCbc(pad16(payload), AES_KEY, AES_IV);
        byte[] out = new byte[2 + cipherText.length];
        out[0] = (byte) 0xf2;
        out[1] = (byte) 0x81;
        System.arraycopy(cipherText, 0, out, 2, cipherText.length);
        return android.util.Base64.encodeToString(out, android.util.Base64.NO_WRAP);
    }

    // ---------------- Ladon ----------------

    static String ladon(long ts, long licenseId, long aid, byte[] randomBytes) {
        String aidText = String.valueOf(aid);
        byte[] digest = md5(concat(randomBytes, aidText.getBytes(StandardCharsets.UTF_8)));
        String asciiText = hex(digest);   // 32 个十六进制字符，按 ASCII 参与运算
        byte[] ascii = asciiText.getBytes(StandardCharsets.US_ASCII);

        long[] words = new long[]{readLe64(ascii, 0), readLe64(ascii, 8), readLe64(ascii, 16), readLe64(ascii, 24)};
        List<Long> table = new ArrayList<>();
        table.add(words[0]);
        List<Long> queue = new ArrayList<>();
        queue.add(words[2]);
        queue.add(words[3]);
        long b0 = words[0];
        long b8 = words[1];
        for (int i = 0; i < 34; i++) {
            long x8 = (Long.rotateRight(b8, 8) + b0) ^ i;
            queue.add(x8);
            x8 ^= Long.rotateLeft(b0, 3);
            table.add(x8);
            b0 = x8;
            b8 = queue.remove(0);
        }

        byte[] input = pad16((ts + "-" + licenseId + "-" + aidText).getBytes(StandardCharsets.US_ASCII));
        byte[] out = new byte[input.length];
        for (int at = 0; at < input.length; at += 16) {
            long a = readLe64(input, at);
            long b = readLe64(input, at + 8);
            for (int i = 0; i < 34; i++) {
                b = table.get(i) ^ (a + Long.rotateRight(b, 8));
                a = b ^ Long.rotateLeft(a, 3);
            }
            writeLe64(out, at, a);
            writeLe64(out, at + 8, b);
        }
        return android.util.Base64.encodeToString(concat(randomBytes, out), android.util.Base64.NO_WRAP);
    }

    static byte[] concat(byte[] first, byte[] second) {
        byte[] out = new byte[first.length + second.length];
        System.arraycopy(first, 0, out, 0, first.length);
        System.arraycopy(second, 0, out, first.length, second.length);
        return out;
    }

    /**
     * 生成播放请求的全部签名头。
     *
     * @param query    最终放到 URL 上的 query 原文（不含 '?'）
     * @param body     实际发送的 body（POST 是 gzip 后的字节；GET 传 null）
     * @param ts       秒级时间戳，x-khronos 用的就是它
     * @param deviceId 注册返回的 device_id
     * @param installId 注册返回的 iid
     * @return 头名 -> 值，直接塞进请求即可
     */
    static java.util.Map<String, String> signPlayer(String query, byte[] body, long ts,
                                                    String deviceId, String installId) {
        String aidText = queryParam(query, "aid");
        long aid = 1967;
        if (aidText != null && aidText.matches("[+-]?\\d+")) {
            try { aid = Long.parseLong(aidText); } catch (NumberFormatException ignored) { }
        }
        String stub = (body != null && body.length > 0) ? hex(md5(body)) : "";
        int randField = RANDOM.nextInt();
        byte[] ladonRandom = new byte[4];
        RANDOM.nextBytes(ladonRandom);

        java.util.LinkedHashMap<String, String> headers = new java.util.LinkedHashMap<>();
        headers.put("x-ss-req-ticket", String.valueOf(ts * 1000));
        headers.put("x-khronos", String.valueOf(ts));
        headers.put("x-ladon", ladon(ts, LICENSE_ID, aid, ladonRandom));
        headers.put("x-argus", argus(query, stub, ts, aid, LICENSE_ID, deviceId, installId, randField));
        if (!stub.isEmpty()) headers.put("x-ss-stub", stub);
        return headers;
    }
}
