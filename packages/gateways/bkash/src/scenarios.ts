// Built-in scenario presets (seeded globally; validated at seed time).
// No duplicate/late-IPN presets: tokenized checkout performs no
// server-to-server callback, so those actions skip by design.

import type { ScenarioDefinitionInput } from '@paysim/core';

export const BUILTIN_SCENARIOS: ScenarioDefinitionInput[] = [
  { name: 'manual', description: 'Human clicks the mock page buttons (default).', steps: [] },
  {
    name: 'immediate-success',
    description: 'Verify immediately; the merchant still calls execute.',
    steps: [{ action: 'redirect_success' }],
  },
  {
    name: 'immediate-fail',
    description: 'Fail verification right after create.',
    steps: [{ action: 'redirect_fail' }],
  },
  {
    name: 'immediate-cancel',
    description: 'Cancel right after create.',
    steps: [{ action: 'redirect_cancel' }],
  },
  {
    name: 'pending-then-verified',
    description: 'Stay initiated for 10s, then verify.',
    steps: [{ delayMs: 10_000, action: 'redirect_success' }],
  },
  {
    name: 'verify-then-expire',
    description: 'Verify now, expire unexecuted after 60s (24h validity, short-circuited).',
    steps: [{ action: 'redirect_success' }, { delayMs: 60_000, action: 'timeout' }],
  },
  {
    name: 'amount-mismatch',
    description: 'Raise the amount by 1.00 before verify, so merchant amount checks fail.',
    steps: [
      { action: 'mutate_amount', params: { deltaMinor: 100 } },
      { action: 'redirect_success' },
    ],
  },
  {
    name: 'timeout-expiry',
    description: 'Expire the payment after 60s with no verification.',
    steps: [{ delayMs: 60_000, action: 'timeout' }],
  },
  {
    name: 'stay-pending',
    description: 'Never verify (merchant timeout / polling tests).',
    steps: [{ action: 'stay_pending' }],
  },
];
