import { describe, expect, it } from 'vitest';

import {
  applyCheckoutAction,
  callbackKindFor,
  isTerminal,
  verifyStatusFor,
} from '../src/state-machine.js';

describe('nagad state machine', () => {
  it('settles checkout payments only', () => {
    expect(applyCheckoutAction('checkout', 'success')).toBe('success');
    expect(applyCheckoutAction('checkout', 'fail')).toBe('failed');
    expect(applyCheckoutAction('checkout', 'cancel')).toBe('cancelled');
    expect(() => applyCheckoutAction('initiated', 'success')).toThrow(/Cannot success/);
    expect(() => applyCheckoutAction('success', 'success')).toThrow(/Cannot success/);
  });

  it('treats initiated and checkout as open, the rest as terminal', () => {
    expect(isTerminal('initiated')).toBe(false);
    expect(isTerminal('checkout')).toBe(false);
    for (const state of ['success', 'failed', 'cancelled', 'expired'] as const) {
      expect(isTerminal(state)).toBe(true);
    }
  });

  it('maps callback kinds and verify statuses', () => {
    expect(callbackKindFor('success')).toBe('success');
    expect(callbackKindFor('fail')).toBe('fail');
    expect(callbackKindFor('cancel')).toBe('cancel');
    expect(verifyStatusFor('success')).toBe('Success');
    expect(verifyStatusFor('initiated')).toBe('PENDING');
    expect(verifyStatusFor('checkout')).toBe('PENDING');
    expect(verifyStatusFor('failed')).toBe('FAIL');
    expect(verifyStatusFor('cancelled')).toBe('ABORTED');
    expect(verifyStatusFor('expired')).toBe('ABORTED');
  });
});
