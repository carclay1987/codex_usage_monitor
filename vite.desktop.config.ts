import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'desktop',
  base: './',
  css: { postcss: { plugins: [tailwindcss()] } },
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname),
    },
  },
  plugins: [react()],
  build: {
    outDir: '../desktop-dist',
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        dashboard: resolve(import.meta.dirname, 'desktop/index.html'),
        tray: resolve(import.meta.dirname, 'desktop/tray.html'),
      },
    },
  },
});
