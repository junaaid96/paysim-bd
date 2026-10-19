// Built-in scenario presets (seeded globally; validated at seed time).
// No duplicate/late-IPN presets: checkout performs no server-to-server
// callback, so those actions skip by design. Steps run once the merchant
// calls complete (scenarios attach there, not at initialize).

import type { ScenarioDefinitionInput } from '@paysim/core';

export const BUILTIN_SCENARIOS: ScenarioDefinitionInput[] = [
  { name: 'manual', description: 'Human clicks the mock page buttons (default).', steps: [] },
  {
    name: 'immediate-success',
    description: 'Approve as soon as the merchant calls complete.',
    steps: [{ action: 'redirect_success' }],
  },
  {
    name: 'immediate-fail',
    description: 'Fail as soon as the merchant calls complete.',
    steps: [{ action: 'redirect_fail' }],
  },
  {
    name: 'immediate-cancel',
    description: 'Cancel as soon as the merchant calls complete.',
    steps: [{ action: 'redirect_cancel' }],
  },
  {
    name: 'pending-then-success',
    description: 'Stay on the checkout page for 10s, then approve.',
    steps: [{ delayMs: 10_000, action: 'redirect_success' }],
  },
  {
    name: 'amount-mismatch',
    description: 'Raise the amount by 1.00 before approval, so merchant amount checks fail.',
    steps: [
      { action: 'mutate_amount', params: { deltaMinor: 100 } },
      { action: 'redirect_success' },
    ],
  },
  {
    name: 'timeout-expiry',
    description: 'Expire the session after 60s with no approval.',
    steps: [{ delayMs: 60_000, action: 'timeout' }],
  },
  {
    name: 'stay-pending',
    description: 'Never settle (merchant timeout / polling tests).',
    steps: [{ action: 'stay_pending' }],
  },
];
