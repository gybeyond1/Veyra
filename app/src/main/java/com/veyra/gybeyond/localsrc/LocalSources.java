package com.veyra.gybeyond.localsrc;

/**
 * 端侧私密源的注册表。
 *
 * 只有这几个源实现了本机解析；其余的仍然走后端。判断依据只有 id，
 * 上层（DualContentRepository）拿 id 查一下就知道该走哪条路。
 */
public final class LocalSources {

    private LocalSources() { }

    /** id / 名称 / 一句话描述 / 内容类型。顺序即「私密内容源」弹窗里的顺序。 */
    public static final String[][] CATALOG = {
            {"cloudfront", "黄果旧版", "旧 API 剧库 · 分类与搜索", "短剧"},
            {"huangguoai", "黄果 AI", "AI 短剧 · 漫剧 · 热门榜", "AI 短剧"},
            {"dsd", "帝果", "帝果剧库 · 分类齐全", "短剧"},
            {"huangju", "剧果", "热门 · 最新 · 分类短剧", "短剧"},
            // 黄豆：主域 tideember.cc 的 DNS 记录已经没了，整站下线，
            // 列在这里只是给人一个点了必失败的选项。实现留在 Huangdou.java，域名回来再加回。
    };

    public static boolean supports(String site) {
        if (site == null) return false;
        for (String[] row : CATALOG) if (row[0].equals(site)) return true;
        return false;
    }

    public static String nameOf(String site) {
        for (String[] row : CATALOG) if (row[0].equals(site)) return row[1];
        return "";
    }

    /**
     * @param store 设备号 / 访客 token 的落地位置；桌面验证可传内存实现
     */
    public static LocalSource create(String site, LegacyCore.Store store) {
        if (site == null) return null;
        switch (site) {
            case "cloudfront": return new HuangguoLegacy(store);
            case "huangguoai": return new HuangguoAi();
            case "huangdou": return new Huangdou();
            case "dsd": return new Dsd();
            case "huangju": return new Huangju();
            default: return null;
        }
    }

    /** 内存版存储：只在同一进程里有效，用于桌面协议验证。 */
    public static LegacyCore.Store memoryStore() {
        return new LegacyCore.Store() {
            private final java.util.Map<String, String> map = new java.util.concurrent.ConcurrentHashMap<>();
            @Override public String get(String key) { return map.get(key); }
            @Override public void put(String key, String value) {
                if (value == null) map.remove(key); else map.put(key, value);
            }
        };
    }
}
