package com.veyra.gybeyond;

import android.app.Activity;
import android.widget.FrameLayout;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 电视包里「刷剧」的空实现。
 *
 * <p>刷剧是手机端独有的竖滑连播（BingeActivity + 原生视频层），电视端是遥控器点播，
 * 没有这个入口。两个包各带各的代码：真实现放在 {@code src/mobile/java}，
 * 电视包只编进这份同名的空壳，主壳 {@link MainActivity} 不需要为了形态写 if。
 *
 * <p>之所以保留同名类而不是给主壳加接口：主壳里对刷剧的调用有十几处，
 * 加接口要改十几处调用点，空壳只改一处（包边界）。空壳里的方法都是 no-op，
 * 电视上永远不会被调到 —— tv.js 没有 binge-start 这类动作。
 */
final class BingeEngine {
    public interface Callback {
        Activity getActivity();
        void onShowLoaded(String title, String description, String cover, String id, int index);
        void onShowFailed(String message);
        default void onPosterReady() { }
    }

    BingeEngine(Callback cb, FrameLayout videoLayer) { }

    void start(JSONArray items, int startIndex, String source) { }

    /** 手机端用来给剧单续池；电视没有刷剧入口，空着即可。 */
    void append(JSONArray more) { }

    void exit() { }

    void onResume() { }

    void onPause() { }

    void onDestroy() { }

    void pause() { }

    void resume() { }

    void next() { }

    void prev() { }

    void dragStart() { }

    void dragMove(float dyCss) { }

    void dragEnd(float dyCss, float velocityCss) { }

    boolean isActive() { return false; }

    JSONObject buildPlayerPayload(int episode) { return new JSONObject(); }

    void openInPlayer(int episode) { }

    static boolean fillScreen(boolean videoLandscape, boolean screenLandscape) { return false; }
}
