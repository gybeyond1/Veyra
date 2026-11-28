package com.veyra.gybeyond.localsrc;

/**
 * 端侧私密源的注册表。
 *
 * 只有这几个源实现了本机解析；其余的仍然走后端。判断依据只有 id，
 * 上层（DualContentRepository）拿 id 查一下就知道该走哪条路。
 */
public final class LocalSources {

    private LocalSources() { }

    /**
     * 私密源全量清单：与后端 server/sources/index.js 的 providers 一一对应，
     * 顺序即「私密内容源」弹窗里的顺序。后端下发了同名源时以后端为准（改名不用发版），
     * 后端没下发就按这里的名字兜底，绝不把这个列表以外的东西塞进弹窗。
     */
    public static final String[][] SITES = {
            {"huangju", "剧果", "热门 · 最新 · 分类短剧", "短剧"},
            {"jinguoduanju", "禁果短剧", "推荐 · 分类短剧 · 在线搜索", "短剧"},
            {"cloudfront", "黄果旧版", "旧 API 剧库 · 分类与搜索", "短剧"},
            {"huangguoai", "黄果 AI", "AI 短剧 · 漫剧 · 热门榜", "AI 短剧"},
            {"dsd", "帝果", "帝果剧库 · 分类齐全", "短剧"},
    };

    /** 端侧能自己解析的那几个（手机直连源站，后端挂了也不影响）。 */
    public static final String[][] CATALOG = {
            {"cloudfront", "黄果旧版", "旧 API 剧库 · 分类与搜索", "短剧"},
            {"huangguoai", "黄果 AI", "AI 短剧 · 漫剧 · 热门榜", "AI 短剧"},
            {"dsd", "帝果", "帝果剧库 · 分类齐全", "短剧"},
            {"huangju", "剧果", "热门 · 最新 · 分类短剧", "短剧"},
    };

    public static boolean supports(String site) {
        if (site == null) return false;
        for (String[] row : CATALOG) if (row[0].equals(site)) return true;
        return false;
    }

    public static String nameOf(String site) {
        for (String[] row : SITES) if (row[0].equals(site)) return row[1];
        return "";
    }

    /** 这个 id 是不是私密源清单里的（用来清掉历史遗留的已下架源）。 */
    public static boolean known(String site) {
        if (site == null) return false;
        for (String[] row : SITES) if (row[0].equals(site)) return true;
        return false;
    }

    /**
     * @param store 设备号 / 访客 token 的落地位置；桌面验证可传内存实现
     */
    public static LocalSource create(String site, LegacyCore.Store store) {
        if (site == null) return null;
        switch (site) {
            case "cloudfront": return new HuangguoLegacy(store);
            case "huangguoai": return new HuangguoAi();
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
