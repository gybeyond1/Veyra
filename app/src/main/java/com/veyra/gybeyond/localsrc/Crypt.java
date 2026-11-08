package com.veyra.gybeyond.localsrc;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.zip.GZIPInputStream;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** 加密小工具：这些源用到的只有 AES-CBC、SHA-256、HMAC-SHA256、gzip、base64。 */
public final class Crypt {

    private Crypt() { }

    public static byte[] sha256(byte[] data) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(data);
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }

    public static byte[] hmacSha256(byte[] key, byte[] data) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            return mac.doFinal(data);
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }

    /** AES-CBC 加密；autoPad=false 时调用方自己补 PKCS7（黄果旧版就是这么干的）。 */
    public static byte[] aesEncrypt(byte[] key, byte[] iv, byte[] plain, boolean autoPad) {
        try {
            Cipher cipher = Cipher.getInstance("AES/CBC/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new IvParameterSpec(iv));
            return cipher.doFinal(autoPad ? pkcs7(plain) : plain);
        } catch (Exception error) {
            throw new IllegalStateException("AES 加密失败: " + error.getMessage(), error);
        }
    }

    public static byte[] aesDecrypt(byte[] key, byte[] iv, byte[] cipherText, boolean stripPad) {
        try {
            Cipher cipher = Cipher.getInstance("AES/CBC/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new IvParameterSpec(iv));
            byte[] plain = cipher.doFinal(cipherText);
            return stripPad ? unpad(plain) : plain;
        } catch (Exception error) {
            throw new IllegalStateException("AES 解密失败: " + error.getMessage(), error);
        }
    }

    public static byte[] pkcs7(byte[] data) {
        int pad = 16 - (data.length % 16);
        byte[] out = new byte[data.length + pad];
        System.arraycopy(data, 0, out, 0, data.length);
        for (int i = data.length; i < out.length; i++) out[i] = (byte) pad;
        return out;
    }

    public static byte[] unpad(byte[] data) {
        if (data.length == 0) return data;
        int pad = data[data.length - 1] & 0xff;
        if (pad <= 0 || pad > 16 || pad > data.length) return data;
        byte[] out = new byte[data.length - pad];
        System.arraycopy(data, 0, out, 0, out.length);
        return out;
    }

    public static byte[] gunzip(byte[] data) {
        if (data.length < 2 || (data[0] & 0xff) != 0x1f || (data[1] & 0xff) != 0x8b) return data;
        try (GZIPInputStream input = new GZIPInputStream(new ByteArrayInputStream(data))) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] chunk = new byte[16384];
            int read;
            while ((read = input.read(chunk)) > 0) out.write(chunk, 0, read);
            return out.toByteArray();
        } catch (Exception error) {
            return data;
        }
    }

    public static byte[] gzip(byte[] data) {
        try {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream(data.length + 64);
            try (java.util.zip.GZIPOutputStream output = new java.util.zip.GZIPOutputStream(buffer)) {
                output.write(data);
            }
            return buffer.toByteArray();
        } catch (Exception error) {
            throw new IllegalStateException("gzip 失败: " + error.getMessage(), error);
        }
    }

    /** 十六进制字符串 → 字节（黄豆用它把 requestId 还原成 16 字节原文）。 */
    public static byte[] unb64Hex(String hex) {
        String clean = hex == null ? "" : hex.trim();
        if (clean.length() % 2 != 0) clean = "0" + clean;
        byte[] out = new byte[clean.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(clean.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    public static String base64(byte[] data) {
        return Base64.getEncoder().encodeToString(data);
    }

    public static byte[] unb64(String value) {
        String clean = value == null ? "" : value.trim().replace("\n", "").replace("\r", "");
        try {
            return Base64.getDecoder().decode(clean);
        } catch (Exception error) {
            try {
                return Base64.getUrlDecoder().decode(clean);
            } catch (Exception ignored) {
                throw new IllegalArgumentException("base64 解码失败");
            }
        }
    }

    public static String hex(byte[] data) {
        StringBuilder out = new StringBuilder(data.length * 2);
        for (byte item : data) out.append(String.format("%02x", item & 0xff));
        return out.toString();
    }

    public static String randomHex(int bytes) {
        byte[] data = new byte[bytes];
        new java.security.SecureRandom().nextBytes(data);
        return hex(data);
    }
}
