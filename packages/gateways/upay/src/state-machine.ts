// Upay checkout states: merchant-payment-init opens a session (checkout),
// the payment page settles it, single-payment-status reports the outcome.

export const TXN_STATES = [
  'initiated',
  'checkout',
  'success',
  'failed',
  'cancelled',
  'expired',
] as const;
export type UpayState = (typeof TXN_STATES)[number];

export const CHECKOUT_ACTIONS = ['success', 'fail', 'cancel'] as const;
export type CheckoutAction = (typeof CHECKOUT_ACTIONS)[number];
export type CallbackKind = 'success' | 'fail' | 'cancel';

export class InvalidTransitionError extends Error {
  constructor(fromState: string, action: string) {
    super(`Cannot ${action} a Upay payment in state ${fromState}`);
    this.name = 'InvalidTransitionError';
  }
}

const ACTION_TARGET: Record<CheckoutAction, UpayState> = {
  success: 'success',
  fail: 'failed',
  cancel: 'cancelled',
};

export function applyCheckoutAction(from: UpayState, action: CheckoutAction): UpayState {
  if (from !== 'checkout') throw new InvalidTransitionError(from, action);
  return ACTION_TARGET[action];
}

export function isTerminal(state: UpayState): boolean {
  return state !== 'initiated' && state !== 'checkout';
}

export function callbackKindFor(action: CheckoutAction): CallbackKind {
  if (action === 'success') return 'success';
  if (action === 'fail') return 'fail';
  return 'cancel';
}

/** single-payment-status `status` values (BDPayGate UpayGateway.php). */
export type UpayStatus = 'success' | 'failed' | 'expired' | 'cancelled' | 'pending';

export function upayStatusFor(state: UpayState): UpayStatus {
  switch (state) {
    case 'success':
      return 'success';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'expired':
      return 'expired';
    default:
      return 'pending';
  }
}
