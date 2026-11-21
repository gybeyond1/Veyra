package com.veyra.gybeyond;

import android.app.Application;

/** 应用入口。自建后端版不再初始化 Parse/Back4App。 */
public final class HuangGuoApp extends Application {
    @Override public void onCreate() {
        super.onCreate();
        /* 红果的匿名设备身份要落盘复用：每集新注册一台会被上游判成机器，直接回空正文。 */
        HongguoDirect.init(this);
    }
}
