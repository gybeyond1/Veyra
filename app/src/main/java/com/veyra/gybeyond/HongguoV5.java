package com.veyra.gybeyond;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 红果 Android v5 播放签名（协议版本 v04.10.03）。
 *
 * 2026-11 之后，站方把播放接口换成了
 *   /novel/player/multi_video_model/player/v1
 * 并要求「v5 Medusa / Helios」签名：老的 551 Argus + Ladon、8402 Argus 一律
 * 回 HTTP 200 + 空正文。这里按官方协议把三段算法逐字节实现：
 *
 *   hashF13   ：query 的 SM3 + body 的 MD5 参与 112 项扩展与 96 轮滚动，
 *               输出 20 字节（16 字节折叠 + 4 字节校验，末位按 v5 置 bit5）
 *   medusaV5  ：protobuf(设备/时间/摘要/query 前缀) -> 帧头异或 -> 逆序
 *               -> 自研 AES 变体（另一张 sbox / 置换表）-> base64
 *   helios    ：md5(rand|aid) 生成 35 项字表，对 "ts-license-aid" 做 34 轮 Feistel
 *
 * 签名绑定「最终 query 原文 + 实际发送的 body 字节」：query 多一个字符、
 * body 差一个字节，服务端算出来的摘要就对不上，还是空响应。
 *
 * 算法常量（magic / signKey / sbox / hashTable / license）是客户端协议里的公开值，
 * 与本项目同源的 GPL-3.0 实现互相印证；不含任何账号凭证或采集到的会话数据。
 * 本类不依赖 Android，可直接用 JVM 对拍测试向量。
 */
final class HongguoV5 {
    static final byte[] MAGIC = hex(
            "2d4b4fca49750d433fb5ae2c226dcc56");
    static final String LICENSE = "646637794";
    static final byte[] SIGN_KEY = hex(
            "b23c2a470a20d105dc3f8c4438f8272ed46d6c89ffdcdedd5108698d26e9489d");

    /** v5 专用 sbox：4 组 256 字节，按时间戳低 2 位选组。 */
    private static final byte[] SBOX = hex(
            "53290fe9e51f316f90f74a7e034d367784ab49237cd0135cdc632c322fd3be0e2624a417ecd9151a7ff64f60730a87f9445ec6ada2f865d22b696c4188f24c0d"
            + "f37b75510b939f6bc2fe6883e68bc8c722181ba0bdb08c9871b50c9a16b46eea8eed20ba4b8a14e0fcf1468dbbef05a93e5a9d7dcf06898635c1fd99f5de287a"
            + "80c594daaab19b6279fbd75070cb52eb2555c456e39e7839853874e2f0013ac0b64742d8ca10e4b79c955de8b843ce4ed464a6a72ed508091c92e7b3eedd1e1d"
            + "d12afac321618fa3d65f9167c982f43d66a53c6a1997585b346dbf9672ff37cdbc073b2dae11453304df00815476b2a13fccdb30b957a8acafe1274002485912"
            + "38922563e36406d37a24100b7902a028044e218453c2a399199c9d13dc40c55ba67e502273850ebdc1a2e2188b8f2d9e3cb909b8c46a2a9f4a6dd93007eafa65"
            + "b7b3a881aa908cc74f0ad76bbbb58617c37012ca05a469fd44e62eecf1e4272ce860c0ae5eadf99b20d8f0234174006f3f110d7657d01645d4eff8f71471cbfe"
            + "1cb2f52648727bf3c9de55153e031b4d61757db63dbf7782eeafe9018a8891362fb14759ac32bab03b349aeb5a377c5156be4c8dfbe13a684bda39cf836697c8"
            + "94545fe0f2491acea9fc6252f4ff1e0fe72bd2df6e67a7f635e5bcc6d1a5dd951d89960887a18eb40c785cdb1f80ed42299333ab98cdd67f316cd54346585dcc"
            + "d759fb722789b08807cc0fda293f7e5e1819bb0353517020b31d3d00374952bea2c421e862040a9ec892a05b266b7a0d0cc316f483b81af39715657ffe32ad8d"
            + "e0c13077646035236ee5363e5f900e9a7cf850a81cd9960b6df73317226f99eaa6fff15cec34acb98246639b918ab2851466a7cdfc4ad1b52c2ae95a58d3734e"
            + "47ddd5b7560193f644ef9c408b7dee39b4d6aabf4de761e3252d4c7ba3843187745d55e6a5db05d42b45caed43c0c5d0b64bfa9d94a4a9d8f2f0e1a108dcfd28"
            + "8fd2bc1fc7bd675412138169cb09249875ba3b68cfb11180afae104fc9789571c6dfce02413886796ae21e3c488cc21b9f423a066c2eabf98e2fdeeb5776e4f5"
            + "d09a515ba58cbbab3e37b09fd4f6d9244df80512e84cd7956be301cf64f1429d58577cc241f3a2c655144f81aaf95a4e108da894b38970561ae9002619fbbac9"
            + "1fa922ed202bfc62cb08e0de2a7f3631435f8b47c8a3c563b4db4071ce74c46da6fa696a9e282d1e825d663b93bfd56c48dce1884bb10fccea063929f746443f"
            + "d830a4232e53da21a1f2d1bdfebc3a02c10a1b8ad31d04fd616590d272ac737e98eb33af60528716bee78ec0ee8699031177277d9cff32542c67caf5f4459168"
            + "1335ae0e178f3409a7803db83892dde5b9b7f0c750e24aef077badd678a09b850b84ec1597e4963cb5e675df1c0d6fb618496ecd76c35c798325590c2fb27a5e");

