// Rocket checkout states: getransid opens a session (checkout), the
// ClientHandler page settles it, getresult/getresultrocket reports it.

export const TXN_STATES = [
  'initiated',
  'checkout',
  'success',
  'failed',
  'cancelled',
  'expired',
] as const;
export type RocketState = (typeof TXN_STATES)[number];

export const CHECKOUT_ACTIONS = ['success', 'fail', 'cancel'] as const;
export type CheckoutAction = (typeof CHECKOUT_ACTIONS)[number];
export type CallbackKind = 'success' | 'fail' | 'cancel';

export class InvalidTransitionError extends Error {
  constructor(fromState: string, action: string) {
    super(`Cannot ${action} a Rocket payment in state ${fromState}`);
    this.name = 'InvalidTransitionError';
  }
}

const ACTION_TARGET: Record<CheckoutAction, RocketState> = {
  success: 'success',
  fail: 'failed',
  cancel: 'cancelled',
};

export function applyCheckoutAction(from: RocketState, action: CheckoutAction): RocketState {
  if (from !== 'checkout') throw new InvalidTransitionError(from, action);
  return ACTION_TARGET[action];
}

export function isTerminal(state: RocketState): boolean {
  return state !== 'initiated' && state !== 'checkout';
}

export function callbackKindFor(action: CheckoutAction): CallbackKind {
  if (action === 'success') return 'success';
  if (action === 'fail') return 'fail';
  return 'cancel';
}

/**
 * getresult / getresultrocket strings. Success and the TIMEOUT/CANCELLED
 * pair follow banglapay's dbbl_lib.php samples; the FAILED code (116) and
 * the PENDING line are simulator-invented (no public source shows them).
 */
export function resultStringFor(state: RocketState): string {
  switch (state) {
    case 'success':
      return 'RESULT: OK\nRESULT_PS: FINISHED\nRESULT_CODE: 000';
    case 'failed':
      return 'RESULT: FAILED\nRESULT_PS: FINISHED\nRESULT_CODE: 116';
    case 'cancelled':
    case 'expired':
      return 'RESULT: TIMEOUT\nRESULT_PS: CANCELLED';
    default:
      return 'RESULT: PENDING\nRESULT_PS: PENDING';
  }
}
