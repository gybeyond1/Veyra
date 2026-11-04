// SPDX-License-Identifier: GPL-3.0-only
package com.hongguotv.core

import org.json.JSONArray
import org.json.JSONObject
import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import java.io.IOException

/**
 * 红果四个热播榜：总榜 / 真人剧 / 漫剧 / AI剧。
 *
 * 以前只有漫剧能看，而且只认 _ROUTER_DATA 里的 rank_hot-comic-drama/page -> rankList。
 * 另外三个榜的 loaderData.content 是空对象 {}，但 **服务端已经把卡片渲染进 HTML**：
 * article[aria-labelledby="rank-title-{seriesId}"]，每页 20 条，带名次角标、热度、
 * 评分、题材标签，分页信息在 nav[aria-label="榜单分页"] 里（aria-current 标当前页）。
 * 所以这里以 DOM 为主，DOM 不成立（站点改版只剩序列化数据）再回落到 loaderData。
 */
internal object RankBoards {
    const val HOT = "hot-drama"
    const val REAL = "hot-real-drama"
    const val COMIC = "hot-comic-drama"
    const val AI = "hot-ai-drama"
    val ALL = listOf(HOT, REAL, COMIC, AI)

    private val ID = Regex("[0-9]{1,30}")
    private val PAGE = Regex("[?&]page=([0-9]{1,3})")

    fun parse(html: String, path: String, page: Int): CatalogPage {
        if (html.length > 4 * 1024 * 1024) throw IOException("榜单页面过大")
        val document = try { Jsoup.parse(html) } catch (e: Exception) { throw IOException("榜单页面解析失败", e) }
        rendered(document, page)?.let { return it }
        return serialized(document, html, path, page)
    }

    /** 服务端渲染的卡片：四个榜都走这条，实测每页 20 条、名次连续。 */
    private fun rendered(document: Document, page: Int): CatalogPage? {
        val articles = document.select("article[aria-labelledby^=rank-title-]")
        if (articles.isEmpty()) return null
        val paging = document.selectFirst("nav[aria-label=榜单分页]") ?: return null
        val current = paging.selectFirst("[aria-current=page]")?.text()?.trim()?.toIntOrNull() ?: return null
        if (current != page) return null
        val positions = linkedMapOf<String, RankPosition>()
        val items = ArrayList<Series>(articles.size)
        for (article in articles) {
            val label = article.attr("aria-labelledby")
            val id = label.removePrefix("rank-title-")
            if (!ID.matches(id)) return null
            val title = article.getElementById(label)?.text()?.trim().orEmpty()
            if (title.isEmpty() || title.length > 200) return null
            val rank = article.selectFirst("[class*=badge-number-]")?.text()?.trim()?.toIntOrNull()?.takeIf { it > 0 }
            val heat = article.selectFirst("p[class*=metrics-]")?.text()?.trim().orEmpty()
            if (!positions.containsKey(id)) positions[id] = RankPosition(rank, heat)
            items.add(
                Series(
                    id, title, cleanUrl(article.selectFirst("img[src]")?.attr("src").orEmpty()), "",
                    heat, article.select("p[class*=categories-] > span").take(5).joinToString(" · ") { it.text().trim() }
                )
            )
        }
        // 同一部剧在一页里出现两次 = 结构已经不是我们认识的榜单，宁可回落到序列化数据
        if (items.distinctBy { it.id }.size != items.size) return null
        val lastPage = maxOf(
            page,
            paging.select("a[href]").mapNotNull { PAGE.find(it.attr("href"))?.groupValues?.get(1)?.toIntOrNull() }.maxOrNull() ?: page
        )
        val limit = minOf(lastPage, 100)
        // 「xx月xx日已更新」只有 loaderData 里有；DOM 分支拿不到也不影响，前端不显示这行。
        return CatalogPage(items, page < limit, ComicRanking(positions, limit, ""))
    }

    /** 旧格式兜底：_ROUTER_DATA 里的 rankList（漫剧以前就是这条）。 */
    private fun serialized(document: Document, html: String, path: String, page: Int): CatalogPage {
        val key = "rank_$path/page"
        for (tag in document.select("script[data-fn-name][data-fn-args]")) {
            val name = tag.attr("data-fn-name")
            if (name != "r" && name != "mergeLoaderData") continue
            val args = try { JSONArray(tag.attr("data-fn-args")) } catch (e: Exception) { continue }
            if (args.optString(0) != key) continue
            val raw: Any? = when {
                name == "r" && args.optString(1) == "content" -> args.opt(2)
                name == "mergeLoaderData" -> args.optJSONArray(1)?.objects()
                    ?.firstOrNull { it.str("key") == "content" && it.str("routerDataFnName") == "p" }
                    ?.optJSONArray("routerDataFnArgs")?.opt(0)
                else -> null
            }
            val payload = when (raw) {
                is JSONObject -> raw
                is String -> runCatching { JSONObject(raw) }.getOrNull()
                else -> null
            } ?: continue
            if (!payload.optBoolean("isSuccess", true)) throw IOException("榜单暂不可用")
            val rows = payload.optJSONArray("rankList") ?: continue
            val pagination = payload.optJSONObject("pagination") ?: continue
            val totalPages = pagination.optInt("totalPages", 0)
            if (totalPages < 1 || pagination.optInt("pageNum", page) != page) continue
            val positions = linkedMapOf<String, RankPosition>()
            val items = ArrayList<Series>()
            for (row in rows.objects()) {
                val id = row.str("seriesId").ifEmpty { row.str("id") }
                if (!ID.matches(id)) continue
                val title = row.str("title")
                if (title.isEmpty()) continue
                val count = row.optInt("episodeCount", row.optJSONArray("episodeVids")?.length() ?: 0)
                val tags = row.optJSONArray("tags") ?: JSONArray()
                val heat = row.str("heatText")
                if (!positions.containsKey(id)) positions[id] = RankPosition(row.optInt("rank").takeIf { it > 0 }, heat)
                items.add(
                    Series(
                        id, title, cleanUrl(row.str("cover")), row.str("description"),
                        if (count > 0) "全 $count 集" else heat,
                        (0 until minOf(tags.length(), 5)).joinToString(" · ") { tags.optString(it) }
                    )
                )
            }
            val unique = items.distinctBy { it.id }
            if (unique.isEmpty()) throw IOException("榜单数据为空")
            val limit = minOf(totalPages, 100)
            val updated = runCatching {
                ContentRepository.extractRouter(html).optJSONObject("loaderData")?.optJSONObject(key)?.str("updatedText")
            }.getOrNull().orEmpty()
            return CatalogPage(unique, page < limit, ComicRanking(positions, limit, updated))
        }
        throw IOException("页面没有榜单数据")
    }
}
