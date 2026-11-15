plugins {
    alias(libs.plugins.android.application)
}

android {
    namespace = "com.baridat.app"
    compileSdk = 36

    buildFeatures {
        buildConfig = true
    }

    defaultConfig {
        applicationId = "com.baridat.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 24
        versionName = "2.1.3"
    }

    signingConfigs {
        create("release") {
            val keystoreFile = rootProject.file("signing/baridat.jks")
            val debugFile = rootProject.file("debug.keystore")
            val chosen = when {
                keystoreFile.exists() -> keystoreFile
                debugFile.exists() -> debugFile
                else -> null
            }
            if (chosen != null) {
                storeFile = chosen
                if (chosen.name == "baridat.jks") {
                    storePassword = System.getenv("BARIDAT_KEYSTORE_PASSWORD") ?: "baridat2026"
                    keyAlias = System.getenv("BARIDAT_KEY_ALIAS") ?: "baridat"
                    keyPassword = System.getenv("BARIDAT_KEY_PASSWORD") ?: "baridat2026"
                } else {
                    storePassword = "android"
                    keyAlias = "androiddebugkey"
                    keyPassword = "android"
                }
            }
        }
        getByName("debug") {
            val releaseCfg = signingConfigs.getByName("release")
            if (releaseCfg.storeFile != null) {
                storeFile = releaseCfg.storeFile
                storePassword = releaseCfg.storePassword
                keyAlias = releaseCfg.keyAlias
                keyPassword = releaseCfg.keyPassword
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
