// SSLCommerz transaction state machine (pure transitions, no I/O).

export const TXN_STATES = ['initiated', 'valid', 'failed', 'cancelled', 'expired'] as const;
export type SslcommerzState = (typeof TXN_STATES)[number];

export const CHECKOUT_ACTIONS = ['success', 'fail', 'cancel'] as const;
export type CheckoutAction = (typeof CHECKOUT_ACTIONS)[number];

export type IpnStatus = 'VALID' | 'FAILED' | 'CANCELLED';

export class InvalidTransitionError extends Error {
  constructor(
    public readonly fromState: string,
    public readonly action: string,
  ) {
    super(`Cannot apply ${action} to a transaction in state ${fromState}`);
    this.name = 'InvalidTransitionError';
  }
}

const ACTION_TARGET: Record<CheckoutAction, SslcommerzState> = {
  success: 'valid',
  fail: 'failed',
  cancel: 'cancelled',
};

/** Checkout buttons only work on initiated transactions (single outcome). */
export function applyCheckoutAction(
  state: SslcommerzState,
  action: CheckoutAction,
): SslcommerzState {
  if (state !== 'initiated') {
    throw new InvalidTransitionError(state, action);
  }
  return ACTION_TARGET[action];
}

export function ipnStatusFor(state: SslcommerzState): IpnStatus {
  switch (state) {
    case 'valid':
      return 'VALID';
    case 'failed':
      return 'FAILED';
    case 'cancelled':
      return 'CANCELLED';
    default:
      throw new InvalidTransitionError(state, 'ipn');
  }
}

export function isTerminal(state: SslcommerzState): boolean {
  return state !== 'initiated';
}
