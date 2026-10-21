import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@paysim/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
    },
  },
  server: {
    // Explicit IPv4 loopback: the 'localhost' default can bind IPv6-only.
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      // Dashboard API + every simulated gateway path (must match the plugin
      // prefixes in packages/gateways/*/src/index.ts), so the dashboard
      // origin is a working gateway base URL in dev too.
      '/api': 'http://127.0.0.1:3001',
      '/gwprocess/': 'http://127.0.0.1:3001',
      '/validator/': 'http://127.0.0.1:3001',
      '/v2/tokenized-checkout/': 'http://127.0.0.1:3001',
      '/bkash/': 'http://127.0.0.1:3001',
      '/remote-payment-gateway-1.0/': 'http://127.0.0.1:3001',
      '/nagad/': 'http://127.0.0.1:3001',
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
});
