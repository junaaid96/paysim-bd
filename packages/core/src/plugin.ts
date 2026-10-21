// Gateway plugin contract. Plugins (packages/gateways/*) implement
// GatewayPlugin; apps/api hosts them via PluginContext. Plugins never touch
// Drizzle directly — all persistence goes through PluginStores (ORM-agnostic,
// trivially faked in plugin unit tests). Dates cross the boundary as ISO
// strings so records stay JSON-safe.

import { z } from 'zod';

import type { Clock } from './clock.js';
import type { ScenarioDefinition, ScenarioDefinitionInput } from './scenario.js';

// ---------------------------------------------------------------------------
// Fidelity manifest (spec/vN.json, validated at load)
// ---------------------------------------------------------------------------

export const FidelitySchema = z.enum(['verified', 'docs-only', 'unverified']);
export type Fidelity = z.infer<typeof FidelitySchema>;

export const SpecEndpointSchema = z.object({
  method: z.string().min(1),
  path: z.string().min(1),
  purpose: z.string().min(1),
  implemented: z.boolean(),
  fidelity: FidelitySchema,
  sources: z.array(z.string().min(1)),
  notes: z.string().optional(),
});
export type SpecEndpoint = z.infer<typeof SpecEndpointSchema>;

export const SpecFieldSchema = z.object({
  endpoint: z.string().min(1),
  name: z.string().min(1),
  location: z.enum(['request', 'response', 'callback', 'ipn']),
  required: z.boolean().optional(),
  fidelity: FidelitySchema,
  sources: z.array(z.string().min(1)),
  notes: z.string().optional(),
});
export type SpecField = z.infer<typeof SpecFieldSchema>;

export const HashRuleSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  fidelity: FidelitySchema,
  sources: z.array(z.string().min(1)),
  steps: z.array(z.string().min(1)),
});
export type HashRule = z.infer<typeof HashRuleSchema>;

export const GatewaySpecSchema = z.object({
  gateway: z.string().min(1),
  displayName: z.string().min(1),
  version: z.string().min(1),
  /**
   * Badge level: "verified" only when the Phase 5 parity suite passes;
   * "docs-only" when grounded in official docs but not replay-verified;
   * "unverified" when no official docs exist (community sources at best).
   */
  fidelity: FidelitySchema,
  docSources: z.array(z.string().min(1)),
  sandboxHosts: z.array(z.string().min(1)),
  productionHosts: z.array(z.string().min(1)),
  contentTypes: z.array(z.string().min(1)),
  endpoints: z.array(SpecEndpointSchema),
  fields: z.array(SpecFieldSchema),
  hashRules: z.array(HashRuleSchema),
  notes: z.array(z.string()).optional(),
});
export type GatewaySpec = z.infer<typeof GatewaySpecSchema>;

// ---------------------------------------------------------------------------
// Records (JSON-safe shapes shared by plugins and the API host)
// ---------------------------------------------------------------------------

export const AppRecordSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  workspaceKey: z.string(),
  gateway: z.string(),
  name: z.string(),
  credentials: z.record(z.string(), z.unknown()),
  defaultScenarioId: z.string().nullable(),
});
export type AppRecord = z.infer<typeof AppRecordSchema>;

export const TxnRecordSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  workspaceKey: z.string(),
  gatewayAppId: z.string(),
  gateway: z.string(),
  state: z.string(),
  gatewayTxnId: z.string().nullable(),
  gatewaySessionKey: z.string().nullable(),
  amountMinor: z.number(),
  currency: z.string(),
  customer: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()),
  scenarioOverrideId: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TxnRecord = z.infer<typeof TxnRecordSchema>;

export const EventRecordSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  workspaceKey: z.string(),
  transactionId: z.string(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type EventRecord = z.infer<typeof EventRecordSchema>;

export const DeliveryRecordSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  workspaceKey: z.string(),
  transactionId: z.string(),
  kind: z.string(),
  targetUrl: z.string(),
  attemptNo: z.number(),
  status: z.string(),
  latencyMs: z.number().nullable(),
  requestBody: z.string().nullable(),
  requestBodyKey: z.string().nullable(),
  responseStatus: z.number().nullable(),
  responseSnippet: z.string().nullable(),
  responseBodyKey: z.string().nullable(),
  scheduledFor: z.string(),
  sentAt: z.string().nullable(),
  createdAt: z.string(),
});
export type DeliveryRecord = z.infer<typeof DeliveryRecordSchema>;

// ---------------------------------------------------------------------------
// Stores (implemented by apps/api, faked in plugin tests)
// ---------------------------------------------------------------------------

export interface CreateTxnInput {
  workspaceId: string;
  gatewayAppId: string;
  gateway: string;
  state: string;
  gatewayTxnId?: string;
  gatewaySessionKey?: string;
  amountMinor: number;
  currency: string;
  customer?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  expiresAt?: Date;
}

export interface RecordEventInput {
  workspaceId: string;
  transactionId: string;
  type: string;
  data?: Record<string, unknown>;
}

export interface RecordDeliveryInput {
  workspaceId: string;
  transactionId: string;
  kind: string;
  targetUrl: string;
  /** attemptNo is assigned by the store (per-transaction sequence). */
  status: string;
  latencyMs?: number;
  requestBody?: string;
  responseStatus?: number;
  responseSnippet?: string;
  responseBody?: string;
  scheduledFor?: Date;
  sentAt?: Date;
}

