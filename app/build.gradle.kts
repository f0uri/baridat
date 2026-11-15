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
        create("release") {
            val keystoreFile = rootProject.file("signing/baridat.jks")
            if (keystoreFile.exists()) {
                storeFile = keystoreFile
                storePassword = System.getenv("BARIDAT_KEYSTORE_PASSWORD") ?: "baridat2026"
                keyAlias = System.getenv("BARIDAT_KEY_ALIAS") ?: "baridat"
                keyPassword = System.getenv("BARIDAT_KEY_PASSWORD") ?: "baridat2026"
            }
        }
    }

    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
        }
        getByName("release") {
            isMinifyEnabled = false
            isShrinkResources = false
            val releaseCfg = signingConfigs.findByName("release")
            if (releaseCfg?.storeFile != null) {
                signingConfig = releaseCfg
            }
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
