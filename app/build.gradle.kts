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
        // Stable signing key placed at signing/baridat.jks by CI for tag builds.
        // When the keystore is absent (local dev / PR builds), Gradle falls back to
        // its auto-generated debug keystore automatically.
        create("stable") {
            val f = rootProject.file("signing/baridat.jks")
            if (f.exists()) {
                storeFile = f
                storePassword = (System.getenv("BARIDAT_KEYSTORE_PASSWORD") ?: "baridat2026")
                keyAlias = (System.getenv("BARIDAT_KEY_ALIAS") ?: "baridat")
                keyPassword = (System.getenv("BARIDAT_KEY_PASSWORD") ?: "baridat2026")
            }
        }
    }

    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
            val stable = signingConfigs.findByName("stable")
            if (stable?.storeFile != null) signingConfig = stable
        }
        getByName("release") {
            isMinifyEnabled = false
            isShrinkResources = false
            val stable = signingConfigs.findByName("stable")
            signingConfig = if (stable?.storeFile != null) stable else signingConfigs.getByName("debug")
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
