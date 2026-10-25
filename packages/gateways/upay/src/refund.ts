// Upay refunds: POST /payment/bulk/refund/ (see routes.ts / real.ts for
// sources). Only completed payments are refundable. Partial amounts are
// accepted by the simulator; upstream support for partial refund_amount is
// unconfirmed (BDPayGate only sends full refunds).
export const REFUNDABLE_STATES = ['success'] as const;
