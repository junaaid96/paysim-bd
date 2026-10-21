// Nagad checkout plugin (community flow — everything unverified, see
// spec/v1.json). Mutual RSA with published fake keys; the customer
// browser carries payment_ref_id+status (no server-to-server callback).

import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { GatewaySpecSchema, type CredentialCheck, type GatewayPlugin } from '@paysim/core';

import { isParsableRsaPublicKey } from './crypto.js';
import { loadFixtureKeys } from './fixtures.js';
import { createNagadRouter } from './routes.js';
import { runScenarioAction } from './scenario-actions.js';
import { BUILTIN_SCENARIOS } from './scenarios.js';
import { isTerminal, type NagadState } from './state-machine.js';

function loadSpec(): GatewayPlugin['spec'] {
  // Resolves to packages/gateways/nagad/spec/v1.json from both src/
  // (dev/test) and dist/ (built), mirroring the drizzle layout trick.
  const url = new URL('../spec/v1.json', import.meta.url);
  return GatewaySpecSchema.parse(JSON.parse(readFileSync(url, 'utf8')));
}

const CredentialsSchema = z
  .object({
    merchant_id: z.string().min(1).max(64),
    merchant_number: z.string().regex(/^01\d{9}$/),
    merchant_public_key: z
      .string()
      .min(1)
      .max(8000)
      .refine((value) => isParsableRsaPublicKey(value), {
        message: 'must parse as an RSA public key (PEM or raw base64)',
      }),
  })
  .strict();

export {
  NagadCryptoError,
  normalizePrivateKeyPem,
  normalizePublicKeyPem,
  rsaDecrypt,
  rsaEncrypt,
  rsaSign,
  rsaVerify,
} from './crypto.js';
import { REFUNDABLE_STATES } from './refund.js';
export { loadFixtureKeys } from './fixtures.js';

export const nagadPlugin: GatewayPlugin = {
  name: 'nagad',
  displayName: 'Nagad',
  prefixes: ['/remote-payment-gateway-1.0/', '/nagad/'],
  spec: loadSpec(),
  storeIdField: 'merchant_id',
  defaultCredentials: {
    merchant_id: 'SIM-MERCHANT-001',
    merchant_number: '01700000000',
    merchant_public_key: loadFixtureKeys().merchantPublicPem,
  },
  validateCredentials(input: unknown): CredentialCheck {
    const parsed = CredentialsSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
        ),
      };
    }
    return { ok: true, value: { ...parsed.data } };
  },
  builtinScenarios: BUILTIN_SCENARIOS,
  refundableStates: REFUNDABLE_STATES,
  isTerminalState(state: string): boolean {
    return isTerminal(state as NagadState);
  },
  runScenarioAction(ctx, txn, app, action, params) {
    return runScenarioAction(ctx, txn, app, action, params);
  },
  createRouter(ctx) {
    return createNagadRouter(ctx);
  },
};
