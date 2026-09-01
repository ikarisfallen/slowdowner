import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // GitHub Pages project site serves under /slowdowner/; CI sets VITE_BASE.
  // Local dev/build default to root.
  base: process.env.VITE_BASE || '/',
  define: {
    // A build stamp so you can see which version is loaded (helps confirm PWA updates).
    __BUILD_TIME__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
  },
  server: { host: true },        // expose on LAN so the phone can reach the dev server
  preview: { host: true },
  worker: { format: 'es' },
  // Keep native class fields in optimized deps; down-transpiling them made
  // esbuild emit a __publicField helper that broke across pre-bundled chunks.
  esbuild: { target: 'esnext' },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
  build: { target: 'esnext' },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Slowdowner — Practice Looper',
        short_name: 'Slowdowner',
        description:
          'Slow down music without changing pitch, set A/B loops, and save practice sections per song.',
        theme_color: '#0f1116',
        background_color: '#0f1116',
        display: 'standalone',
        orientation: 'any',
        icons: [
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml' },
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell is cached; audio files live in IndexedDB, not the SW cache.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
    }),
  ],
});
