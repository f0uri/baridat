package com.baridat.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private lateinit var updates: UpdateManager
    private lateinit var channel: MethodChannel
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        channel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "com.baridat.app/native")
        updates = UpdateManager(this) { channel.invokeMethod("updateStatus", it) }
        val prefs = getSharedPreferences("baridat_native", Context.MODE_PRIVATE)
        channel.setMethodCallHandler { call, result ->
            when (call.method) {
                "load" -> result.success(prefs.getString(call.argument<String>("key"), null))
                "save" -> { prefs.edit().putString(call.argument<String>("key"), call.argument<String>("value")).apply(); result.success(null) }
                "downloadUpdate" -> { updates.start(call.argument<String>("url") ?: ""); result.success(null) }
                "installUpdate" -> { updates.installRequested(); result.success(null) }
                "updateStatus" -> { updates.status(); result.success(null) }
                "openUrl" -> { try { val u = Uri.parse(call.argument<String>("url")); if (u.scheme !in listOf("http", "https")) throw IllegalArgumentException(); startActivity(Intent(Intent.ACTION_VIEW, u)); result.success(null) } catch (e: Exception) { result.error("open", "تعذر فتح الرابط", null) } }
                else -> result.notImplemented()
            }
        }
    }
    override fun onResume() { super.onResume(); if (::updates.isInitialized) updates.onResume() }
    override fun onPause() { if (::updates.isInitialized) updates.onPause(); super.onPause() }
}
