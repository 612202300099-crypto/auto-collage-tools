import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],

    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      rollupOptions: {
        output: {
          // Pisahkan jsPDF ke chunk sendiri agar tidak membebani bundle utama
          manualChunks: {
            'vendor-jspdf': ['jspdf'],
          },
        },
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',

      // Proxy /api/* ke Vercel Dev Server saat development lokal.
      // Cara pakai: jalankan `vercel dev` di terminal terpisah (port 3000),
      // lalu tetap jalankan `npm run dev` seperti biasa (port 5173).
      proxy: {
        '/api': {
          target: 'http://localhost:3000',
          changeOrigin: true,
          secure: false,
        },
      },
    },
  };
});
