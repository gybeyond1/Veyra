package com.veyra.gybeyond;

/**
 * 封面字节的「像不像一张图」判断。
 *
 * 为什么要单独抽出来：黄果旧版的封面图床会把文件头前 ~494 字节替换成乱码，后面才是明文 JPEG；
 * 黄果 AI 的部分图还要按源站规则解一次。以前客户端直接拿字节当图返回，
 * 结果就是「WebUI 能显示（服务端解过了），手机上全是一块灰」。
 *
 * 现在两件事分开：能不能解由调用方决定，但「明显不是图片」必须当场认出来，
 * 宁可抛错让前端显示占位，也不要把一坨乱码塞给 <img>（那才是既没图又没兜底）。
 */
final class ImageBytes {
    private ImageBytes() {}

    /** 认得出来的图片类型；认不出来返回空串。 */
    static String mimeOf(byte[] bytes) {
        if (bytes == null || bytes.length < 12) return "";
        int b0 = bytes[0] & 0xff, b1 = bytes[1] & 0xff, b2 = bytes[2] & 0xff, b3 = bytes[3] & 0xff;
        if (b0 == 0xff && b1 == 0xd8 && b2 == 0xff) return "image/jpeg";
        if (b0 == 0x89 && b1 == 'P' && b2 == 'N' && b3 == 'G') return "image/png";
        if (b0 == 'G' && b1 == 'I' && b2 == 'F') return "image/gif";
        if (b0 == 'R' && b1 == 'I' && b2 == 'F' && b3 == 'F'
                && bytes[8] == 'W' && bytes[9] == 'E' && bytes[10] == 'B' && bytes[11] == 'P') return "image/webp";
        if (b0 == 'B' && b1 == 'M') return "image/bmp";
        return "";
    }
}
