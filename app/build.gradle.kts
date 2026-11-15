plugins {
    alias(libs.plugins.android.application)
}

android {
    namespace = "com.baridat.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.baridat.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 21
        versionName = "2.1.0"
    }

    signingConfigs {
        getByName("debug") {
            val stable = rootProject.file("signing/baridat.jks")
            val fallback = rootProject.file("debug.keystore")
            val chosen = if (stable.exists()) stable else fallback
            if (chosen.exists()) {
                storeFile = chosen
                if (chosen.name == "baridat.jks") {
                    storePassword = (System.getenv("BARIDAT_KEYSTORE_PASSWORD") ?: "baridat2026")
                    keyAlias = (System.getenv("BARIDAT_KEY_ALIAS") ?: "baridat")
                    keyPassword = (System.getenv("BARIDAT_KEY_PASSWORD") ?: "baridat2026")
                } else {
                    storePassword = "android"
                    keyAlias = "androiddebugkey"
                    keyPassword = "android"
                }
            }
        }
        create("release") {
            val rel = rootProject.file("signing/baridat.jks")
            if (rel.exists()) {
                storeFile = rel
                storePassword = (System.getenv("BARIDAT_KEYSTORE_PASSWORD") ?: "baridat2026")
                keyAlias = (System.getenv("BARIDAT_KEY_ALIAS") ?: "baridat")
                keyPassword = (System.getenv("BARIDAT_KEY_PASSWORD") ?: "baridat2026")
            }
        }
    }

    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
        getByName("release") {
            isMinifyEnabled = false
            isShrinkResources = false
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.activity.ktx)
    implementation(libs.androidx.webkit)
}
