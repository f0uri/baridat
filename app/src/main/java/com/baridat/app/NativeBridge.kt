package com.baridat.app

import android.webkit.JavascriptInterface

class NativeBridge {
    @JavascriptInterface
    fun getAppVersion(): String = "2.1.0"

    @JavascriptInterface
    fun getVersionCode(): Int = 21
}
