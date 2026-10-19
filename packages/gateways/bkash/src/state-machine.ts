// bKash tokenized-checkout transaction states. `verified` (customer
// completed wallet/OTP/PIN, merchant has not executed yet) is the only
// non-terminal state besides `initiated`; query maps it to
// Initiated/Complete per the docs.

export const TXN_STATES = [
  'initiated',
  'verified',
  'completed',
  'failed',
  'cancelled',
  'expired',
] as const;
export type BkashState = (typeof TXN_STATES)[number];

export const CHECKOUT_ACTIONS = ['success', 'fail', 'cancel'] as const;
export type CheckoutAction = (typeof CHECKOUT_ACTIONS)[number];
export type CallbackKind = 'success' | 'failure' | 'cancel';

export class InvalidTransitionError extends Error {
  constructor(fromState: string, action: string) {
    super(`Cannot ${action} a bKash payment in state ${fromState}`);
    this.name = 'InvalidTransitionError';
  }
}

const ACTION_TARGET: Record<CheckoutAction, BkashState> = {
  success: 'verified',
  fail: 'failed',
  cancel: 'cancelled',
};

export function applyCheckoutAction(from: BkashState, action: CheckoutAction): BkashState {
  if (from !== 'initiated') throw new InvalidTransitionError(from, action);
  return ACTION_TARGET[action];
}

export function isTerminal(state: BkashState): boolean {
  return state !== 'initiated' && state !== 'verified';
}

export function callbackKindFor(action: CheckoutAction): CallbackKind {
  if (action === 'success') return 'success';
  if (action === 'fail') return 'failure';
  return 'cancel';
}

export function callbackStatusFor(kind: CallbackKind): string {
  return kind;
}

export interface QueryStatus {
  transactionStatus: 'Completed' | 'Initiated';
  verificationStatus: 'Complete' | 'Incomplete';
}

/** Docs: Completed on success, Initiated otherwise (even failed/cancelled). */
export function queryStatusFor(state: BkashState): QueryStatus {
  if (state === 'completed') {
    return { transactionStatus: 'Completed', verificationStatus: 'Complete' };
  }
  if (state === 'verified') {
    return { transactionStatus: 'Initiated', verificationStatus: 'Complete' };
  }
  return { transactionStatus: 'Initiated', verificationStatus: 'Incomplete' };
}
