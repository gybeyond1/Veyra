package com.veyra.gybeyond.localsrc;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 一个能在手机上独立跑起来的私密源。
 *
 * 方法签名和 server/sources 里 provider 的导出一一对齐（home / category / search /
 * detail / episode），返回的 JSON 字段也和后端下发的完全一致，所以上层的
 * SiteRepository、播放器、前端渲染一行都不用改。
 */
public interface LocalSource {

    String id();

    String name();

    JSONObject home() throws Exception;

    JSONArray categories() throws Exception;

    JSONObject category(String slug, int page) throws Exception;

    JSONObject search(String keyword, int page) throws Exception;

    JSONObject detail(String id) throws Exception;

    /** 返回 {url, referer, [cookie], title, cover}。 */
    JSONObject episode(String id, int number) throws Exception;

    /** 封面要不要带 Referer（这些源的图床大多不校验，带错了反而 403）。 */
    default String coverReferer() {
        return "";
    }

    /** 封面下载是否必须不校验证书。 */
    default boolean coverInsecure() {
        return false;
    }
}
