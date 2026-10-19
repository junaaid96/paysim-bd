// Nagad checkout states (community flow): initialize opens a session,
// complete hands the customer a checkout URL, the mock page settles it,
// verify reports the outcome.

export const TXN_STATES = [
  'initiated',
  'checkout',
  'success',
  'failed',
  'cancelled',
  'expired',
] as const;
export type NagadState = (typeof TXN_STATES)[number];

export const CHECKOUT_ACTIONS = ['success', 'fail', 'cancel'] as const;
export type CheckoutAction = (typeof CHECKOUT_ACTIONS)[number];
export type CallbackKind = 'success' | 'fail' | 'cancel';

export class InvalidTransitionError extends Error {
  constructor(fromState: string, action: string) {
    super(`Cannot ${action} a Nagad payment in state ${fromState}`);
    this.name = 'InvalidTransitionError';
  }
}

const ACTION_TARGET: Record<CheckoutAction, NagadState> = {
  success: 'success',
  fail: 'failed',
  cancel: 'cancelled',
};

export function applyCheckoutAction(from: NagadState, action: CheckoutAction): NagadState {
  if (from !== 'checkout') throw new InvalidTransitionError(from, action);
  return ACTION_TARGET[action];
}

export function isTerminal(state: NagadState): boolean {
  return state !== 'initiated' && state !== 'checkout';
}

export function callbackKindFor(action: CheckoutAction): CallbackKind {
  if (action === 'success') return 'success';
  if (action === 'fail') return 'fail';
  return 'cancel';
}

export type VerifyStatus = 'Success' | 'PENDING' | 'ABORTED' | 'FAIL';

/** Community status vocabulary mapped from simulator states. */
export function verifyStatusFor(state: NagadState): VerifyStatus {
  switch (state) {
    case 'success':
      return 'Success';
    case 'failed':
      return 'FAIL';
    case 'cancelled':
    case 'expired':
      return 'ABORTED';
    default:
      return 'PENDING';
  }
}
