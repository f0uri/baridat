package com.baridat.app

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File

/** Downloads only this project's release APK and verifies its identity before installation. */
class UpdateManager(private val activity: MainActivity, private val notify: (String) -> Unit) {
    private val downloads = activity.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
    private val prefs = activity.getSharedPreferences("baridat_update", Context.MODE_PRIVATE)
    private val handler = Handler(Looper.getMainLooper())
    private var polling = false
    private var awaitingPermission = false
    private var autoInstall = false
    private val apk: File get() = File(activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "baridat-update.apk")
    private val poll = object : Runnable {
        override fun run() { if (polling) { check(); if (polling) handler.postDelayed(this, 1200) } }
    }

    private fun emit(state: String, message: String, progress: Int = -1) {
        notify(JSONObject().put("state", state).put("message", message).put("progress", progress).toString())
    }

    fun start(url: String) {
        try {
            val uri = Uri.parse(url)
            val validPath = Regex("^/f0uri/baridat/releases/download/v[0-9]+\\.[0-9]+\\.[0-9]+/baridat\\.apk$")
            if (uri.scheme != "https" || uri.host != "github.com" || uri.port != -1 || uri.query != null || uri.fragment != null || !validPath.matches(uri.path ?: "")) {
                emit("error", "رابط التحديث غير موثوق"); return
            }
            val existing = prefs.getLong("downloadId", -1)
            if (existing != -1L) { autoInstall = true; startPolling(); return }
            val directory = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
                ?: throw IllegalStateException("storage unavailable")
            directory.mkdirs()
            if (apk.exists() && !apk.delete()) throw IllegalStateException("cannot replace old update")
            val request = DownloadManager.Request(uri)
                .setTitle("تحديث بريدات")
                .setDescription("جاري تنزيل التحديث")
                .setMimeType("application/vnd.android.package-archive")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalFilesDir(activity, Environment.DIRECTORY_DOWNLOADS, "baridat-update.apk")
            val id = downloads.enqueue(request)
            prefs.edit().putLong("downloadId", id).apply()
            autoInstall = true
            emit("downloading", "جاري تنزيل التحديث…")
            startPolling()
        } catch (_: Exception) { emit("error", "تعذر بدء تنزيل التحديث. حاول مجدداً.") }
    }

    fun onResume() {
        if (awaitingPermission) {
            awaitingPermission = false
            if (activity.packageManager.canRequestPackageInstalls()) install()
            else emit("ready", "اسمح بتثبيت التطبيقات من هذا المصدر ثم اضغط تثبيت.")
        }
        if (prefs.getLong("downloadId", -1) != -1L) startPolling()
    }
    fun onPause() { polling = false; handler.removeCallbacks(poll) }
    fun status() { if (prefs.getLong("downloadId", -1) != -1L) startPolling() }
    fun installRequested() { autoInstall = true; install() }
    private fun startPolling() {
        if (!polling) { polling = true; handler.post(poll) }
    }
    private fun check() {
        val id = prefs.getLong("downloadId", -1)
        if (id == -1L) { polling = false; return }
        try {
            val cursor = downloads.query(DownloadManager.Query().setFilterById(id))
            cursor.use {
                if (!it.moveToFirst()) { clear(); emit("error", "لم يُعثر على التنزيل. حاول مجدداً."); return }
                when (it.getInt(it.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))) {
                    DownloadManager.STATUS_SUCCESSFUL -> {
                        polling = false
                        if (alreadyInstalled()) { clear(); apk.delete(); return }
                        if (!validApk()) { clear(); apk.delete(); emit("error", "فشل التحقق من التحديث أو توقيعه."); return }
                        emit("ready", "اكتمل التنزيل. اضغط تثبيت لإكمال التحديث.")
                        if (autoInstall) { autoInstall = false; install() }
                    }
                    DownloadManager.STATUS_FAILED -> { clear(); emit("error", "فشل تنزيل التحديث. تحقق من الاتصال وحاول مجدداً.") }
                    else -> {
                        val total = it.getLong(it.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
                        val done = it.getLong(it.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
                        val percent = if (total > 0) ((done * 100 / total).coerceIn(0, 100)).toInt() else -1
                        emit("downloading", if (percent >= 0) "جاري تنزيل التحديث: $percent%" else "جاري تنزيل التحديث…", percent)
                    }
                }
            }
        } catch (_: Exception) { polling = false; emit("error", "تعذر متابعة التنزيل.") }
    }
    @Suppress("DEPRECATION")
    private fun alreadyInstalled(): Boolean {
        return try {
            val archive = activity.packageManager.getPackageArchiveInfo(apk.absolutePath, 0) ?: return false
            val installed = activity.packageManager.getPackageInfo(activity.packageName, 0)
            val version = if (Build.VERSION.SDK_INT >= 28) archive.longVersionCode else archive.versionCode.toLong()
            val current = if (Build.VERSION.SDK_INT >= 28) installed.longVersionCode else installed.versionCode.toLong()
            archive.packageName == activity.packageName && version <= current
        } catch (_: Exception) { false }
    }
    @Suppress("DEPRECATION")
    private fun signatures(info: PackageInfo) = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
    @Suppress("DEPRECATION")
    private fun validApk(): Boolean {
        return try {
            val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
            val archive = activity.packageManager.getPackageArchiveInfo(apk.absolutePath, flags) ?: return false
            val installed = activity.packageManager.getPackageInfo(activity.packageName, flags)
            val version = if (Build.VERSION.SDK_INT >= 28) archive.longVersionCode else archive.versionCode.toLong()
            val installedVersion = if (Build.VERSION.SDK_INT >= 28) installed.longVersionCode else installed.versionCode.toLong()
            val actual = signatures(archive)?.map { it.toCharsString() }?.toSet()
            val expected = signatures(installed)?.map { it.toCharsString() }?.toSet()
            apk.isFile && archive.packageName == activity.packageName && version > installedVersion && !actual.isNullOrEmpty() && actual == expected
        } catch (_: Exception) { false }
    }
    private fun install() {
        try {
            if (!validApk()) { emit("error", "فشل التحقق من ملف التحديث."); return }
            if (!activity.packageManager.canRequestPackageInstalls()) {
                awaitingPermission = true
                emit("permission", "يرجى السماح بتثبيت التطبيقات من بريدات ثم العودة.")
                activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
                return
            }
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.updates", apk)
            val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            activity.startActivity(intent)
            emit("installing", "أكّد تثبيت التحديث في نافذة أندرويد.")
        } catch (_: Exception) { emit("ready", "تعذر فتح المثبّت. اضغط تثبيت للمحاولة مجدداً.") }
    }
    private fun clear() { prefs.edit().remove("downloadId").apply(); polling = false }
}
