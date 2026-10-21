// Drizzle implementation of PluginStores plus dashboard read queries.
// Every write publishes to the SSE bus so the dashboard updates live.

import { and, desc, eq, lt, sql } from 'drizzle-orm';

import {
  MAX_RESPONSE_SNIPPET_BYTES,
  redactValue,
  truncateUtf8,
  type AppRecord,
  type CreateTxnInput,
  type DeliveryRecord,
  type EventRecord,
  type KeyValueStore,
  type PluginStores,
  type RecordDeliveryInput,
  type RecordEventInput,
  type TxnRecord,
} from '@paysim/core';

import { storeBody } from '../body-store.js';
import type { Db } from '../db/client.js';
import {
  callbackDeliveries,
  events,
  gatewayApps,
  kvEntries,
  transactions,
  workspaces,
  type CallbackDelivery,
  type Event,
  type GatewayApp,
  type Transaction,
} from '../db/schema.js';
import type { EventBus } from '../events/bus.js';
import type { StorageAdapter } from '../storage/index.js';

export interface DrizzleStoresDeps {
  db: Db;
  bus: EventBus;
  storage: StorageAdapter;
}

type NewTxn = typeof transactions.$inferInsert;

function toApp(row: GatewayApp, workspaceKey: string): AppRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workspaceKey,
    gateway: row.gateway,
    name: row.name,
    credentials: row.credentials,
    defaultScenarioId: row.defaultScenarioId,
  };
}

function toTxn(row: Transaction, workspaceKey: string): TxnRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workspaceKey,
    gatewayAppId: row.gatewayAppId,
    gateway: row.gateway,
    state: row.state,
    gatewayTxnId: row.gatewayTxnId,
    gatewaySessionKey: row.gatewaySessionKey,
    amountMinor: row.amountMinor,
    currency: row.currency,
    customer: row.customer,
    metadata: row.metadata,
    scenarioOverrideId: row.scenarioOverrideId,
    idempotencyKey: row.idempotencyKey,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toEvent(row: Event, workspaceKey: string): EventRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workspaceKey,
    transactionId: row.transactionId,
    type: row.type,
    data: row.data,
    createdAt: row.createdAt.toISOString(),
  };
}

