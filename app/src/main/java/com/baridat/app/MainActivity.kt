package com.baridat.app

import android.annotation.SuppressLint
import android.os.Bundle
import org.json.JSONObject
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
    private lateinit var updates: UpdateManager

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        WindowCompat.setDecorFitsSystemWindows(window, false)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.isAppearanceLightStatusBars = false
        controller.hide(WindowInsetsCompat.Type.navigationBars())
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE

        web = WebView(this)
        updates = UpdateManager(this) { json ->
            web.evaluateJavascript("window.onNativeUpdate && window.onNativeUpdate(" + JSONObject.quote(json) + ")", null)
        }
        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                updates.status()
            }
        }
        web.webChromeClient = WebChromeClient()

        val s: WebSettings = web.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.databaseEnabled = true
        s.useWideViewPort = true
        s.loadWithOverviewMode = true
        s.allowFileAccess = true
        s.allowContentAccess = true
        s.allowFileAccessFromFileURLs = true
        s.allowUniversalAccessFromFileURLs = true
        s.mediaPlaybackRequiresUserGesture = false
        s.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        s.cacheMode = WebSettings.LOAD_DEFAULT
        s.setSupportZoom(false)
        s.builtInZoomControls = false
        s.displayZoomControls = false
        s.textZoom = 100
        s.cacheMode = WebSettings.LOAD_NO_CACHE

        val bridge = NativeBridge(this)
        web.addJavascriptInterface(bridge, "BaridatNative")
        bridge.attachWebView(web)

        setContentView(web)
        web.loadUrl("file:///android_asset/index.html")
    }

    fun downloadUpdate(url: String) = runOnUiThread { updates.start(url) }
    fun installUpdate() = runOnUiThread { updates.installRequested() }
    fun updateStatus() = runOnUiThread { updates.status() }

    override fun onResume() { super.onResume(); if (::updates.isInitialized) updates.onResume() }
    override fun onPause() { if (::updates.isInitialized) updates.onPause(); super.onPause() }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }
}
