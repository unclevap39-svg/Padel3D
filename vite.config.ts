import { VitePWA } from 'vite-plugin-pwa';
import wasm from 'vite-plugin-wasm';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative URLs: the build works at a domain root (Netlify) or in a sub-folder.
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 5000,
  },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  test: {
    // Node cannot import a .wasm module directly: tests use the build with the binary inlined.
    alias: { '@dimforge/rapier3d': '@dimforge/rapier3d-compat' },
  },
  plugins: [
    wasm(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifestFilename: 'manifest.json',
      includeAssets: ['icons/*.png', 'models/*', 'draco/*'],
      manifest: {
        name: 'Padel 3D',
        short_name: 'Padel 3D',
        description: 'Un match de padel en double, réaliste, en 3D : vitres, grillage, effets et règles officielles.',
        lang: 'fr',
        start_url: './',
        scope: './',
        display: 'fullscreen',
        display_override: ['fullscreen', 'standalone'],
        orientation: 'landscape',
        background_color: '#06101f',
        theme_color: '#06101f',
        categories: ['games', 'sports'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Everything is precached on first visit so the game runs with no connection afterwards.
        globPatterns: ['**/*.{js,css,html,png,webp,glb,wasm,json}'],
        // Three.js also emits its own copies of the Draco decoder; the game uses public/draco.
        globIgnores: ['assets/draco_*'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
    }),
  ],
});
