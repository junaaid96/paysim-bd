// SSLCommerz gateway plugin: mock routes + validation + response builders
// + state machine + IPN builders. Fidelity contract: spec/v1.json.

import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { GatewaySpecSchema, type CredentialCheck, type GatewayPlugin } from '@paysim/core';

import { createSslcommerzRouter } from './routes.js';
import { runScenarioAction } from './scenario-actions.js';
import { BUILTIN_SCENARIOS } from './scenarios.js';
import { isTerminal, type SslcommerzState } from './state-machine.js';

function loadSpec(): GatewayPlugin['spec'] {
  // Resolves to packages/gateways/sslcommerz/spec/v1.json from both
  // src/ (dev/test) and dist/ (built), mirroring the drizzle layout trick.
  const url = new URL('../spec/v1.json', import.meta.url);
  return GatewaySpecSchema.parse(JSON.parse(readFileSync(url, 'utf8')));
}

const CredentialsSchema = z
  .object({
    store_id: z.string().min(1).max(30),
    store_passwd: z.string().min(1).max(128),
  })
  .strict();

export const sslcommerzPlugin: GatewayPlugin = {
  name: 'sslcommerz',
  displayName: 'SSLCommerz',
  prefixes: ['/gwprocess/', '/validator/'],
  spec: loadSpec(),
  storeIdField: 'store_id',
  defaultCredentials: { store_id: 'testbox', store_passwd: 'qwerty' },
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
    return isTerminal(state as SslcommerzState);
  },
  runScenarioAction(ctx, txn, app, action, params) {
    return runScenarioAction(ctx, txn, app, action, params);
  },
  createRouter(ctx) {
    return createSslcommerzRouter(ctx);
  },
};
