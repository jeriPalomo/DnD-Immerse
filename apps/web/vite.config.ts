import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const SERVER = 'http://127.0.0.1:3001';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Bind on all interfaces so friends on the tailnet can reach the dev server.
    host: true,
    proxy: {
      '/api': { target: SERVER, changeOrigin: true },
      '/uploads': { target: SERVER, changeOrigin: true },
      // Bestiary art. Without this every monster thumbnail 404s under
      // `npm run dev`, which is the command the README tells you to develop on.
      '/srd-images': { target: SERVER, changeOrigin: true },
      '/socket.io': { target: SERVER, ws: true, changeOrigin: true },
    },
  },
  build: { outDir: 'dist' },
});
