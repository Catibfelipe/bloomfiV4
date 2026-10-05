import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/',
  build: { rollupOptions: { input: { main: 'index.html', app: 'app/index.html' } } },
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'favicon-64.png', 'apple-touch-icon.png'],
      manifest: {
        id: './',
        name: 'BloomFi — sua coruja do dinheiro',
        short_name: 'BloomFi',
        description: 'Controle financeiro com o Wally: gastos, orçamentos, metas, investimentos e Open Finance. Dados criptografados no seu aparelho.',
        lang: 'pt-BR',
        start_url: '/app/',
        scope: '/',
        display: 'standalone',
        display_override: ['window-controls-overlay', 'standalone'],
        orientation: 'any',
        background_color: '#0b0e13',
        theme_color: '#1f2026',
        categories: ['finance', 'productivity'],
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: 'Adicionar transação', short_name: 'Adicionar', url: '/app/#spend', icons: [{ src: 'pwa-192.png', sizes: '192x192' }] },
          { name: 'Falar com o Wally', short_name: 'Wally', url: '/app/#ai', icons: [{ src: 'pwa-192.png', sizes: '192x192' }] },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,woff2}'],
        globIgnores: ['landing/**'],
        // Only the app is a single-page app; the site pages (/, /termos.html…) are served as they are.
        navigateFallback: '/app/index.html',
        navigateFallbackAllowlist: [/^\/app(\/|$)/],
        navigateFallbackDenylist: [/^\/api\//, /^\/\.netlify\//],
        cleanupOutdatedCaches: true,
        importScripts: ['/push-sw.js'], // bill reminders (push + notification click)
      },
    }),
  ],
});
