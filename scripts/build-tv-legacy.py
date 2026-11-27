"""生成电视端的「老内核」样式：tv.css -> tv-legacy.css

为什么要有这一份
----------------
tv.css 是照着 Chromium 61+ 写的（电视盒子里 System WebView 的常态）：
用 CSS 变量做主题、用 grid 排版。Android 5.x 那批 2015 年前后的电视
（创维 Hi3751、海思 MT 系列）系统 WebView 还停在 Chromium 37~43：
  · var()      —— 49 才有，不支持时整条声明失效，颜色和尺寸全丢
  · display:grid —— 57 才有，不支持时所有网格塌成一列
页面上不会报任何错，用户看到的就是白屏 / 一坨没有间距的东西。

这里做两件纯机械的事，不改任何设计判断：
  1. 把 :root 里的变量值内联进去（主题切换在老内核上失效，但颜色是对的）
  2. 在末尾补一段 flex 兜底，覆盖原来 grid 的那几个容器

生成的 tv-legacy.css 只进老电视包（src/tvlegacy/assets），正式 tv 包不受影响；
老电视包的 tv.html 在解析期用 CSS.supports 选其中一份。改 tv.css 之后重跑本脚本。
"""
from pathlib import Path
import re

APP = Path(__file__).resolve().parents[1] / "app"
SRC = APP / "src/tv/assets/tv.css"
OUT = APP / "src/tvlegacy/assets/tv-legacy.css"

FALLBACK = """

/* ===================================================================
   老内核兜底：grid 从 Chromium 57 才有，这里全部换成 flex。
   规则写在最后，display 覆盖前面的 grid；grid-* 属性老内核直接忽略。
   =================================================================== */
.grid{display:flex;flex-wrap:wrap;margin-left:-1.6rem}
.grid > *{width:calc(12.5% - 1.6rem);margin-left:1.6rem;margin-bottom:2rem}
.detail-hero{display:flex}
.detail-hero > *:first-child{width:36rem;flex:0 0 36rem;margin-right:4.8rem}
.detail-hero > *:last-child{flex:1 1 0;min-width:0}
.eps{display:flex;flex-wrap:wrap;margin-left:-1.2rem}
.eps > *{width:calc(10% - 1.2rem);margin-left:1.2rem;margin-bottom:1.2rem}
.account-actions{display:flex;flex-wrap:wrap;margin-left:-1.4rem}
.account-actions > *{width:calc(50% - 1.4rem);margin-left:1.4rem;margin-bottom:1.4rem}
.account-actions #account-logout,.account-actions .btn.ghost{width:calc(100% - 1.4rem)}
.otp-keys{display:flex;flex-wrap:wrap;margin-left:-1.2rem}
.otp-keys > *{width:calc(33.333% - 1.2rem);margin-left:1.2rem;margin-bottom:1.2rem}
.theme-grid{display:flex;flex-wrap:wrap;margin-left:-1.4rem}
.theme-grid > *{width:calc(33.333% - 1.4rem);margin-left:1.4rem;margin-bottom:1.4rem}
.season-grid{display:flex;flex-wrap:wrap;margin-left:-1.2rem}
.season-grid > *{width:calc(25% - 1.2rem);margin-left:1.2rem;margin-bottom:1.2rem}
.season-grid.ep-card-grid > *{width:calc(20% - 1.2rem)}
.producer-grid > *{width:calc(16.666% - 1.2rem)}
.diag-row{display:flex;flex-wrap:wrap;align-items:baseline}
.diag-row > *{margin-right:1.2rem}
/* 没有 mask 就没有渐隐：顶栏改成实底，别让海报从标题下面透出来（默认黑主题） */
#topbar{background:#17181A}
"""


def root_vars(text: str) -> dict:
    """只取 :root{...} 里的变量。body[data-tv-theme] 的覆盖故意不取。"""
    match = re.search(r":root\s*\{([^}]*)\}", text)
    if not match:
        return {}
    out = {}
    for name, value in re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", match.group(1)):
        out[name.strip()] = value.strip()
    return out


def inline_vars(text: str, table: dict) -> str:
    def repl(match):
        name = match.group(1).strip()
        fallback = match.group(2)
        if name in table:
            return table[name]
        if fallback is not None:
            return fallback.strip()
        return ""

    # var(--x) / var(--x, 兜底值)
    return re.sub(r"var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)", repl, text)


def main():
    text = SRC.read_text(encoding="utf-8")
    table = root_vars(text)
    legacy = inline_vars(text, table)
    header = (
        "/* 由 scripts/build-tv-legacy.py 从 tv.css 生成，不要手改。\n"
        "   供 Chromium < 57 的电视内核使用：变量已内联、grid 换成 flex。 */\n"
    )
    OUT.write_text(header + legacy + FALLBACK, encoding="utf-8")
    print(f"tv-legacy.css: {len(table)} 个变量内联，{OUT.stat().st_size} 字节")


if __name__ == "__main__":
    main()
