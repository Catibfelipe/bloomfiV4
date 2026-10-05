// Build used for the hosted single-page version (no service worker).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  base: './',
  publicDir: false,
  plugins: [react()],
  resolve: { alias: { 'virtual:pwa-register': '/src/lib/sw-stub.js' } },
  define: { 'import.meta.env.VITE_ARTIFACT': JSON.stringify('1') },
  build: { outDir: 'dist-artifact', assetsInlineLimit: 100000000, cssCodeSplit: false, modulePreload: false,
    rolldownOptions: { input: 'app/index.html', output: { codeSplitting: false } } },
});
