import { defineConfig } from 'vite';

// Use relative base so the build works when loaded from file:///android_asset/
// inside the WebView (asset paths resolve relative to index.html).
export default defineConfig({
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  build: {
    outDir: 'dist',
  },
});
