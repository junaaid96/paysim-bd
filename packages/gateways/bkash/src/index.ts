// bKash tokenized-checkout plugin (v2 API surface): auth, payment
// routes + builders + state machine. No server-to-server callback exists
// in this flow — the customer browser carries paymentID+status. Fidelity
// contract: spec/v1.json.

import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { GatewaySpecSchema, type CredentialCheck, type GatewayPlugin } from '@paysim/core';

import { createBkashRouter } from './routes.js';
import { runScenarioAction } from './scenario-actions.js';
import { BUILTIN_SCENARIOS } from './scenarios.js';
import { isTerminal, type BkashState } from './state-machine.js';

function loadSpec(): GatewayPlugin['spec'] {
  // Resolves to packages/gateways/bkash/spec/v1.json from both src/
  // (dev/test) and dist/ (built), mirroring the drizzle layout trick.
  const url = new URL('../spec/v1.json', import.meta.url);
  return GatewaySpecSchema.parse(JSON.parse(readFileSync(url, 'utf8')));
}

const CredentialsSchema = z
  .object({
    app_key: z.string().min(1).max(64),
    app_secret: z.string().min(1).max(128),
    username: z.string().min(1).max(64),
    password: z.string().min(1).max(128),
  })
  .strict();

export const bkashPlugin: GatewayPlugin = {
  name: 'bkash',
  displayName: 'bKash',
  prefixes: ['/v2/tokenized-checkout/', '/bkash/'],
  spec: loadSpec(),
  storeIdField: 'app_key',
  defaultCredentials: {
    app_key: 'sim-app-key',
    app_secret: 'sim-app-secret-key',
    username: 'sim-merchant',
    password: 'sim-merchant-password',
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
  isTerminalState(state: string): boolean {
    return isTerminal(state as BkashState);
  },
  runScenarioAction(ctx, txn, app, action, params) {
    return runScenarioAction(ctx, txn, app, action, params);
  },
  createRouter(ctx) {
    return createBkashRouter(ctx);
  },
};