function toDelivery(row: CallbackDelivery, workspaceKey: string): DeliveryRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workspaceKey,
    transactionId: row.transactionId,
    kind: row.kind,
    targetUrl: row.targetUrl,
    attemptNo: row.attemptNo,
    status: row.status,
    latencyMs: row.latencyMs,
    requestBody: row.requestBody,
    requestBodyKey: row.requestBodyKey,
    responseStatus: row.responseStatus,
    responseSnippet: row.responseSnippet,
    responseBodyKey: row.responseBodyKey,
    scheduledFor: row.scheduledFor.toISOString(),
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createDrizzleStores(deps: DrizzleStoresDeps): PluginStores {
  const { db, bus, storage } = deps;
  const workspaceKeys = new Map<string, string>();

  async function workspaceKey(workspaceId: string): Promise<string> {
    const cached = workspaceKeys.get(workspaceId);
    if (cached) return cached;
    const rows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    const key = rows[0]?.key ?? 'unknown';
    workspaceKeys.set(workspaceId, key);
    return key;
  }

  /** Bodies >16 KB spill to object storage; smaller ones stay inline. */
  async function splitBody(
    prefix: string,
    body: string | undefined,
    contentType: string,
  ): Promise<{ inline: string | null; key: string | null }> {
    if (body === undefined) return { inline: null, key: null };
    const stored = await storeBody(storage, prefix, body, contentType);
    if (stored.inline !== null) return { inline: stored.inline, key: null };
    return { inline: truncateUtf8(body, MAX_RESPONSE_SNIPPET_BYTES), key: stored.key };
  }

  /**
   * Event payloads >16 KB (e.g. a huge inbound init body) spill to object
   * storage like callback bodies; the row keeps a redacted preview + key.
   */
  async function eventData(input: RecordEventInput): Promise<Record<string, unknown>> {
    const data = input.data ?? {};
    const stored = await storeBody(storage, 'event-bodies', data);
    if (stored.inline !== null) return data;
    return {
      spilled: true,
      bodyKey: stored.key,
      sizeBytes: stored.sizeBytes,
      preview: truncateUtf8(JSON.stringify(redactValue(data)), MAX_RESPONSE_SNIPPET_BYTES),
    };
  }

  const kv: KeyValueStore = {
    async get(namespace, key) {
      const rows = await db
        .select()
        .from(kvEntries)
        .where(and(eq(kvEntries.namespace, namespace), eq(kvEntries.key, key)))
        .limit(1);
      const row = rows[0];
      if (!row || row.expiresAt.getTime() <= Date.now()) return null;
      return row.value;
    },
    async set(namespace, key, value, expiresAt) {
      await db
        .insert(kvEntries)
        .values({ namespace, key, value, expiresAt })
        .onConflictDoUpdate({
          target: [kvEntries.namespace, kvEntries.key],
          set: { value, expiresAt },
        });
      // Opportunistic pruning keeps the table small without a cron.
      await db.delete(kvEntries).where(lt(kvEntries.expiresAt, new Date()));
    },
    async delete(namespace, key) {
      await db
        .delete(kvEntries)
        .where(and(eq(kvEntries.namespace, namespace), eq(kvEntries.key, key)));
    },
  };

  async function insertEvent(input: RecordEventInput): Promise<EventRecord> {
    const rows = await db
      .insert(events)
      .values({
        workspaceId: input.workspaceId,
        transactionId: input.transactionId,
        type: input.type,
        data: await eventData(input),
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Failed to insert event');
    const key = await workspaceKey(input.workspaceId);
    const record = toEvent(row, key);
    bus.publish({ type: 'event.created', workspaceKey: key, data: { event: record } });
    return record;
  }

  return {
    kv,

    async findAppByStoreId(gateway: string, field: string, value: string) {
      const rows = await db.select().from(gatewayApps).where(eq(gatewayApps.gateway, gateway));
      const row = rows.find((candidate) => candidate.credentials[field] === value);
      return row ? toApp(row, await workspaceKey(row.workspaceId)) : null;
    },

    async getApp(id: string) {
      const rows = await db.select().from(gatewayApps).where(eq(gatewayApps.id, id)).limit(1);
      const row = rows[0];
      return row ? toApp(row, await workspaceKey(row.workspaceId)) : null;
    },

    async createTransaction(input: CreateTxnInput) {
      const values: NewTxn = {
        workspaceId: input.workspaceId,
        gatewayAppId: input.gatewayAppId,
        gateway: input.gateway,
        state: input.state,
        gatewayTxnId: input.gatewayTxnId ?? null,
        gatewaySessionKey: input.gatewaySessionKey ?? null,
        amountMinor: input.amountMinor,
        currency: input.currency,
        customer: input.customer ?? {},
        metadata: input.metadata ?? {},
        idempotencyKey: input.idempotencyKey ?? null,
        expiresAt: input.expiresAt ?? null,
      };
      const rows = await db.insert(transactions).values(values).returning();
      const row = rows[0];
      if (!row) throw new Error('Failed to insert transaction');
      const key = await workspaceKey(input.workspaceId);
      await insertEvent({
        workspaceId: input.workspaceId,
        transactionId: row.id,
        type: 'transaction.created',
        data: { state: row.state, gateway: row.gateway },
      });
      const record = toTxn(row, key);
      bus.publish({ type: 'txn.created', workspaceKey: key, data: { txn: record } });
      return record;
    },

    async getTransaction(id: string) {
      const rows = await db.select().from(transactions).where(eq(transactions.id, id)).limit(1);
      const row = rows[0];
      return row ? toTxn(row, await workspaceKey(row.workspaceId)) : null;
    },

    async findTransactionBySession(gateway: string, sessionKey: string) {
      const rows = await db
        .select()
        .from(transactions)
        .where(
          and(eq(transactions.gateway, gateway), eq(transactions.gatewaySessionKey, sessionKey)),
        )
        .limit(1);
      const row = rows[0];
      return row ? toTxn(row, await workspaceKey(row.workspaceId)) : null;
    },

    async findTransactionByGatewayTxnId(gateway: string, gatewayTxnId: string) {
      const rows = await db
        .select()
        .from(transactions)
        .where(and(eq(transactions.gateway, gateway), eq(transactions.gatewayTxnId, gatewayTxnId)))
        .limit(1);
      const row = rows[0];
      return row ? toTxn(row, await workspaceKey(row.workspaceId)) : null;
    },

    async findTransactionByMetadata(gateway: string, key: string, value: string) {
      const rows = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.gateway, gateway),
            sql`${transactions.metadata} ->> ${key} = ${value}`,
          ),
        )
        .limit(1);
      const row = rows[0];
      return row ? toTxn(row, await workspaceKey(row.workspaceId)) : null;
    },

    async transitionTransaction(id, toState, eventType, eventData = {}, metadataPatch = {}) {
      const current = await db.select().from(transactions).where(eq(transactions.id, id)).limit(1);
      const row = current[0];
      if (!row) throw new Error(`Unknown transaction ${id}`);
      const updated = await db
        .update(transactions)
        .set({ state: toState, metadata: { ...row.metadata, ...metadataPatch } })
        .where(eq(transactions.id, id))
        .returning();
      const next = updated[0];
      if (!next) throw new Error(`Failed to update transaction ${id}`);
      await insertEvent({
        workspaceId: next.workspaceId,
        transactionId: id,
        type: eventType,
        data: { fromState: row.state, toState, ...eventData },
      });
      const key = await workspaceKey(next.workspaceId);
      const record = toTxn(next, key);
      bus.publish({ type: 'txn.updated', workspaceKey: key, data: { txn: record } });
      return record;
    },

    recordEvent: insertEvent,

    async listDeliveries(transactionId: string) {
      const rows = await db
        .select()
        .from(callbackDeliveries)
        .where(eq(callbackDeliveries.transactionId, transactionId))
        .orderBy(callbackDeliveries.attemptNo);
      if (rows.length === 0) return [];
      const key = await workspaceKey(rows[0]?.workspaceId ?? '');
      return rows.map((row) => toDelivery(row, key));
    },

    async setTransactionAmount(id: string, amountMinor: number, metadataPatch = {}) {
      const current = await db.select().from(transactions).where(eq(transactions.id, id)).limit(1);
      const row = current[0];
      if (!row) throw new Error(`Unknown transaction ${id}`);
      const updated = await db
        .update(transactions)
        .set({ amountMinor, metadata: { ...row.metadata, ...metadataPatch } })
        .where(eq(transactions.id, id))
        .returning();
      const next = updated[0];
      if (!next) throw new Error(`Failed to update transaction ${id}`);
      const key = await workspaceKey(next.workspaceId);
      const record = toTxn(next, key);
      bus.publish({ type: 'txn.updated', workspaceKey: key, data: { txn: record } });
      return record;
    },

    async recordDelivery(input: RecordDeliveryInput) {
      const request = await splitBody(
        'callback-requests',
        input.requestBody,
        'application/x-www-form-urlencoded',
      );
      const responseKey =
        input.responseBody !== undefined
          ? (await storeBody(storage, 'callback-responses', input.responseBody, 'text/plain')).key
          : null;
      // attemptNo is a per-transaction sequence assigned by the store so
      // concurrent schedulers and replays cannot collide on numbering.
      const prior = await db
        .select({ attemptNo: callbackDeliveries.attemptNo })
        .from(callbackDeliveries)
        .where(eq(callbackDeliveries.transactionId, input.transactionId))
        .orderBy(desc(callbackDeliveries.attemptNo))
        .limit(1);
      const rows = await db
        .insert(callbackDeliveries)
        .values({
          workspaceId: input.workspaceId,
          transactionId: input.transactionId,
          kind: input.kind,
          targetUrl: input.targetUrl,
          attemptNo: (prior[0]?.attemptNo ?? 0) + 1,
          status: input.status,
          latencyMs: input.latencyMs ?? null,
          requestBody: request.inline,
          requestBodyKey: request.key,
          responseStatus: input.responseStatus ?? null,
          responseSnippet:
            input.responseSnippet ??
            (input.responseBody !== undefined
              ? truncateUtf8(input.responseBody, MAX_RESPONSE_SNIPPET_BYTES)
              : null),
          responseBodyKey: responseKey,
          scheduledFor: input.scheduledFor ?? new Date(),
          sentAt: input.sentAt ?? null,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('Failed to insert callback delivery');
      const key = await workspaceKey(input.workspaceId);
      const record = toDelivery(row, key);
      bus.publish({ type: 'delivery.created', workspaceKey: key, data: { delivery: record } });
      return record;
    },
  };
}

// ---------------------------------------------------------------------------
// Dashboard read queries + app management (routes only, not plugins)
// ---------------------------------------------------------------------------

export interface CreateAppInput {
  workspaceId: string;
  gateway: string;
  name: string;
  credentials: Record<string, unknown>;
}

export interface ListTxnsFilter {
  workspaceKey: string;
  gateway?: string;
  state?: string;
  limit?: number;
}

export interface TxnDetail {
  txn: TxnRecord;
  events: EventRecord[];
  deliveries: DeliveryRecord[];
}

export function createQueries(db: Db) {
  async function workspaceIdForKey(workspaceKey: string): Promise<string | null> {
    const rows = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.key, workspaceKey))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  return {
    async getWorkspaceByKey(workspaceKey: string) {
      const rows = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.key, workspaceKey))
        .limit(1);
      const row = rows[0];
      return row ? { id: row.id, key: row.key, name: row.name } : null;
    },

    async createApp(input: CreateAppInput): Promise<AppRecord> {
      const rows = await db
        .insert(gatewayApps)
        .values({
          workspaceId: input.workspaceId,
          gateway: input.gateway,
          name: input.name,
          credentials: input.credentials,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('Failed to insert gateway app');
      const ws = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, input.workspaceId))
        .limit(1);
      return toApp(row, ws[0]?.key ?? 'unknown');
    },

    async listApps(workspaceKey: string): Promise<AppRecord[]> {
      const workspaceId = await workspaceIdForKey(workspaceKey);
      if (!workspaceId) return [];
      const rows = await db
        .select()
        .from(gatewayApps)
        .where(eq(gatewayApps.workspaceId, workspaceId));
      return rows.map((row) => toApp(row, workspaceKey));
    },

    async updateAppDefaultScenario(
      workspaceKey: string,
      id: string,
      defaultScenarioId: string | null,
    ): Promise<AppRecord | null> {
      const rows = await db
        .update(gatewayApps)
        .set({ defaultScenarioId })
        .where(eq(gatewayApps.id, id))
        .returning();
      const row = rows[0];
      return row ? toApp(row, workspaceKey) : null;
    },

    async listTransactions(filter: ListTxnsFilter): Promise<TxnRecord[]> {
      const workspaceId = await workspaceIdForKey(filter.workspaceKey);
      if (!workspaceId) return [];
      const conditions = [eq(transactions.workspaceId, workspaceId)];
      if (filter.gateway) conditions.push(eq(transactions.gateway, filter.gateway));
      if (filter.state) conditions.push(eq(transactions.state, filter.state));
      const rows = await db
        .select()
        .from(transactions)
        .where(and(...conditions))
        .orderBy(desc(transactions.createdAt))
        .limit(Math.min(filter.limit ?? 50, 200));
      return rows.map((row) => toTxn(row, filter.workspaceKey));
    },

    async getTransactionDetail(id: string): Promise<TxnDetail | null> {
      const txnRows = await db.select().from(transactions).where(eq(transactions.id, id)).limit(1);
      const txnRow = txnRows[0];
      if (!txnRow) return null;
      const ws = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, txnRow.workspaceId))
        .limit(1);
      const key = ws[0]?.key ?? 'unknown';
      const eventRows = await db
        .select()
        .from(events)
        .where(eq(events.transactionId, id))
        .orderBy(events.createdAt);
      const deliveryRows = await db
        .select()
        .from(callbackDeliveries)
        .where(eq(callbackDeliveries.transactionId, id))
        .orderBy(callbackDeliveries.createdAt);
      return {
        txn: toTxn(txnRow, key),
        events: eventRows.map((row) => toEvent(row, key)),
        deliveries: deliveryRows.map((row) => toDelivery(row, key)),
      };
    },
  };
}

export type Queries = ReturnType<typeof createQueries>;
