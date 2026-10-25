// Rocket (Dutch-Bangla Bank) wallet plugin. Simulator by default; optional
// real sandbox (real.ts) against DBBL's public SOAP service once a store
// saves DBBL merchant credentials. Sources in real.ts and spec/v1.json.

import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { GatewaySpecSchema, type CredentialCheck, type GatewayPlugin } from '@paysim/core';

import { rocketSandbox } from './real.js';
import { REFUNDABLE_STATES } from './refund.js';
import { createRocketRouter } from './routes.js';
import { runScenarioAction } from './scenario-actions.js';
import { BUILTIN_SCENARIOS } from './scenarios.js';
import { isTerminal, type RocketState } from './state-machine.js';

function loadSpec(): GatewayPlugin['spec'] {
  const url = new URL('../spec/v1.json', import.meta.url);
  return GatewaySpecSchema.parse(JSON.parse(readFileSync(url, 'utf8')));
}

const CredentialsSchema = z
  .object({
    userid: z.string().min(1).max(64),
    pwd: z.string().min(8).max(256),
    return_url: z.string().url().max(2048),
  })
  .strict();

export const rocketPlugin: GatewayPlugin = {
  name: 'rocket',
  displayName: 'Rocket',
  prefixes: ['/ecomws/', '/ecomm2/', '/rocket/'],
  spec: loadSpec(),
  storeIdField: 'userid',
  defaultCredentials: {
    userid: 'SIM-ROCKET-001',
    pwd: 'sim-rocket-pwd',
    return_url: 'http://localhost:3000/rocket/return',
  },
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
  sandbox: rocketSandbox,
  builtinScenarios: BUILTIN_SCENARIOS,
  refundableStates: REFUNDABLE_STATES,
  isTerminalState(state: string): boolean {
    return isTerminal(state as RocketState);
  },
  runScenarioAction(ctx, txn, app, action, params) {
    return runScenarioAction(ctx, txn, app, action, params);
  },
  createRouter(ctx) {
    return createRocketRouter(ctx);
  },
};

export { setRocketFetch, DBBL_TEST_BASE } from './real.js';