/**
 * Small shared key/value store for plugin state that must survive across
 * processes (serverless instances), e.g. issued gateway auth tokens.
 * Entries past `expiresAt` are treated as absent.
 */
export interface KeyValueStore {
  get(namespace: string, key: string): Promise<Record<string, unknown> | null>;
  set(
    namespace: string,
    key: string,
    value: Record<string, unknown>,
    expiresAt: Date,
  ): Promise<void>;
  delete(namespace: string, key: string): Promise<void>;
}

export interface PluginStores {
  /** Cross-instance key/value state. Optional: plugins fall back to memory. */
  kv?: KeyValueStore;
  findAppByStoreId(gateway: string, field: string, value: string): Promise<AppRecord | null>;
  getApp(id: string): Promise<AppRecord | null>;
  createTransaction(input: CreateTxnInput): Promise<TxnRecord>;
  getTransaction(id: string): Promise<TxnRecord | null>;
  findTransactionBySession(gateway: string, sessionKey: string): Promise<TxnRecord | null>;
  /**
   * Merchant references (SSLCommerz tran_id, Nagad orderId) are unique per
   * gateway app, like the real gateways; pass gatewayAppId to scope the lookup.
   */
  findTransactionByGatewayTxnId(
    gateway: string,
    gatewayTxnId: string,
    gatewayAppId?: string,
  ): Promise<TxnRecord | null>;
  /** Lookup by a metadata key (e.g. val_id, paymentId) for verify/query APIs. */
  findTransactionByMetadata(gateway: string, key: string, value: string): Promise<TxnRecord | null>;
  /** Updates state (+ optional metadata patch) and writes a state event. */
  transitionTransaction(
    id: string,
    toState: string,
    eventType: string,
    eventData?: Record<string, unknown>,
    metadataPatch?: Record<string, unknown>,
  ): Promise<TxnRecord>;
  recordEvent(input: RecordEventInput): Promise<EventRecord>;
  recordDelivery(input: RecordDeliveryInput): Promise<DeliveryRecord>;
  listDeliveries(transactionId: string): Promise<DeliveryRecord[]>;
  /** Update the amount (+ optional metadata patch). No event; caller records one. */
  setTransactionAmount(
    id: string,
    amountMinor: number,
    metadataPatch?: Record<string, unknown>,
  ): Promise<TxnRecord>;
}

// ---------------------------------------------------------------------------
// Plugin context and descriptor
// ---------------------------------------------------------------------------

/** Minimal logger surface; the API adapts pino to this. */
export interface PluginLogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface DeliverCallbackInput {
  txn: TxnRecord;
  kind: string;
  targetUrl: string;
  /** Form fields to POST (all gateways here use form-encoded callbacks). */
  payload: Record<string, string>;
}

export interface PluginContext {
  stores: PluginStores;
  logger: PluginLogger;
  clock: Clock;
  /** Public base URL of this simulator (for building GatewayPageURL etc). */
  simBaseUrl: string;
  /** POST the payload now (failures schedule retries via the scheduler). */
  deliverCallback(input: DeliverCallbackInput): Promise<DeliveryRecord>;
  engine: ScenarioEngine;
}

export type ScenarioSource = 'magic' | 'default' | 'manual' | 'override' | 'inline';

export interface ResolvedScenario {
  scenarioId: string | null;
  definition: ScenarioDefinition;
  source: ScenarioSource;
}

export interface AttachScenarioInput {
  txn: TxnRecord;
  scenarioId: string | null;
  definition: ScenarioDefinition;
  source: ScenarioSource;
}

/** Scenario attach/resolve, implemented by the API host. */
export interface ScenarioEngine {
  resolveForInit(input: {
    workspaceId: string;
    gateway: string;
    defaultScenarioId: string | null;
    magicName: string | null;
  }): Promise<ResolvedScenario>;
  attach(input: AttachScenarioInput): Promise<void>;
}

export type CredentialCheck =
  { ok: true; value: Record<string, unknown> } | { ok: false; issues: string[] };

export interface GatewayPlugin {
  name: string;
  displayName: string;
  /** URL prefixes owned by this plugin (for the gateway 404 guard). */
  prefixes: string[];
  spec: GatewaySpec;
  /** Validate + normalize fake sandbox credentials for a new app. */
  validateCredentials(input: unknown): CredentialCheck;
  /** Credential field used to route gateway requests to an app (e.g. store_id). */
  storeIdField: string;
  /** Obviously-fake credentials seeded for the local default app. */
  defaultCredentials: Record<string, unknown>;
  /** Built-in scenario definitions seeded as global presets. */
  builtinScenarios: ScenarioDefinitionInput[];
  /** True when no further gateway events can change this transaction. */
  isTerminalState(state: string): boolean;
  /**
   * Execute one scenario action against a live transaction. Must be
   * tolerant: unmet preconditions record a skipped step, never throw
   * (authoring errors in params may throw to fail the job loudly).
   */
  runScenarioAction(
    ctx: PluginContext,
    txn: TxnRecord,
    app: AppRecord,
    action: string,
    params: Record<string, unknown>,
  ): Promise<void>;
  /**
   * Build the plugin's express Router. Typed unknown here so core stays
   * express-free; the API host casts once at mount time.
   */
  createRouter(ctx: PluginContext): unknown;
}
