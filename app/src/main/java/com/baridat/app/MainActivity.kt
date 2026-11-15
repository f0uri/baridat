package com.baridat.app

import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences
import android.os.Bundle
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
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
        fun storeString(key: String, value: String) {
            runOnUiThread { prefs.edit().putString(key, value).apply() }
        }

        @JavascriptInterface
        fun loadString(key: String, def: String): String {
            return prefs.getString(key, def) ?: def
        }

        @JavascriptInterface
        fun removeKey(key: String) {
            runOnUiThread { prefs.edit().remove(key).apply() }
        }
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences("baridat_native", Context.MODE_PRIVATE)

        WindowCompat.setDecorFitsSystemWindows(window, false)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.isAppearanceLightStatusBars = false
        controller.hide(WindowInsetsCompat.Type.navigationBars())
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE

        web = WebView(this)
        web.webViewClient = object : WebViewClient() {
            override fun onReceivedError(
                view: WebView?, req: WebResourceRequest?, err: WebResourceError?
            ) {
                Log.e("Baridat", "WebView error @${req?.url}: ${err?.errorCode} ${err?.description}")
                super.onReceivedError(view, req, err)
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(cm: ConsoleMessage?): Boolean {
                cm?.let { Log.d("WebView[${it.messageLevel()}]", "${it.sourceId()}:${it.lineNumber()} ${it.message()}") }
                return true
            }
        }

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
        s.userAgentString = (s.userAgentString ?: "") + " Baridat/" + BuildConfig.VERSION_NAME
        s.allowUniversalAccessFromFileURLs = false
        s.allowFileAccessFromFileURLs = false

        web.addJavascriptInterface(NativeBridge(), "BaridatNative")
        web.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

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
