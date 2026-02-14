import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'pwa-192x192.png', 'pwa-512x512.png'],
      manifest: {
        name: 'Prevue - Cable TV Guide',
        short_name: 'Prevue',
        description: 'A retro cable TV guide for your Jellyfin media library. Channel surf your own content.',
        theme_color: '#0a0e2a',
        background_color: '#0a0e2a',
        display: 'standalone',
        orientation: 'any',
        scope: '/',
        start_url: '/',
        categories: ['entertainment', 'video'],
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.(?:googleapis|gstatic)\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts',
              expiration: { maxEntries: 4, maxAgeSeconds: 365 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    host: true, // Listen on all interfaces so other devices on the network can connect
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3080',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3080',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false, // Disabled in production for security; enable only for private error monitoring
  },
  // Ensure SPA routing works in preview mode
  preview: {
    port: 5173,
  },
});
