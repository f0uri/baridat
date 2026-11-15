import { defineConfig } from 'vite';

// Vite config tuned for an Android WebView that loads the app from
// file:///android_asset/ (no HTTP server, no origin):
//   1. base './' so asset URLs resolve relative to index.html.
//   2. No code-splitting: single JS + CSS chunk (module preload is useless on
//      file:// and dynamic imports can trip on origin checks).
//   3. After build, we post-process dist/index.html to strip the `crossorigin`
//      attribute that Vite adds to module scripts/stylesheets. On file://,
//      crossorigin triggers a CORS fetch against a null origin, which Chromium
//      silently rejects → JS/CSS don't load → blank-looking old UI.
export default defineConfig({
  base: './',
  server: { host: '0.0.0.0', port: 5173, allowedHosts: true },
  preview: { host: '0.0.0.0', port: 4173, allowedHosts: true },
  build: {
    outDir: 'dist',
    target: 'es2019',
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
