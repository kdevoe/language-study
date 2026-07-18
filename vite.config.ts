import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // Minimal service worker (path-forward §0.5). Installed-PWA users repeatedly
    // ended up on stale builds with no recovery short of reinstalling — there was
    // a manifest but NO service worker, so the browser's HTTP cache decided
    // freshness. Precache the app shell; `prompt` mode surfaces an in-app
    // "update available" reload (UpdatePrompt.tsx) instead of silently swapping
    // versions mid-session.
    VitePWA({
      registerType: 'prompt',
      // Keep the existing hand-written public/manifest.json (linked from
      // index.html) — the plugin only manages the worker.
      manifest: false,
      workbox: {
        // App shell only. Screenshots (*.jpg) stay out; the main bundle exceeds
        // workbox's 2 MiB default, hence the raised cap.
        globPatterns: ['**/*.{js,css,html,ico,svg,png}'],
        globIgnores: ['screenshot-*.jpg'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        // Never let the SPA fallback swallow the Vercel news proxy.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // The 17 MB kuromoji dictionary: cache-first after first use so
            // tokenization (and with it flashcard furigana) works offline.
            // Deliberately NOT precached — it would bloat every install/update.
            urlPattern: /\/kuromoji-dict\/.*\.dat\.gz$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'kuromoji-dict',
              expiration: { maxEntries: 20 },
            },
          },
        ],
      },
    }),
  ],
})
