import { describe, expect, it } from 'vitest';

import {
  applyCheckoutAction,
  callbackKindFor,
  isTerminal,
  queryStatusFor,
} from '../src/state-machine.js';

describe('bkash state machine', () => {
  it('verifies, fails or cancels initiated payments', () => {
    expect(applyCheckoutAction('initiated', 'success')).toBe('verified');
    expect(applyCheckoutAction('initiated', 'fail')).toBe('failed');
    expect(applyCheckoutAction('initiated', 'cancel')).toBe('cancelled');
  });

  it('refuses to re-drive settled payments', () => {
    expect(() => applyCheckoutAction('verified', 'success')).toThrow(/Cannot success/);
    expect(() => applyCheckoutAction('completed', 'fail')).toThrow(/Cannot fail/);
  });

  it('treats initiated and verified as open, the rest as terminal', () => {
    expect(isTerminal('initiated')).toBe(false);
    expect(isTerminal('verified')).toBe(false);
    for (const state of ['completed', 'failed', 'cancelled', 'expired'] as const) {
      expect(isTerminal(state)).toBe(true);
    }
  });

  it('maps callback kinds and query statuses per the docs', () => {
    expect(callbackKindFor('success')).toBe('success');
    expect(callbackKindFor('fail')).toBe('failure');
    expect(callbackKindFor('cancel')).toBe('cancel');
    expect(queryStatusFor('completed')).toEqual({
      transactionStatus: 'Completed',
      verificationStatus: 'Complete',
    });
    // Verified-but-unexecuted still queries as Initiated (sample-verified).
    expect(queryStatusFor('verified')).toEqual({
      transactionStatus: 'Initiated',
      verificationStatus: 'Complete',
    });
    // Failed/cancelled verification also queries as Initiated.
    expect(queryStatusFor('failed')).toEqual({
      transactionStatus: 'Initiated',
      verificationStatus: 'Incomplete',
    });
    expect(queryStatusFor('cancelled')).toEqual({
      transactionStatus: 'Initiated',
      verificationStatus: 'Incomplete',
    });
  });
});
