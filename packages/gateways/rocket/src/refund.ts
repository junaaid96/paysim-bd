// Rocket refunds. DBBL's e-commerce web service (WSDL above) exposes no
// refund operation, so refunds are ledger-only in the simulator (dashboard
// full or partial) and must be done in the DBBL merchant panel in real mode.
export const REFUNDABLE_STATES = ['success'] as const;
