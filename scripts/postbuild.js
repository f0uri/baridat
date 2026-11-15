// Post-build step for the Android WebView file:// target:
//
// Vite emits <script type="module" crossorigin src="…"> and
// <link rel="stylesheet" crossorigin href="…"> in index.html. The `crossorigin`
// attribute makes Chromium treat those as CORS requests. When the page is
// loaded from file:///android_asset/ there is no real origin, so the request
// fails silently → no JS, no CSS → the app appears to keep the old v2.0.0 UI
// or shows a blank/broken screen.
//
// We simply strip `crossorigin` from every tag in dist/index.html. Relative
// assets on file:// do not need a CORS setup to load.
//
// We also copy public/ static files that Vite already emitted to dist/ so CI
// does not have to re-copy them.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const htmlPath = resolve('dist', 'index.html');
const html = readFileSync(htmlPath, 'utf-8');
const fixed = html.replace(/\s+crossorigin(="")?/g, '');
writeFileSync(htmlPath, fixed, 'utf-8');

console.log('postbuild: stripped crossorigin from dist/index.html');