    /** 与旧签名共用的 64 项轮常量表（v5 只是换了 seed / 轮数 / 状态选择）。 */
    private static final int[] HASH_TABLE = {
            0xebb64faf, 0x07aadcc2, 0xcf3187bf, 0xe01138ff, 0x6d0bfcff, 0x5a30a3be, 0xb41ad638, 0x34180eb8,
            0xf233eb6f, 0xb1a584cc, 0xccc30dc7, 0x47d1db51, 0xd55653de, 0x70a84fa1, 0x57473c12, 0xf76f0288,
            0x2c077f0a, 0xda0dcad0, 0xfbb86f6c, 0xfdc4cf00, 0x688a020d, 0xe676c6a6, 0x8cd6338b, 0x1a3c8d0e,
            0xcce8b06b, 0x6ad0ed0b, 0xa0522717, 0xdc71ac83, 0x2285db71, 0xd5b4dda6, 0x736f8650, 0x6560306c,
            0x617ce2a6, 0xe423417e, 0x0a40e143, 0x544e4032, 0x88dffb2a, 0x716c1ae0, 0x4c467a88, 0x05b23bb3,
            0xe1d0b866, 0xbaa3dcb8, 0xae3374d3, 0xc3381a50, 0x1702f75b, 0xfe6da368, 0xf0b4cf48, 0x4e0ffbb8,
            0x72aad10d, 0x26c53a3d, 0xf2bce0f6, 0xb4557581, 0x4a257fdd, 0x8c3182a2, 0xab0b3b86, 0x3d5dfb14,
            0x4f103634, 0xd37b52d7, 0x444eff16, 0xeb0a33d1, 0x6ca86f6e, 0x00284ba7, 0x08387cfa, 0x5fb37586,
    };

    /* v5 的 AES 变体参数：按时间戳低 2 位选一组。 */
    private static final int[][] AES_CON = {
            {2, 0, 3, 1}, {1, 3, 2, 0}, {3, 2, 1, 0}, {2, 3, 1, 0},
    };
    private static final int[][] AES_ORDER = {
            {0, 9, 14, 15, 4, 13, 2, 7, 8, 1, 6, 3, 12, 5, 10, 11},
            {0, 9, 14, 11, 4, 13, 2, 3, 8, 1, 6, 15, 12, 5, 10, 7},
            {0, 9, 14, 3, 4, 13, 2, 15, 8, 1, 6, 11, 12, 5, 10, 7},
            {0, 9, 14, 15, 4, 13, 2, 3, 8, 1, 6, 11, 12, 5, 10, 7},
    };
    private static final int[] AES_INITIAL = {
            0xbbb5de72, 0xd4638d5b, 0x92a5f73b, 0x89f8a1c9,
    };
    private static final int[] AES_WIRE = {6, 5, 3, 4, 2, 7, 1, 0};
    private static final int[] AES_COMPACT = {1, 7, 3, 6, 2, 0, 4, 5};

    private static final SecureRandom RANDOM = new SecureRandom();
    /** 进程 nonce：官方客户端每次冷启动随机一次，写进 medusa 明文。 */
    private static final String PROCESS_NONCE;
    private static final long PROCESS_STARTED = System.currentTimeMillis();

    static {
        byte[] raw = new byte[18];
        RANDOM.nextBytes(raw);
        PROCESS_NONCE = Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
    }

    private HongguoV5() { }

    // ---------------- 基础工具 ----------------

