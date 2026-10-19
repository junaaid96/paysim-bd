import { describe, expect, it } from 'vitest';

import {
  InvalidTransitionError,
  applyCheckoutAction,
  ipnStatusFor,
  isTerminal,
} from '../src/state-machine.js';

describe('sslcommerz state machine', () => {
  it('maps checkout buttons to terminal states', () => {
    expect(applyCheckoutAction('initiated', 'success')).toBe('valid');
    expect(applyCheckoutAction('initiated', 'fail')).toBe('failed');
    expect(applyCheckoutAction('initiated', 'cancel')).toBe('cancelled');
  });

  it('rejects repeat outcomes on terminal states', () => {
    for (const state of ['valid', 'failed', 'cancelled', 'expired'] as const) {
      expect(() => applyCheckoutAction(state, 'success')).toThrow(InvalidTransitionError);
    }
  });

  it('maps states to IPN statuses', () => {
    expect(ipnStatusFor('valid')).toBe('VALID');
    expect(ipnStatusFor('failed')).toBe('FAILED');
    expect(ipnStatusFor('cancelled')).toBe('CANCELLED');
    expect(() => ipnStatusFor('initiated')).toThrow(InvalidTransitionError);
  });

  it('knows terminal states', () => {
    expect(isTerminal('initiated')).toBe(false);
    expect(isTerminal('valid')).toBe(true);
    expect(isTerminal('expired')).toBe(true);
  });
});
