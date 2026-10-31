#!/usr/bin/env node
'use strict';
const assert = require('assert');
const { categoryUrl, parseCategory, createHongguoContent } = require('../hongguo-content');

function routerHtml(section) {
  return '<html><script>window._ROUTER_DATA = ' + JSON.stringify({ loaderData: { category_page: section } }) + ';</script></html>';
}
const shortRows = [
  { series_id: '101', series_name: '短剧甲', series_cover: 'https://img/101.jpg', episode_cnt: 20 },
  { series_id: '101', series_name: '重复项' },
  { series_id: '102', series_name: '短剧乙', series_intro: '简介' },
];
const comicPayload = {
  isSuccess: true,
  rankList: [
    { seriesId: '201', title: '漫剧甲', cover: 'https://img/201.jpg', episodeCount: 30, rank: 1 },
    { seriesId: '201', title: '重复项' },
    { seriesId: '202', title: '漫剧乙', heatText: '9.2万', rank: 2 },
  ],
  pagination: { pageNum: 1, totalPages: 2 },
};
function comicHtml(payload = comicPayload) {
  const args = JSON.stringify(['rank_hot-comic-drama/page', 'content', payload]);
  return `<html><script data-fn-name="r" data-fn-args='${args}'></script></html>`;
}
function selector(type) {
  return [{ row_id: 1, items: [{ selector_item_id: type === 'short' ? 'romance' : 'fantasy', show_name: type === 'short' ? '爱情' : '玄幻', category_json_ids: [1] }] }];
}

assert.strictEqual(categoryUrl({ type: 'short', page: 1 }), 'https://hongguoduanju.com/category?tab=1&sort_type=1');
assert.strictEqual(categoryUrl({ type: 'short', page: 2 }), 'https://hongguoduanju.com/category?tab=1&sort_type=1&page=2');
assert.strictEqual(categoryUrl({ type: 'comic', page: 1 }), 'https://hongguoduanju.com/rank/hot-comic-drama?page=1');
assert.strictEqual(categoryUrl({ slug: 'comic:fantasy', page: 2 }), 'https://hongguoduanju.com/category/comic-drama/fantasy?page=2');
assert.strictEqual(categoryUrl({ tab: 'romance' }), 'https://hongguoduanju.com/category/real-drama/romance');
assert.throws(() => categoryUrl({ type: 'other' }), /type/);
assert.throws(() => categoryUrl({ page: 101 }), /页码/);

const shortPage = parseCategory(routerHtml({ recommendList: shortRows, selectorList: selector('short'), pagination: { pageNum: 2, totalPages: 3 } }), { type: 'short', page: 2 });
assert.deepStrictEqual(shortPage.items.map(x => x.id), ['101', '102']);
assert.strictEqual(shortPage.nextPage, 3);
assert.strictEqual(shortPage.tabs[0].slug, 'short:romance');
const comicPage = parseCategory(comicHtml(), { type: 'comic', page: 1 });
assert.deepStrictEqual(comicPage.items.map(x => x.id), ['201', '202']);
assert.strictEqual(comicPage.nextPage, 2);
assert.strictEqual(comicPage.items[0].badge, '全 30 集');
assert.notDeepStrictEqual(shortPage.items.map(x => x.id), comicPage.items.map(x => x.id));

(async () => {
  const urls = [];
  const fetchText = async url => {
    urls.push(url);
    if (url.includes('/rank/hot-comic-drama')) return comicHtml();
    if (url.endsWith('/category/comic-drama')) return routerHtml({ recommendList: [], selectorList: selector('comic'), pagination: { pageNum: 1, totalPages: 1 } });
    return routerHtml({ recommendList: shortRows, selectorList: selector('short'), pagination: { pageNum: 1, totalPages: 1 } });
  };
  const catalog = createHongguoContent(fetchText);
  const home = await catalog.home();
  assert.strictEqual(home.homepageRecommend[0].id, '101');
  assert.strictEqual(home.homepageNewest[0].id, '201');
  assert(urls.some(x => x.includes('/category?tab=1')) && urls.some(x => x.includes('/rank/hot-comic-drama')));
  const tags = await catalog.tags();
  assert.deepStrictEqual(tags.items.map(x => x.slug), ['short:romance', 'comic:fantasy']);
  console.log('PASS: 红果 URL 隔离、题材命名空间、分页、去重、双首页与兼容参数测试通过');
})().catch(error => { console.error(error); process.exit(1); });
