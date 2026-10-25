import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@paysim/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      '@paysim/gateway-bkash': fileURLToPath(
        new URL('../../packages/gateways/bkash/src/index.ts', import.meta.url),
      ),
      '@paysim/gateway-nagad': fileURLToPath(
        new URL('../../packages/gateways/nagad/src/index.ts', import.meta.url),
      ),
      '@paysim/gateway-rocket': fileURLToPath(
        new URL('../../packages/gateways/rocket/src/index.ts', import.meta.url),
      ),
      '@paysim/gateway-upay': fileURLToPath(
        new URL('../../packages/gateways/upay/src/index.ts', import.meta.url),
      ),
      '@paysim/parity': fileURLToPath(
        new URL('../../packages/parity/src/index.ts', import.meta.url),
      ),
      '@paysim/gateway-sslcommerz': fileURLToPath(
        new URL('../../packages/gateways/sslcommerz/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    // Integration files share one scratch DB (TRUNCATE); run files serially.
    fileParallelism: false,
  },
});
