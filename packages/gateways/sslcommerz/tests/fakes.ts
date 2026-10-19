// In-memory PluginStores + context for plugin unit tests (no DB).

import {
  ScenarioDefinitionSchema,
  ScenarioNotFoundError,
  SystemClock,
  type AppRecord,
  type AttachScenarioInput,
  type CreateTxnInput,
  type DeliverCallbackInput,
  type DeliveryRecord,
  type EventRecord,
  type PluginContext,
  type PluginLogger,
  type PluginStores,
  type RecordDeliveryInput,
  type RecordEventInput,
  type ResolvedScenario,
  type ScenarioDefinition,
  type ScenarioEngine,
  type TxnRecord,
} from '@paysim/core';

import { BUILTIN_SCENARIOS } from '../src/scenarios.js';

let sequence = 0;
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}
function nowIso(): string {
  return new Date().toISOString();
}

const silentLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export class FakeStores implements PluginStores {
  apps: AppRecord[] = [];
  txns: TxnRecord[] = [];
  events: EventRecord[] = [];
  deliveries: DeliveryRecord[] = [];
  /** Named scenarios addressable as app defaults (id -> definition). */
  namedScenarios = new Map<string, ScenarioDefinition>();

  seedScenario(id: string, definition: ScenarioDefinition): void {
    this.namedScenarios.set(id, definition);
  }

  seedApp(overrides: Partial<AppRecord> = {}): AppRecord {
    const app: AppRecord = {
      id: nextId('app'),
      workspaceId: 'ws-1',
      workspaceKey: 'local-default',
      gateway: 'sslcommerz',
      name: 'Test store',
      credentials: { store_id: 'testbox', store_passwd: 'qwerty' },
      defaultScenarioId: null,
      ...overrides,
    };
    this.apps.push(app);
    return app;
  }

  async findAppByStoreId(gateway: string, field: string, value: string): Promise<AppRecord | null> {
    return (
      this.apps.find((app) => app.gateway === gateway && app.credentials[field] === value) ?? null
    );
  }

  async getApp(id: string): Promise<AppRecord | null> {
    return this.apps.find((app) => app.id === id) ?? null;
  }

  async createTransaction(input: CreateTxnInput): Promise<TxnRecord> {
    const txn: TxnRecord = {
      id: nextId('txn'),
      workspaceId: input.workspaceId,
      workspaceKey: 'local-default',
      gatewayAppId: input.gatewayAppId,
      gateway: input.gateway,
      state: input.state,
      gatewayTxnId: input.gatewayTxnId ?? null,
      gatewaySessionKey: input.gatewaySessionKey ?? null,
      amountMinor: input.amountMinor,
      currency: input.currency,
      customer: input.customer ?? {},
      metadata: input.metadata ?? {},
      scenarioOverrideId: null,
      idempotencyKey: input.idempotencyKey ?? null,
      expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.txns.push(txn);
    await this.recordEvent({
      workspaceId: txn.workspaceId,
      transactionId: txn.id,
      type: 'transaction.created',
      data: { state: txn.state },
    });
    return txn;
  }

  async getTransaction(id: string): Promise<TxnRecord | null> {
    return this.txns.find((txn) => txn.id === id) ?? null;
  }

  async findTransactionBySession(gateway: string, sessionKey: string): Promise<TxnRecord | null> {
    return (
      this.txns.find((txn) => txn.gateway === gateway && txn.gatewaySessionKey === sessionKey) ??
      null
    );
  }

  async findTransactionByGatewayTxnId(
    gateway: string,
    gatewayTxnId: string,
  ): Promise<TxnRecord | null> {
    return (
      this.txns.find((txn) => txn.gateway === gateway && txn.gatewayTxnId === gatewayTxnId) ?? null
    );
  }

  async findTransactionByMetadata(
    gateway: string,
    key: string,
    value: string,
  ): Promise<TxnRecord | null> {
    return this.txns.find((txn) => txn.gateway === gateway && txn.metadata[key] === value) ?? null;
  }

  async transitionTransaction(
    id: string,
    toState: string,
    eventType: string,
    eventData: Record<string, unknown> = {},
    metadataPatch: Record<string, unknown> = {},
  ): Promise<TxnRecord> {
    const txn = await this.getTransaction(id);
    if (!txn) throw new Error(`unknown transaction ${id}`);
    txn.state = toState;
    txn.metadata = { ...txn.metadata, ...metadataPatch };
    txn.updatedAt = nowIso();
    await this.recordEvent({
      workspaceId: txn.workspaceId,
      transactionId: id,
      type: eventType,
      data: eventData,
    });
    return txn;
  }

  async recordEvent(input: RecordEventInput): Promise<EventRecord> {
    const event: EventRecord = {
      id: nextId('evt'),
      workspaceId: input.workspaceId,
      workspaceKey: 'local-default',
      transactionId: input.transactionId,
      type: input.type,
      data: input.data ?? {},
      createdAt: nowIso(),
    };
    this.events.push(event);
    return event;
  }

  async listDeliveries(transactionId: string): Promise<DeliveryRecord[]> {
    return this.deliveries.filter((delivery) => delivery.transactionId === transactionId);
  }

  async setTransactionAmount(
    id: string,
    amountMinor: number,
    metadataPatch: Record<string, unknown> = {},
  ): Promise<TxnRecord> {
    const txn = await this.getTransaction(id);
    if (!txn) throw new Error(`unknown transaction ${id}`);
    txn.amountMinor = amountMinor;
    txn.metadata = { ...txn.metadata, ...metadataPatch };
    txn.updatedAt = nowIso();
    return txn;
  }

  async recordDelivery(input: RecordDeliveryInput): Promise<DeliveryRecord> {
    const attemptNo =
      this.deliveries.filter((delivery) => delivery.transactionId === input.transactionId).length +
      1;
    const delivery: DeliveryRecord = {
      id: nextId('dlv'),
      workspaceId: input.workspaceId,
      workspaceKey: 'local-default',
      transactionId: input.transactionId,
      kind: input.kind,
      targetUrl: input.targetUrl,
      attemptNo,
      status: input.status,
      latencyMs: input.latencyMs ?? null,
      requestBody: input.requestBody ?? null,
      requestBodyKey: null,
      responseStatus: input.responseStatus ?? null,
      responseSnippet: input.responseSnippet ?? null,
      responseBodyKey: null,
      scheduledFor: (input.scheduledFor ?? new Date()).toISOString(),
      sentAt: input.sentAt ? input.sentAt.toISOString() : null,
      createdAt: nowIso(),
    };
    this.deliveries.push(delivery);
    return delivery;
  }
}

export interface FakeContext {
  ctx: PluginContext;
  stores: FakeStores;
  delivered: DeliverCallbackInput[];
  attached: AttachScenarioInput[];
}

class FakeEngine implements ScenarioEngine {
  constructor(
    private readonly stores: FakeStores,
    private readonly attached: AttachScenarioInput[],
  ) {}

  async resolveForInit(input: {
    workspaceId: string;
    gateway: string;
    defaultScenarioId: string | null;
    magicName: string | null;
  }): Promise<ResolvedScenario> {
    void input.workspaceId;
    void input.gateway;
    if (input.magicName) {
      const builtin = BUILTIN_SCENARIOS.find((candidate) => candidate.name === input.magicName);
      if (!builtin) throw new ScenarioNotFoundError(input.magicName);
      return {
        scenarioId: null,
        definition: ScenarioDefinitionSchema.parse(builtin),
        source: 'magic',
      };
    }
    if (input.defaultScenarioId) {
      const definition = this.stores.namedScenarios.get(input.defaultScenarioId);
      if (!definition) throw new ScenarioNotFoundError(input.defaultScenarioId);
      return { scenarioId: input.defaultScenarioId, definition, source: 'default' };
    }
    return {
      scenarioId: null,
      definition: ScenarioDefinitionSchema.parse({ name: 'manual', steps: [] }),
      source: 'manual',
    };
  }

  async attach(input: AttachScenarioInput): Promise<void> {
    this.attached.push(input);
  }
}

export function makeCtx(): FakeContext {
  const stores = new FakeStores();
  const delivered: DeliverCallbackInput[] = [];
  const attached: AttachScenarioInput[] = [];
  const ctx: PluginContext = {
    stores,
    logger: silentLogger,
    clock: new SystemClock(),
    simBaseUrl: 'http://sim.test',
    deliverCallback: async (input: DeliverCallbackInput) => {
      delivered.push(input);
      return stores.recordDelivery({
        workspaceId: input.txn.workspaceId,
        transactionId: input.txn.id,
        kind: input.kind,
        targetUrl: input.targetUrl,
        status: 'delivered',
        latencyMs: 1,
        requestBody: new URLSearchParams(input.payload).toString(),
        responseStatus: 200,
        responseSnippet: 'ok',
        sentAt: new Date(),
      });
    },
    engine: new FakeEngine(stores, attached),
  };
  return { ctx, stores, delivered, attached };
}
