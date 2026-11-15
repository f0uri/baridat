plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("dev.flutter.flutter-gradle-plugin")
}
android {
    namespace = "com.baridat.app"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.baridat.app"
        minSdk = 26
        targetSdk = 36
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    signingConfigs {
        create("stable") {
            val key = rootProject.file("signing/baridat.jks")
            if (key.exists()) {
                storeFile = key
                storePassword = System.getenv("BARIDAT_KEYSTORE_PASSWORD") ?: "baridat2026"
                keyAlias = System.getenv("BARIDAT_KEY_ALIAS") ?: "baridat"
                keyPassword = System.getenv("BARIDAT_KEY_PASSWORD") ?: "baridat2026"
            }
        }
    }
    buildTypes { getByName("release") { signingConfig = if (rootProject.file("signing/baridat.jks").exists()) signingConfigs.getByName("stable") else signingConfigs.getByName("debug") } }
}
flutter { source = "../.." }
dependencies { implementation("androidx.core:core-ktx:1.16.0") }
