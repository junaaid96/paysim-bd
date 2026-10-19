// Built-in scenario presets (seeded globally; validated at seed time).

import type { ScenarioDefinitionInput } from '@paysim/core';

export const BUILTIN_SCENARIOS: ScenarioDefinitionInput[] = [
  { name: 'manual', description: 'Human clicks the mock page buttons (default).', steps: [] },
  {
    name: 'immediate-success',
    description: 'Complete as success right after init, no browser needed.',
    steps: [{ action: 'redirect_success' }],
  },
  {
    name: 'immediate-fail',
    description: 'Complete as failed right after init.',
    steps: [{ action: 'redirect_fail' }],
  },
  {
    name: 'immediate-cancel',
    description: 'Complete as cancelled right after init.',
    steps: [{ action: 'redirect_cancel' }],
  },
  {
    name: 'duplicate-ipn',
    description: 'Success, then the identical IPN delivered a second time.',
    steps: [{ action: 'redirect_success' }, { delayMs: 1000, action: 'send_ipn_duplicate' }],
  },
  {
    name: 'late-ipn',
    description: 'Success now, first IPN 30s later (use the fake clock to jump ahead).',
    steps: [
      { action: 'redirect_success', params: { skipIpn: true } },
      { delayMs: 30_000, action: 'send_ipn_late' },
    ],
  },
  {
    name: 'pending-then-settled',
    description: 'Stay pending for 10s, then settle as success.',
    steps: [{ delayMs: 10_000, action: 'redirect_success' }],
  },
  {
    name: 'amount-mismatch',
    description: 'Raise the amount by 1.00 before success, so merchant amount checks fail.',
    steps: [
      { action: 'mutate_amount', params: { deltaMinor: 100 } },
      { action: 'redirect_success' },
    ],
  },
  {
    name: 'timeout-expiry',
    description: 'Expire the session after 60s with no callbacks.',
    steps: [{ delayMs: 60_000, action: 'timeout' }],
  },
  {
    name: 'stay-pending',
    description: 'Never settle (merchant timeout / polling tests).',
    steps: [{ action: 'stay_pending' }],
  },
];
