// Upay (UCB Fintech) wallet plugin. Simulator by default; optional real
// sandbox (real.ts) once a store saves Upay merchant credentials. Every
// path is community-sourced (unverified); see spec/v1.json.

import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { GatewaySpecSchema, type CredentialCheck, type GatewayPlugin } from '@paysim/core';

import { upaySandbox } from './real.js';
import { REFUNDABLE_STATES } from './refund.js';
import { createUpayRouter } from './routes.js';
import { runScenarioAction } from './scenario-actions.js';
import { BUILTIN_SCENARIOS } from './scenarios.js';
import { isTerminal, type UpayState } from './state-machine.js';

function loadSpec(): GatewayPlugin['spec'] {
  const url = new URL('../spec/v1.json', import.meta.url);
  return GatewaySpecSchema.parse(JSON.parse(readFileSync(url, 'utf8')));
}

const CredentialsSchema = z
  .object({
    merchant_id: z.string().min(1).max(64),
    merchant_key: z.string().min(8).max(256),
  })
  .strict();

export const upayPlugin: GatewayPlugin = {
  name: 'upay',
  displayName: 'Upay',
  prefixes: ['/payment/', '/upay/'],
  spec: loadSpec(),
  storeIdField: 'merchant_id',
  defaultCredentials: { merchant_id: 'SIM-UPAY-001', merchant_key: 'sim-upay-merchant-key' },
  validateCredentials(input: unknown): CredentialCheck {
    const parsed = CredentialsSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      };
    }
    return { ok: true, value: { ...parsed.data } };
  },
  sandbox: upaySandbox,
  builtinScenarios: BUILTIN_SCENARIOS,
  refundableStates: REFUNDABLE_STATES,
  isTerminalState(state: string): boolean {
    return isTerminal(state as UpayState);
  },
  runScenarioAction(ctx, txn, app, action, params) {
    return runScenarioAction(ctx, txn, app, action, params);
  },
  createRouter(ctx) {
    return createUpayRouter(ctx);
  },
};

export { setUpayFetch, UPAY_UAT_BASE } from './real.js';
