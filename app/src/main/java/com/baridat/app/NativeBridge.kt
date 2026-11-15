package com.baridat.app

import android.content.Context
import android.content.SharedPreferences
import android.webkit.JavascriptInterface

class NativeBridge(ctx: Context) {
    private val prefs: SharedPreferences =
        ctx.getSharedPreferences("baridat_native", Context.MODE_PRIVATE)

    @JavascriptInterface
    fun getAppVersion(): String = "2.1.0"

    @JavascriptInterface
    fun getVersionCode(): Int = 21

    @JavascriptInterface
    fun storeString(key: String, value: String) {
        prefs.edit().putString(key, value).apply()
    }

    @JavascriptInterface
    fun loadString(key: String, def: String): String {
        return prefs.getString(key, def) ?: def
    }

    @JavascriptInterface
    fun removeKey(key: String) {
        prefs.edit().remove(key).apply()
    }
}