    static byte[] hex(String value) {
        byte[] out = new byte[value.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(value.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    static String hexText(byte[] data) {
        StringBuilder sb = new StringBuilder(data.length * 2);
        for (byte b : data) sb.append(String.format("%02x", b & 0xFF));
        return sb.toString();
    }

    static byte[] md5(byte[] data) {
        try {
            return MessageDigest.getInstance("MD5").digest(data);
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }

    static byte[] concat(byte[] first, byte[] second) {
        byte[] out = new byte[first.length + second.length];
        System.arraycopy(first, 0, out, 0, first.length);
        System.arraycopy(second, 0, out, first.length, second.length);
        return out;
    }

    static byte[] reverse(byte[] data) {
        byte[] out = new byte[data.length];
        for (int i = 0; i < data.length; i++) out[i] = data[data.length - 1 - i];
        return out;
    }

    static int rol(int value, int bits) { return Integer.rotateLeft(value, bits); }

    static byte[] le32(int value) {
        return new byte[]{(byte) value, (byte) (value >>> 8), (byte) (value >>> 16), (byte) (value >>> 24)};
    }

    static byte[] be32(int value) {
        return new byte[]{(byte) (value >>> 24), (byte) (value >>> 16), (byte) (value >>> 8), (byte) value};
    }

    static byte[] le64(long value) {
        byte[] out = new byte[8];
        for (int i = 0; i < 8; i++) out[i] = (byte) (value >>> (8 * i));
        return out;
    }

    /** 大端读 4 字节（hashF13 的 112 项扩展用大端）。 */
    static int i32(byte[] data, int at) {
        return ((data[at] & 255) << 24) | ((data[at + 1] & 255) << 16)
                | ((data[at + 2] & 255) << 8) | (data[at + 3] & 255);
    }

    static long i64le(byte[] data, int at) {
        long value = 0;
        for (int i = 7; i >= 0; i--) value = (value << 8) | (data[at + i] & 0xFFL);
        return value;
    }

    private static byte[] xorKey(byte[] data, byte[] key) {
        byte[] out = new byte[data.length];
        for (int i = 0; i < data.length; i++) out[i] = (byte) (data[i] ^ key[i % key.length]);
        return out;
    }

    // ---------------- SM3 ----------------

    private static final int[] SM3_IV = {
            0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600,
            0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e,
    };

    private static int p0(int x) { return x ^ rol(x, 9) ^ rol(x, 17); }

    private static int p1(int x) { return x ^ rol(x, 15) ^ rol(x, 23); }

    static byte[] sm3(byte[] input) {
        int total = ((input.length + 9 + 63) / 64) * 64;
        byte[] message = new byte[total];
        System.arraycopy(input, 0, message, 0, input.length);
        message[input.length] = (byte) 0x80;
        long bits = (long) input.length * 8;
        for (int i = 0; i < 8; i++) message[total - 1 - i] = (byte) (bits >>> (8 * i));

        int[] v = SM3_IV.clone();
        int[] w = new int[68];
        int[] w1 = new int[64];
        for (int off = 0; off < total; off += 64) {
            for (int i = 0; i < 16; i++) {
                w[i] = ((message[off + i * 4] & 255) << 24)
                        | ((message[off + i * 4 + 1] & 255) << 16)
                        | ((message[off + i * 4 + 2] & 255) << 8)
                        | (message[off + i * 4 + 3] & 255);
            }
            for (int i = 16; i < 68; i++) {
                w[i] = p1(w[i - 16] ^ w[i - 9] ^ rol(w[i - 3], 15)) ^ rol(w[i - 13], 7) ^ w[i - 6];
            }
            for (int i = 0; i < 64; i++) w1[i] = w[i] ^ w[i + 4];
            int a = v[0], b = v[1], c = v[2], d = v[3], e = v[4], f = v[5], g = v[6], h = v[7];
            for (int j = 0; j < 64; j++) {
                int t = j < 16 ? 0x79cc4519 : 0x7a879d8a;
                int ss1 = rol(rol(a, 12) + e + rol(t, j), 7);
                int ss2 = ss1 ^ rol(a, 12);
                int ff = j < 16 ? (a ^ b ^ c) : ((a & b) | (a & c) | (b & c));
                int gg = j < 16 ? (e ^ f ^ g) : ((e & f) | (~e & g));
                int tt1 = ff + d + ss2 + w1[j];
                int tt2 = gg + h + ss1 + w[j];
                d = c;
                c = rol(b, 9);
                b = a;
                a = tt1;
                h = g;
                g = rol(f, 19);
                f = e;
                e = p0(tt2);
            }
            v[0] ^= a; v[1] ^= b; v[2] ^= c; v[3] ^= d;
            v[4] ^= e; v[5] ^= f; v[6] ^= g; v[7] ^= h;
        }
        byte[] out = new byte[32];
        for (int i = 0; i < 8; i++) {
            out[i * 4] = (byte) (v[i] >>> 24);
            out[i * 4 + 1] = (byte) (v[i] >>> 16);
            out[i * 4 + 2] = (byte) (v[i] >>> 8);
            out[i * 4 + 3] = (byte) v[i];
        }
        return out;
    }

    // ---------------- hashF13 ----------------

    private static int getIv(int initial, byte[] data) {
        int value = initial;
        for (int i = 0; i < data.length; i++) {
            int item = data[i] & 255;
            if ((i & 1) == 0) value = (value >>> 4) ^ value ^ (value << 6) ^ item;
            else value = ~((value >>> 7) ^ value ^ (item | (value << 12)));
        }
        return value;
    }

    private static int iv(byte[] query, byte[] body, int ts) {
        return getIv(getIv(getIv(0x20230928, query), body), le32(ts));
    }

    /**
     * v5 只接受 hash 分支 0，也就是 iv 低 4 位等于 12；
     * 请求前要循环调 _rticket 直到落进这个分支。
     */
    static int branch(String query, byte[] body, int ts) {
        int low = iv(sm3(query.getBytes(StandardCharsets.UTF_8)),
                body == null ? new byte[16] : md5(body), ts) & 15;
        return low == 12 ? 0 : 1;
    }

    private static int sumMd5(byte[] data) {
        int check = 0x20220420;
        for (int i = 0; i < 12; i++) {
            int temp = (check >>> ((i & 1) == 0 ? 3 : 5)) ^ check;
            if ((i & 1) == 0) check = (data[i] & 255) ^ (check << 7);
            else check = ~((data[i] & 255) | (check << 11));
            check = check ^ temp;
        }
        return (check | 4) ^ 0x1000000;
    }

    /** query 传 SM3 后的 32 字节，body 传 MD5 后的 16 字节。 */
    static byte[] hashF13(byte[] query, byte[] body, int ts) {
        int ivv = iv(query, body, ts);
        int seedBase = 0x9d4a97c2;
        int count = seedBase + ts;
        int[] table = new int[64];
        for (int i = 0; i < 64; i++) table[i] = Integer.rotateRight(HASH_TABLE[i], (count + 1) & 255);

        int shift = (count + 2) & 7;
        int[] pads = {0xfa, 0x45, 0x61, 0xd7};
        byte[] pad = new byte[4];
        for (int i = 0; i < 4; i++) pad[i] = (byte) ((pads[i] | (pads[i] << 8)) >> shift);

        byte[] data = concat(concat(concat(concat(query, body), le32(ts)), pad),
                hex("00000000000001a0"));
        int words = data.length / 4;
        int[] di = new int[words + 112];
        for (int i = 0; i < words; i++) di[i] = i32(data, i * 4);
        for (int i = 0; i < 112; i++) {
            int x = di[i + 1];
            int y = di[i + 14];
            di[words + i] = di[i] + di[i + 9]
                    + (rol(x, 14) ^ rol(x, 25) ^ (x >>> 3))
                    + (rol(y, 13) ^ rol(y, 15) ^ (y >>> 10));
        }

        int[] initial = {
                0x7aba4fc8, 0x67166507, 0x6403fa00, 0x340f512f,
                984304912, (int) 3005047866L, (int) 2874125293L, (int) 2152413264L,
        };
        for (int i = 0; i < 8; i++) initial[i] = Integer.rotateRight(initial[i], count);

        int[] chosen = {96, 1, 3, 4, 0, 6, 5, 2, 0, 7, 7};
        List<Integer> state = new ArrayList<>(104);
        for (int value : initial) state.add(value);
        for (int i = 0; i < chosen[0]; i++) {
            int base = seedBase + i;
            int n1 = ((state.get(chosen[3]) ^ state.get(chosen[4])) & state.get(chosen[1])) ^ state.get(chosen[3]);
            int n2 = rol(state.get(chosen[1]), 26) ^ rol(state.get(chosen[1]), 21) ^ rol(state.get(chosen[1]), 7);
            int n4 = di[base & 127] + n1 + n2 + table[base & 63] + state.get(chosen[5]);
            int n5 = rol(state.get(chosen[2]), 30) ^ rol(state.get(chosen[2]), 19) ^ rol(state.get(chosen[2]), 10);
            int n6 = (state.get(chosen[2]) & state.get(chosen[6]))
                    | ((state.get(chosen[2]) | state.get(chosen[6])) & state.get(chosen[7]));
            int moved = state.get(chosen[9]);
            state.add(0, state.remove(chosen[9]));
            state.set(chosen[10], n5 + n6 + n4);
            state.set(chosen[8], moved + n4);
        }

        ByteArrayOutputStream buffer = new ByteArrayOutputStream(32);
        for (int i = 0; i < 8; i++) buffer.write(be32(state.get(i) + initial[i]), 0, 4);
        byte[] ret = buffer.toByteArray();
        byte[] folded = new byte[16];
        for (int i = 0; i < 16; i++) folded[i] = (byte) (ret[i] ^ ret[i + 16]);
        byte[] out = new byte[20];
        System.arraycopy(folded, 0, out, 0, 16);
        System.arraycopy(le32(sumMd5(folded) | 0x20), 0, out, 16, 4);
        return out;
    }

    // ---------------- 自研 AES 变体（v5） ----------------

    static final class Cipher {
        private final int[] box = new int[256];
        private final int[] con;
        private final int[] order;
        private final int[][] keys = new int[12][4];

        Cipher(byte[] key, int ts) {
            int word = ts & 3;
            for (int i = 0; i < 256; i++) box[i] = SBOX[word * 256 + i] & 255;
            con = AES_CON[word];
            order = AES_ORDER[word];
            int initial = AES_INITIAL[word];

            byte[] seed = le32(initial);
            int[] expanded = new int[48];
            for (int i = 0; i < 16; i++) expanded[i] = (seed[i % 4] ^ key[i]) & 255;
            int rounds = 8;
            for (int i = 4; i < 12; i++) {
                int at = 4 * (i - 1);
                int a = expanded[at];
                int b = expanded[at + 1];
                int c = expanded[at + 2];
                int d = expanded[at + 3];
                if ((i & 3) == 0) {
                    int swap = ((initial >>> (rounds & 24)) ^ box[b]) & 255;
                    b = box[c];
                    c = box[d];
                    d = box[a];
                    a = swap;
                }
                rounds += 2;
                expanded[at + 4] = a ^ expanded[at - 12];
                expanded[at + 5] = b ^ expanded[at - 11];
                expanded[at + 6] = c ^ expanded[at - 10];
                expanded[at + 7] = d ^ expanded[at - 9];
            }
            for (int i = 0; i < 12; i++) System.arraycopy(expanded, i * 4, keys[i], 0, 4);
        }

        private static int xt(int value) {
            return ((value << 1) ^ ((value & 128) != 0 ? 0x1b : 0)) & 255;
        }

        private void addCon(int[][] rows, int offset) {
            for (int i = 0; i < 4; i++) {
                for (int j = 0; j < 4; j++) rows[i][j] ^= keys[offset + i][con[j]];
            }
        }

        private byte[] block(byte[] value) {
            int[][] rows = new int[4][4];
            for (int i = 0; i < 4; i++) {
                for (int j = 0; j < 4; j++) rows[i][j] = value[i * 4 + j] & 255;
            }
            addCon(rows, 0);
            for (int round = 1; round <= 2; round++) {
                for (int i = 0; i < 4; i++) {
                    for (int j = 0; j < 4; j++) rows[i][j] = box[rows[i][j]];
                }
                int[][] before = new int[4][4];
                for (int i = 0; i < 4; i++) before[i] = rows[i].clone();
                for (int i = 0; i < 4; i++) rows[i] = before[con[i]].clone();
                int[] flat = new int[16];
                for (int i = 0; i < 4; i++) {
                    for (int j = 0; j < 4; j++) flat[i * 4 + j] = rows[i][j];
                }
                for (int i = 0; i < 16; i++) rows[i / 4][i % 4] = flat[order[i]];
                if (round == 1) {
                    for (int i = 0; i < 4; i++) {
                        int[] old = rows[i].clone();
                        for (int j = 0; j < 4; j++) rows[i][j] = old[con[j]];
                    }
                    for (int i = 0; i < 4; i++) {
                        int t = rows[0][i] ^ rows[1][i] ^ rows[2][i] ^ rows[3][i];
                        int head = rows[0][i];
                        rows[0][i] ^= t ^ xt(rows[0][i] ^ rows[1][i]);
                        rows[1][i] ^= t ^ xt(rows[1][i] ^ rows[2][i]);
                        rows[2][i] ^= t ^ xt(rows[2][i] ^ rows[3][i]);
                        rows[3][i] ^= t ^ xt(rows[3][i] ^ head);
                    }
                }
                addCon(rows, round * 4);
            }
            byte[] out = new byte[16];
            for (int i = 0; i < 4; i++) {
                for (int j = 0; j < 4; j++) out[i * 4 + j] = (byte) (rows[i][j] ^ keys[4 + i][j]);
            }
            return out;
        }

        byte[] encrypt(byte[] source, byte[] iv) {
            byte[] plain = new byte[32];
            for (int i = 0; i < 31; i++) {
                for (int j = 0; j < 8; j++) {
                    int bit = ((source[i * 8 + j] & 255) >>> AES_WIRE[j]) & 1;
                    plain[i] = (byte) ((plain[i] & 255) | (bit << AES_COMPACT[j]));
                }
            }
            plain[31] = 1;

            byte[] first = block(xorKey(slice(plain, 0, 16), iv));
            byte[] second = block(xorKey(slice(plain, 16, 32), first));
            byte[] key = concat(first, second);

            byte[] out = source.clone();
            for (int i = 0; i < 31; i++) {
                for (int j = 0; j < 8; j++) {
                    int at = i * 8 + j;
                    int bit = ((key[i] & 255) >>> AES_COMPACT[j]) & 1;
                    out[at] = (byte) ((out[at] & ~(1 << AES_WIRE[j])) | (bit << AES_WIRE[j]));
                }
            }
            return concat(new byte[]{key[31]}, out);
        }

        private static byte[] slice(byte[] data, int from, int to) {
            byte[] out = new byte[to - from];
            System.arraycopy(data, from, out, 0, out.length);
            return out;
        }
    }

    // ---------------- 字节混淆（medusa 明文） ----------------

    private static byte[] xmxor(byte[] data, byte[] key) {
        int size = data.length;
        int[] encoded = new int[size];
        for (int i = 0; i < size; i++) {
            int at = (i * 4) & 28;
            int d0 = key[at] & 255;
            int d1 = key[at + 1] & 255;
            int value = data[i] & 255;
            int mixed = (((value << 4) | (value >>> 4)) & 255) + d0;
            mixed = (~mixed) ^ d1;
            mixed = (((mixed & 255) << 3) | ((mixed & 255) >>> 5)) & 255;
            mixed = (mixed + d1) & 255;
            mixed = (mixed ^ d0) & 255;
            encoded[size - i - 1] = (~mixed) & 255;
        }
        int last = encoded[size - 1] ^ encoded[size - 2];
        int first = encoded[0];
        encoded[0] = ((~last) + first) & 255;
        encoded[1] = ((encoded[0] ^ encoded[size - 1] ^ 254) + encoded[1]) & 255;
        encoded[2] = (encoded[2] + ((last - first)
                ^ (((encoded[1] << 3) | (encoded[1] >>> 5)) & 255) ^ 2)) & 255;
        for (int i = 0; i < size - 4; i++) {
            int temp = (((encoded[i + 2] << 3) | (encoded[i + 2] >>> 5)) & 255)
                    ^ encoded[i + 1] ^ (i + 3);
            encoded[i + 3] = ((~temp) + encoded[i + 3]) & 255;
        }
        encoded[size - 1] = encoded[size - 1] ^ encoded[size - 2];
        int sum = 0;
        for (int i = 1; i < size; i++) sum += encoded[i];
        encoded[0] = ((encoded[0] ^ encoded[1]) + sum) & 255;

        byte[] out = new byte[size];
        for (int i = 0; i < size; i++) out[i] = (byte) encoded[i];
        return out;
    }

    /**
     * ByteArrayOutputStream.write(byte[]) 在 API 33 才随 Java 11 提供，
     * 电视盒子多为 Android 9~11，直接调会在运行期抛 NoSuchMethodError。
     */
    private static void emit(ByteArrayOutputStream out, byte[] data) {
        out.write(data, 0, data.length);
    }

    // ---------------- protobuf 编码 ----------------

    private static final class Proto {
        private final ByteArrayOutputStream out = new ByteArrayOutputStream();

        Proto sint(int tag, long value) {
            emit(out, varint((long) tag << 3));
            emit(out, varint(value < 0 ? -value * 2 - 1 : value * 2));
            return this;
        }

        Proto text(int tag, String value) {
            if (value == null || value.isEmpty()) return this;
            return bytes(tag, value.getBytes(StandardCharsets.UTF_8));
        }

        Proto bytes(int tag, byte[] value) {
            if (value == null || value.length == 0) return this;
            emit(out, varint(((long) tag << 3) | 2));
            emit(out, varint(value.length));
            emit(out, value);
            return this;
        }

        byte[] done() { return out.toByteArray(); }
    }

    private static byte[] varint(long value) {
        long remaining = value;
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        while (remaining > 127) {
            out.write((int) ((remaining & 127) | 128));
            remaining = remaining >>> 7;
        }
        out.write((int) remaining);
        return out.toByteArray();
    }

    // ---------------- Helios ----------------

    static String helios(int ts) {
        return helios(ts, RANDOM.nextInt());
    }

    /** 固定随机数的版本，供离线对拍使用。 */
    static String helios(int ts, int random) {
        byte[] ascii = hexText(md5(concat(le32(random), "8662".getBytes(StandardCharsets.UTF_8))))
                .getBytes(StandardCharsets.US_ASCII);

        long w0 = i64le(ascii, 0);
        long w1 = i64le(ascii, 8);
        long w2 = i64le(ascii, 16);
        long w3 = i64le(ascii, 24);
        List<Long> table = new ArrayList<>(35);
        table.add(w0);
        List<Long> queue = new ArrayList<>(40);
        queue.add(w2);
        queue.add(w3);
        long b0 = w0;
        long b8 = w1;
        for (int i = 0; i < 34; i++) {
            long x8 = (Long.rotateRight(b8, 8) + b0) ^ i;
            queue.add(x8);
            x8 = x8 ^ Long.rotateRight(b0, 61);
            table.add(x8);
            b0 = x8;
            b8 = queue.remove(0);
        }

        byte[] text = (ts + "-" + LICENSE + "-8662").getBytes(StandardCharsets.US_ASCII);
        int padding = 16 - text.length % 16;
        byte[] data = new byte[text.length + padding];
        System.arraycopy(text, 0, data, 0, text.length);
        for (int i = text.length; i < data.length; i++) data[i] = (byte) padding;

        ByteArrayOutputStream out = new ByteArrayOutputStream();
        emit(out, le32(random));
        for (int at = 0; at < data.length; at += 16) {
            long a = i64le(data, at);
            long b = i64le(data, at + 8);
            for (int i = 0; i < 34; i++) {
                b = table.get(i) ^ (a + Long.rotateRight(b, 8));
                a = b ^ Long.rotateRight(a, 61);
            }
            emit(out, le64(a));
            emit(out, le64(b));
        }
        return Base64.getEncoder().encodeToString(out.toByteArray());
    }

    // ---------------- Medusa（v5） ----------------

    static String medusa(String url, byte[] body, int ts, Map<String, String> identity) {
        return medusa(url, body, ts, identity, RANDOM.nextInt(), RANDOM.nextInt(),
                RANDOM.nextInt(), PROCESS_NONCE, PROCESS_STARTED);
    }

    /** 固定随机数的版本，供离线对拍使用（nonce / randField / 进程 nonce / 进程启动时间）。 */
    static String medusa(String url, byte[] body, int ts, Map<String, String> identity,
                         int nonce, int randField, int packedRand, String processNonce,
                         long processStarted) {
        String query = url.substring(url.indexOf('?') + 1);
        byte[] queryHash = sm3(query.getBytes(StandardCharsets.UTF_8));
        byte[] bodyHash = body == null ? new byte[16] : md5(body);
        byte[] digest = hashF13(queryHash, bodyHash, ts);

        byte[] flags = new byte[8];
        String version = identity.get("version_name");
        String deviceId = identity.get("device_id");
        String deviceType = identity.get("device_type");
        String osVersion = identity.get("os_version");
        String channel = identity.get("channel");

        byte[] deviceInfo = new Proto()
                .sint(1, 1).sint(2, 2).text(3, "8662").text(4, deviceId)
                .text(5, processNonce).text(6, "!noperm!")
                .text(12, "Asia/Shanghai,8").text(13, "zh_CN")
                .text(22, osVersion).sint(25, processStarted)
                .text(30, deviceType).text(31, "HONOR")
                .text(32, deviceType).text(34, "HONOR")
                .done();

        byte[] env = new Proto()
                .text(6, "v04.10.03.04-bugfix").text(8, channel)
                .bytes(12, deviceInfo).text(14, version)
                .done();

        byte[] message = new Proto()
                .bytes(1, MAGIC).sint(2, 5).sint(3, randField & 0xFFFFFFFFL)
                .text(4, "8662").text(5, deviceId).text(6, LICENSE).text(7, version)
                .text(8, "v04.10.03-ml-android").sint(9, 0x040a0300L)
                .bytes(10, flags).sint(12, ts).bytes(13, digest)
                .bytes(14, slice(queryHash, 0, 6))
                .bytes(15, new Proto().sint(1, 1).sint(2, 1).sint(3, 1).sint(5, 1).done())
                .sint(17, ts).text(20, "none").sint(21, 369)
                .bytes(23, env)
                .text(24, "{\"cmr\":16777216,\"cmr2\":16777216,\"un_h\":11,\"vpn\":0,\"kd\":0,"
                        + "\"dyn\":\"\",\"do\":1,\"tk\":true}")
                .done();

        byte[] keyHash = sm3(concat(concat(SIGN_KEY, le32(nonce)), SIGN_KEY));
        int high = (nonce >>> 16) & 255;
        int mixed = ((high << 11) | (nonce >>> 24)) ^ (high >>> 5) ^ high;
        byte[] seed = le32(~mixed);

        byte[] transformed = reverse(concat(flags, xmxor(message, keyHash)));
        for (int i = 0; i < transformed.length; i++) transformed[i] ^= seed[(~i) & 3];

        int check = 0x18000001 | ((queryHash[0] & 63) << 14) | ((digest[0] & 63) << 8);
        byte[] packed = concat(
                concat(concat(new byte[]{(byte) 0xca}, le32(packedRand)), le32(check)),
                concat(transformed, new byte[]{(byte) (nonce >>> 16), (byte) (nonce >>> 24)}));

        byte[] cipherKey = md5(slice(SIGN_KEY, 0, 16));
        byte[] cipherIv = md5(slice(SIGN_KEY, 16, 32));
        byte[] encrypted = new Cipher(cipherKey, ts).encrypt(packed, cipherIv);

        byte[] prefix = concat(le32(5), MAGIC);
        byte[] tsBytes = le32(ts);
        for (int i = 0; i < prefix.length; i++) prefix[i] ^= tsBytes[i & 3];

        byte[] out = concat(
                concat(prefix, new byte[]{(byte) nonce, (byte) (nonce >>> 8), 0, 1}),
                encrypted);
        return Base64.getEncoder().encodeToString(out);
    }

    static byte[] slice(byte[] data, int from, int to) {
        byte[] out = new byte[to - from];
        System.arraycopy(data, from, out, 0, out.length);
        return out;
    }

    // ---------------- 播放请求签名 ----------------

    static final class Signed {
        final String url;
        final Map<String, String> headers;

        Signed(String url, Map<String, String> headers) {
            this.url = url;
            this.headers = headers;
        }
    }

    /** 与官方客户端一致：URLEncoder 后把 + 还原成 %20、%7E 还原成 ~。 */
    static String encode(String value) {
        try {
            return java.net.URLEncoder.encode(value, "UTF-8")
                    .replace("+", "%20").replace("%7E", "~");
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }

    static String encodeQuery(Map<String, String> values) {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> entry : values.entrySet()) {
            if (sb.length() > 0) sb.append('&');
            sb.append(encode(entry.getKey())).append('=').append(encode(entry.getValue()));
        }
        return sb.toString();
    }

    // ---------------- 通用接口签名（搜索 / 相关作品 / 详情 / 评论） ----------------

    static final String APP_UA =
            "com.phoenix.read/72232 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3)";

    /** 官方客户端基线设备参数（7.1.3.32）；搜索等接口在此基础上改写版本号。 */
    static final LinkedHashMap<String, String> DEVICE = new LinkedHashMap<>();
    static {
        DEVICE.put("iid", "1905892595382586");
        DEVICE.put("device_id", "1905892595378490");
        DEVICE.put("ac", "wifi");
        DEVICE.put("channel", "update_64");
        DEVICE.put("aid", "8662");
        DEVICE.put("app_name", "novelread");
        DEVICE.put("version_code", "71332");
        DEVICE.put("version_name", "7.1.3.32");
        DEVICE.put("device_platform", "android");
        DEVICE.put("os", "android");
        DEVICE.put("ssmix", "a");
        DEVICE.put("device_type", "25053RT47C");
        DEVICE.put("device_brand", "Redmi");
        DEVICE.put("language", "zh");
        DEVICE.put("os_api", "36");
        DEVICE.put("os_version", "16");
        DEVICE.put("manifest_version_code", "71332");
        DEVICE.put("resolution", "1280*2772");
        DEVICE.put("dpi", "520");
        DEVICE.put("update_version_code", "71332");
        DEVICE.put("host_abi", "arm64-v8a");
        DEVICE.put("dragon_device_type", "phone");
        DEVICE.put("pv_player", "71332");
        DEVICE.put("compliance_status", "0");
        DEVICE.put("need_personal_recommend", "1");
        DEVICE.put("player_so_load", "1");
        DEVICE.put("is_android_pad_screen", "0");
    }

    /** x-gorgon：RC4 变体，对 query 与 body 摘要做混淆（非播放接口校验这一项）。 */
    static String gorgon(String query, byte[] body, int ts, int random) {
        byte[] queryDigest = md5(query.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        byte[] bodyDigest = body == null ? new byte[16] : md5(body);
        byte[] input = new byte[20];
        System.arraycopy(queryDigest, 0, input, 0, 4);
        System.arraycopy(bodyDigest, 0, input, 4, 4);
        System.arraycopy(le32(67503104), 0, input, 12, 4);
        System.arraycopy(be32(ts), 0, input, 16, 4);
        int[] key = {0x4a, 0x40, 0x16, (random >> 8) & 255, 0x47, 0x6c, 1, random & 255};
        int[] state = new int[256];
        for (int i = 0; i < 256; i++) state[i] = i;
        int j = 0;
        for (int i = 0; i < 256; i++) {
            j = (j + state[i] + key[i % 8]) & 255;
            int swap = state[i];
            state[i] = state[j];
            state[j] = swap;
        }
        j = 0;
        byte[] out = new byte[input.length];
        for (int n = 0; n < input.length; n++) {
            int i = n + 1;
            j = (j + state[i]) & 255;
            int y = state[j & 255];
            state[i] = y;
            out[n] = (byte) ((input[n] & 255) ^ state[(y + y) & 255]);
        }
        for (int i = 0; i < out.length; i++) {
            int value = (((out[i] & 255) >> 4) | ((out[i] & 255) << 4)) & 255;
            int next = out[i + 1 < out.length ? i + 1 : 0] & 255;
            int reversed = Integer.reverse((next ^ value) & 255) >>> 24;
            out[i] = (byte) (~(reversed ^ 20));
        }
        return "8404" + hexText(new byte[]{(byte) random, (byte) (random >> 8), 0x40, 1})
                + hexText(out);
    }

    /**
     * 非播放接口签名：query 里带 ts 与 _rticket，头带全套（argus / ladon / gorgon /
     * medusa / helios）。搜索、相关作品、制作方资料、评论都走这一套。
     */
    static Signed sign(String base, LinkedHashMap<String, String> values, byte[] body, long now) {
        int ts = (int) (now / 1000);
        for (int offset = 0; offset <= 127; offset++) {
            long ticket = now + offset;
            LinkedHashMap<String, String> all = new LinkedHashMap<>(values);
            all.put("ts", String.valueOf(ts));
            all.put("_rticket", String.valueOf(ticket));
            String query = encodeQuery(all);
            if (branch(query, body, ts) != 0) continue;
            String url = base + "?" + query;
            LinkedHashMap<String, String> headers = new LinkedHashMap<>();
            headers.put("User-Agent", APP_UA);
            headers.put("Accept", "application/json; charset=utf-8,application/x-protobuf");
            headers.put("x-ss-req-ticket", String.valueOf(ticket));
            headers.put("x-tt-request-tag", "t=0;n=0");
            headers.put("passport-sdk-version", "50561");
            headers.put("sdk-version", "2");
            headers.put("x-xs-from-web", "0");
            headers.put("x-khronos", String.valueOf(ts));
            headers.put("x-ladon", base64(be32(ts)));
            headers.put("x-argus", base64(le32(ts)));
            headers.put("x-gorgon", gorgon(query, body, ts, RANDOM.nextInt() & 0xFFFF));
            headers.put("x-helios", helios(ts));
            headers.put("x-medusa", medusa(url, body, ts, DEVICE));
            headers.put("x-tt-dt", "");
            if (body != null) {
                headers.put("Content-Type", "application/json; charset=UTF-8");
                headers.put("x-vc-bdturing-sdk-version", "3.7.2.cn");
                headers.put("x-ss-stub", hexText(md5(body)).toUpperCase());
            }
            return new Signed(url, headers);
        }
        throw new IllegalStateException("无法生成接口签名");
    }

    static String base64(byte[] data) {
        return java.util.Base64.getEncoder().encodeToString(data);
    }

    /**
     * 生成播放请求：循环调 _rticket 直到 hash 分支命中 12，再签名。
     * 返回的 url 已是最终 query，headers 只含 x-khronos / x-helios / x-medusa。
     */
    static Signed signPlayback(String base, LinkedHashMap<String, String> values, byte[] body, long now) {
        int ts = (int) (now / 1000);
        for (int offset = 0; offset <= 1023; offset++) {
            long ticket = now + offset;
            LinkedHashMap<String, String> all = new LinkedHashMap<>(values);
            all.put("_rticket", String.valueOf(ticket));
            String query = encodeQuery(all);
            if (branch(query, body, ts) != 0) continue;
            String url = base + "?" + query;
            LinkedHashMap<String, String> headers = new LinkedHashMap<>();
            headers.put("x-khronos", String.valueOf(ts));
            headers.put("x-helios", helios(ts));
            headers.put("x-medusa", medusa(url, body, ts, all));
            return new Signed(url, headers);
        }
        throw new IllegalStateException("无法生成播放签名");
    }
}
