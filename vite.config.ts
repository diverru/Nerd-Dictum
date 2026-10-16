import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Dev server port - configurable via VITE_PORT env var (default: 12000)
const DEV_PORT = parseInt(process.env.VITE_PORT || '12000', 10);

export default defineConfig({
  plugins: [react()],
  root: 'src/renderer',
  base: './',
  publicDir: 'public',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/renderer/index.html'),
        settings: resolve(__dirname, 'src/renderer/settings.html'),
        info: resolve(__dirname, 'src/renderer/info.html'),
        hide: resolve(__dirname, 'src/renderer/hide.html'),
        stats: resolve(__dirname, 'src/renderer/stats.html'),
        'error-detail': resolve(__dirname, 'src/renderer/error-detail.html'),
      },
    },
  },
  server: {
    port: DEV_PORT,
    strictPort: true,
  },
});
