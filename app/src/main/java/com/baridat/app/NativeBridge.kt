package com.baridat.app

import android.app.Activity
import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors

/**
 * Native bridge exposed to JS as "BaridatNative".
 *
 * All mail-API HTTP goes through Kotlin so WebView file:// null-origin/CORS
 * restrictions cannot block requests. JS calls BaridatNative.http(method,url,body,token,cb)
 * where cb is a globally-registered function name; the bridge invokes it on
 * the UI thread with a single JSON-string argument.
 */
class NativeBridge(private val activity: Activity) {
    private val prefs: SharedPreferences =
        activity.getSharedPreferences("baridat_native", Context.MODE_PRIVATE)
    private val executor = Executors.newFixedThreadPool(4)
    @Volatile private var webView: WebView? = null

    fun attachWebView(wv: WebView) { webView = wv }

    // ----- Version -----
    @JavascriptInterface fun getAppVersion(): String = BuildConfig.VERSION_NAME
    @JavascriptInterface fun getVersionCode(): Int = BuildConfig.VERSION_CODE

    // ----- Storage -----
    @JavascriptInterface fun storeString(k: String, v: String) =
        safe { prefs.edit().putString(k, v).apply() }
    @JavascriptInterface fun loadString(k: String, d: String): String =
        try { prefs.getString(k, d) ?: d } catch (_: Throwable) { d }
    @JavascriptInterface fun removeKey(k: String) = safe { prefs.edit().remove(k).apply() }

    // ----- HTTP -----
    @JavascriptInterface
    fun http(method: String?, url: String?, body: String?, token: String?, cb: String?) {
        val m = (method ?: "GET").uppercase()
        val u = url ?: return fire(cb, err("empty url"))
        executor.execute {
            var c: HttpURLConnection? = null
            try {
                Log.i(TAG, "$m $u")
                c = (URL(u).openConnection() as HttpURLConnection).apply {
                    requestMethod = m
                    connectTimeout = 15000
                    readTimeout = 20000
                    instanceFollowRedirects = true
                    setRequestProperty("Accept", "application/json, text/plain, */*")
                    setRequestProperty("User-Agent", "Baridat/${BuildConfig.VERSION_NAME} (Android)")
                    if (!token.isNullOrEmpty()) setRequestProperty("Authorization", "Bearer $token")
                    if (!body.isNullOrEmpty()) {
                        setRequestProperty("Content-Type", "application/json; charset=utf-8")
                        doOutput = true
                        OutputStreamWriter(outputStream, StandardCharsets.UTF_8).use { it.write(body); it.flush() }
                    }
                }
                val code = c.responseCode
                val s = if (code in 200..299) c.inputStream else c.errorStream
                val txt = s?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() } ?: ""
                Log.i(TAG, "$m $u -> $code (${txt.length}b)")
                fire(cb, JSONObject().put("ok", code in 200..299).put("status", code).put("body", txt).toString())
            } catch (t: Throwable) {
                Log.e(TAG, "$m $u failed", t)
                fire(cb, err(t.javaClass.simpleName + ": " + (t.message ?: "error")))
            } finally { c?.disconnect() }
        }
    }

    @JavascriptInterface fun log(level: String?, msg: String?) {
        val m = msg ?: return
        when ((level ?: "info").lowercase()) {
            "error", "e" -> Log.e(TAG, m)
            "warn", "w" -> Log.w(TAG, m)
            else -> Log.i(TAG, m)
        }
    }

    private fun fire(cb: String?, json: String) {
        if (cb.isNullOrEmpty()) return
        val wv = webView ?: return
        val safeCb = cb.filter { it.isLetterOrDigit() || it == '_' }
        activity.runOnUiThread {
            // JSONObject.quote produces a properly escaped JS string literal.
            val script = "try{var __f=window[" + JSONObject.quote(safeCb) + "];" +
                "if(typeof __f==='function')__f(" + JSONObject.quote(json) + ");" +
                "}catch(e){android.util.Log.e('BaridatCB',String(e));}"
            wv.evaluateJavascript(script, null)
        }
    }

    private fun err(msg: String) = JSONObject().put("ok", false).put("status", 0).put("error", msg).toString()
    private fun safe(f: () -> Unit) { try { f() } catch (_: Throwable) {} }

    companion object { private const val TAG = "BaridatNative" }
}
