import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Explicit IPv4 loopback: the 'localhost' default can bind IPv6-only.
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3001',
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
});
