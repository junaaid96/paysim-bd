// Shared domain constants. This package is runtime-agnostic (no node:*
// imports): it must stay importable from the API, the web app and tests.

/** Bodies larger than this are stored in object storage, not in Postgres. */
export const MAX_INLINE_BODY_BYTES = 16 * 1024;

/** Max bytes kept inline for a callback response preview. */
export const MAX_RESPONSE_SNIPPET_BYTES = 2 * 1024;

/** Default settlement currency. Amounts are stored in minor units. */
export const DEFAULT_CURRENCY = 'BDT';

/** Gateways the simulator will support, in build order. */
export const SUPPORTED_GATEWAYS = ['sslcommerz', 'bkash', 'nagad'] as const;
export type SupportedGateway = (typeof SUPPORTED_GATEWAYS)[number];

/** Key of the single workspace auto-created in local mode. */
export const DEFAULT_WORKSPACE_KEY = 'local-default';

/** Placeholder substituted for redacted secrets. */
export const REDACTED = '[REDACTED]';
