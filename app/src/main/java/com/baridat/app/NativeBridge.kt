package com.baridat.app

import android.content.Context
import android.webkit.JavascriptInterface
import com.baridat.app.BuildConfig

class NativeBridge(ctx: Context) {
    @JavascriptInterface
    fun getAppVersion(): String = BuildConfig.VERSION_NAME

    @JavascriptInterface
    fun getVersionCode(): Int = BuildConfig.VERSION_CODE
}
