# بريدات — Baridat ✉️

**تطبيق بريد مؤقت (Temp Mail) بواجهة زجاجية عائمة عربية**

صندوق بريد مؤقت أنيق لاستقبال رسائل التفعيل والبريد العشوائي بدون الحاجة لإعطاء بريدك الحقيقي. يُبنى كـ PWA و APK أندرويد محليّاً بدون أي إعلانات أو اشتراكات.

![Baridat](public/icon-512.png)

## ✨ الميزات

- 🎨 **واجهة زجاجية عائمة (Glassmorphism)** مع خلفية متدرجة متحركة
- 📬 **استقبال فوري** للرسائل كل 15 ثانية مع إشعار
- 📋 **نسخ البريد** بنقرة واحدة
- 🔄 **تغيير البريد** لإنشاء بريد جديد فوري
- 💾 **عدة بريدات محفوظة** محلياً — يمكنك التبديل بينها بسهولة
- 🗑️ حذف البريد (نقر مزدوج في القائمة الجانبية)
- 📎 عرض المرفقات وتحميلها
- 📱 تصميم متجاوب RTL بالكامل
- 🔄 **تحديثات OTA** عبر Service Worker
- 📲 متوفر كـ **APK** مباشر + PWA للتثبيت من المتصفح

## 🚀 التشغيل

```bash
npm install
npm run dev       # خادم التطوير http://localhost:5173
npm run build     # بناء الإنتاج في dist/
npm run preview   # معاينة نسخة الإنتاج
```

## 📲 تحميل الـ APK

الملف الجاهز: [`baridat.apk`](baridat.apk) (12 MB)

يمكنك كذلك تثبيته كـ PWA مباشرة من المتصفح على أندرويد و iOS.

## 🏗️ بناء الـ APK من المصدر

```bash
cd apk-build
python3 mkapk.py
# سيُنتج baridat.apk في جذر المشروع
```

> لا يتطلب Java أو Android SDK — يتم البناء كاملاً في Python.

## 🔧 التقنيات

- **Vite + Vanilla JS** — خفيف وسريع
- **CSS Glassmorphism** + متغيرات CSS + RTL
- **mail.tm API** لخدمة البريد المؤقت
- **Service Worker** للعمل أوفلاين وتحديثات OTA
- **PWA Manifest** لتثبيت التطبيق كتطبيق أصلي
- **مُولِّد APK في Python** (dex.py + axml.py + arsc.py + pkcs7_sign.py)

## 📁 هيكل المشروع

```
├── index.html
├── public/
│   ├── baridat.apk            # APK المُوقَّع جاهز للتنزيل
│   ├── sw.js                  # Service Worker
│   ├── manifest.webmanifest   # إعدادات PWA
│   ├── icon.svg / icon-*.png  # الأيقونات
│   └── version.json
├── src/
│   ├── main.js
│   └── style.css
├── apk-build/                 # أدوات بناء APK (pure-Python)
│   ├── mkapk.py
│   ├── dex.py
│   ├── axml.py
│   ├── arsc.py
│   └── pkcs7_sign.py
├── baridat.apk                # الناتج النهائي
├── vite.config.js
└── package.json
```

## 📜 الترخيص

MIT
