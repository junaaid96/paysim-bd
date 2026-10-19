// Published fake "Nagad" keypair (spec/fixtures). Committed on purpose:
// merchants encrypt requests with the public half; the simulator
// decrypts with the private half. Shape-only crypto, never identity.

import { readFileSync } from 'node:fs';

export interface FixtureKeys {
  publicPem: string;
  privatePem: string;
  /** Zero-setup merchant key for the default app (decrypts sim responses). */
  merchantPublicPem: string;
  merchantPrivatePem: string;
}

let cached: FixtureKeys | null = null;

export function loadFixtureKeys(): FixtureKeys {
  if (!cached) {
    // Resolves to packages/gateways/nagad/spec/fixtures/ from both src/
    // (dev/test) and dist/ (built), mirroring the spec layout trick.
    const base = new URL('../spec/fixtures/', import.meta.url);
    cached = {
      publicPem: readFileSync(new URL('FAKE-nagad-sim-public.pem', base), 'utf8'),
      privatePem: readFileSync(new URL('FAKE-nagad-sim-private.pem', base), 'utf8'),
      merchantPublicPem: readFileSync(new URL('FAKE-merchant-sim-public.pem', base), 'utf8'),
      merchantPrivatePem: readFileSync(new URL('FAKE-merchant-sim-private.pem', base), 'utf8'),
    };
  }
  return cached;
}
