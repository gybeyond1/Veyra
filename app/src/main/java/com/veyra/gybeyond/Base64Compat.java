package com.veyra.gybeyond;

/**
 * java.util.Base64 的兼容实现（minSdk 22 用）。
 *
 * java.util.Base64 是 API 26 才进 Android 的。老电视包（Android 5.1 / API 22）
 * 里直接调用会在运行期抛 NoClassDefFoundError —— 位置在签名（HongguoV5）和解密
 * （localsrc/Crypt）上，表现就是「点开一集什么都不发生」。
 *
 * 只实现项目里实际用到的四个入口：标准/URL 安全两套编解码、去填充、encodeToString。
 * 行为与 JDK 一致（URL 安全表的 - _ 与标准表的 + / 互换，填充规则相同）。
 */
public final class Base64Compat {
    private static final char[] STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toCharArray();
    private static final char[] URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".toCharArray();
    private static final int[] INDEX = new int[128];

    static {
        for (int i = 0; i < INDEX.length; i++) INDEX[i] = -1;
        for (int i = 0; i < STD.length; i++) INDEX[STD[i]] = i;
        INDEX['-'] = 62;
        INDEX['_'] = 63;
        INDEX['='] = -2;
    }

    private Base64Compat() { }

    public static Encoder getEncoder() { return new Encoder(STD); }

    public static Encoder getUrlEncoder() { return new Encoder(URL); }

    public static Decoder getDecoder() { return new Decoder(); }

    public static Decoder getUrlDecoder() { return new Decoder(); }

    public static final class Encoder {
        private final char[] table;
        private boolean padding = true;

        Encoder(char[] table) { this.table = table; }

        public Encoder withoutPadding() {
            padding = false;
            return this;
        }

        public String encodeToString(byte[] data) {
            if (data == null) return "";
            StringBuilder out = new StringBuilder((data.length + 2) / 3 * 4);
            for (int i = 0; i < data.length; i += 3) {
                int b0 = data[i] & 0xFF;
                int b1 = i + 1 < data.length ? data[i + 1] & 0xFF : 0;
                int b2 = i + 2 < data.length ? data[i + 2] & 0xFF : 0;
                boolean two = i + 1 < data.length;
                boolean three = i + 2 < data.length;
                out.append(table[b0 >>> 2]);
                out.append(table[((b0 & 0x03) << 4) | (b1 >>> 4)]);
                if (three) {
                    out.append(table[((b1 & 0x0F) << 2) | (b2 >>> 6)]);
                    out.append(table[b2 & 0x3F]);
                } else if (two) {
                    out.append(table[((b1 & 0x0F) << 2)]);
                    if (padding) out.append('=');
                } else {
                    if (padding) out.append("==");
                }
            }
            return out.toString();
        }
    }

    public static final class Decoder {
        public byte[] decode(String text) {
            if (text == null) return new byte[0];
            StringBuilder clean = new StringBuilder(text.length());
            for (int i = 0; i < text.length(); i++) {
                char c = text.charAt(i);
                if (c == '\n' || c == '\r' || c == ' ' || c == '\t') continue;
                clean.append(c);
            }
            int length = clean.length();
            // 去掉末尾的 =，按实际有效字符算长度
            while (length > 0 && clean.charAt(length - 1) == '=') length--;
            byte[] out = new byte[length * 3 / 4];
            int buffer = 0;
            int bits = 0;
            int index = 0;
            for (int i = 0; i < length; i++) {
                char c = clean.charAt(i);
                int value = c < 128 ? INDEX[c] : -1;
                if (value < 0) {
                    if (value == -2) continue;
                    throw new IllegalArgumentException("invalid base64 input");
                }
                buffer = (buffer << 6) | value;
                bits += 6;
                if (bits >= 8) {
                    bits -= 8;
                    out[index++] = (byte) ((buffer >>> bits) & 0xFF);
                }
            }
            if (index == out.length) return out;
            byte[] trimmed = new byte[index];
            System.arraycopy(out, 0, trimmed, 0, index);
            return trimmed;
        }
    }
}
