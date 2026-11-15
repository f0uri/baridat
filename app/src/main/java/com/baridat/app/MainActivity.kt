package com.baridat.app

import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private lateinit var prefs: SharedPreferences

    inner class NativeBridge {
        @JavascriptInterface
        fun getAppVersion(): String = BuildConfig.VERSION_NAME

        @JavascriptInterface
        fun getVersionCode(): Int = BuildConfig.VERSION_CODE

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

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences("baridat_native", Context.MODE_PRIVATE)

        // Edge-to-edge (works on all API levels via AndroidX)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.isAppearanceLightStatusBars = false
        controller.hide(WindowInsetsCompat.Type.navigationBars())
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE

        web = WebView(this)
        web.webViewClient = WebViewClient()
        web.webChromeClient = WebChromeClient()

        val s: WebSettings = web.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.databaseEnabled = true
        s.useWideViewPort = true
        s.loadWithOverviewMode = true
        s.allowFileAccess = true
        s.allowContentAccess = true
        s.mediaPlaybackRequiresUserGesture = false
        s.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        s.cacheMode = WebSettings.LOAD_DEFAULT
        s.setSupportZoom(false)

        web.addJavascriptInterface(NativeBridge(), "BaridatNative")

        setContentView(web)
        web.loadUrl("file:///android_asset/index.html")
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }
}
