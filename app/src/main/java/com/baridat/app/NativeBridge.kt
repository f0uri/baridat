package com.baridat.app

import android.content.Context
import android.content.SharedPreferences
import android.webkit.JavascriptInterface

class NativeBridge(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("baridat_native", Context.MODE_PRIVATE)

    @JavascriptInterface
    @Synchronized
    fun getAppVersion(): String = com.baridat.app.BuildConfig.VERSION_NAME

    @JavascriptInterface
    @Synchronized
    fun getVersionCode(): Int = com.baridat.app.BuildConfig.VERSION_CODE

    @JavascriptInterface
    @Synchronized
    fun storeString(key: String?, value: String?) {
        if (key == null) return
        prefs.edit().putString(key, value).apply()
    }

    @JavascriptInterface
    @Synchronized
    fun loadString(key: String?, def: String?): String {
        if (key == null) return def ?: ""
        return prefs.getString(key, def) ?: def ?: ""
    }

    @JavascriptInterface
    @Synchronized
    fun removeKey(key: String?) {
        if (key == null) return
        prefs.edit().remove(key).apply()
    }
}
