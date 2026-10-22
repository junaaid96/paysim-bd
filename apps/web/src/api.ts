import { z } from 'zod';

import type { SealedLiveQuery } from '@neon/realtime/client';
import type { ActivityRow } from '@paysim/core';
import {
  AppRecordSchema,
  DeliveryRecordSchema,
  EventRecordSchema,
  GatewaySpecSchema,
  ScenarioDefinitionSchema,
  TxnRecordSchema,
  type DeliveryRecord,
  type GatewaySpec,
  type TxnRecord,
} from '@paysim/core';

// Mirrors the API's HealthResponseSchema; API responses are validated at the
// boundary instead of trusted.
export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  now: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const TxnDetailSchema = z.object({
  txn: TxnRecordSchema,
  events: z.array(EventRecordSchema),
  deliveries: z.array(DeliveryRecordSchema),
});
export type TxnDetail = z.infer<typeof TxnDetailSchema>;

export const ScenarioRowSchema = z.object({
  id: z.string(),
  workspaceId: z.string().nullable(),
  gateway: z.string(),
  name: z.string(),
  definition: ScenarioDefinitionSchema,
  global: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ScenarioRow = z.infer<typeof ScenarioRowSchema>;

export const ClockStateSchema = z.object({
  workspaceKey: z.string(),
  workspaceId: z.string(),
  offsetMs: z.number(),
  now: z.string(),
  jobsShifted: z.number().optional(),
});
export type ClockState = z.infer<typeof ClockStateSchema>;
/** Public app view: sandbox keys are never returned, only masked hints. */
export const PublicAppSchema = AppRecordSchema.omit({ sandbox: true }).extend({
  sandbox: z
    .object({
      mode: z.enum(['simulator', 'real']),
      configured: z.boolean(),
      hints: z.record(z.string(), z.string()),
    })
    .default({ mode: 'simulator', configured: false, hints: {} }),
});
export type AppRecord = z.infer<typeof PublicAppSchema>;

export const GatewayInfoSchema = z.object({
  gateway: z.string(),
  displayName: z.string(),
  version: z.string(),
  fidelity: z.string(),
  sandbox: z
    .object({
      status: z.enum(['available', 'requires_merchant']),
      note: z.string(),
      docsUrl: z.string(),
      fields: z.array(z.object({ name: z.string(), label: z.string(), secret: z.boolean() })),
      publicTestKeys: z.record(z.string(), z.string()).nullable(),
    })
    .nullable()
    .default(null),
});
export type GatewayInfo = z.infer<typeof GatewayInfoSchema>;

export async function fetchGateways(): Promise<GatewayInfo[]> {
  return z.array(GatewayInfoSchema).parse(await getJson('/api/specs'));
}

export async function updateAppSandbox(
  appId: string,
  input: { mode: 'simulator' | 'real'; keys?: Record<string, string>; clearKeys?: boolean },
): Promise<AppRecord> {
  return PublicAppSchema.parse(await sendJson('PUT', `/api/apps/${appId}/sandbox`, input));
}

export type {
  ActivityRow,
  DeliveryRecord,
  EventRecord,
  GatewaySpec,
  TxnRecord,
} from '@paysim/core';

export function workspaceKey(): string {
  return new URLSearchParams(window.location.search).get('workspace') ?? 'local-default';
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`GET ${path}: HTTP ${res.status}`);
  }
  return res.json();
}

async function sendJson(method: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    throw new Error(
      `${method} ${path}: HTTP ${res.status} ${detail?.message ?? detail?.error ?? ''}`.trim(),
    );
  }
  return res.json();
}

export async function fetchHealth(): Promise<HealthResponse> {
  return HealthResponseSchema.parse(await getJson('/api/health'));
}

export async function fetchApps(workspace: string): Promise<AppRecord[]> {
  return z.array(PublicAppSchema).parse(await getJson(`/api/apps?workspace=${workspace}`));
}

export async function fetchTxns(workspace: string): Promise<TxnRecord[]> {
  const path = `/api/txns?workspace=${workspace}&limit=100`;
  const res = await fetch(path);
  // A workspace with no gateway apps yet is unknown to the API: for a new
  // user that simply means "no transactions", not an error.
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return z.array(TxnRecordSchema).parse(await res.json());
}

export async function fetchTxnDetail(id: string): Promise<TxnDetail> {
  return TxnDetailSchema.parse(await getJson(`/api/txns/${id}`));
}

export async function fetchSpec(gateway: string): Promise<GatewaySpec> {
  return GatewaySpecSchema.parse(await getJson(`/api/specs/${gateway}`));
}

export async function fetchScenarios(workspace: string, gateway?: string): Promise<ScenarioRow[]> {
  const query = gateway ? `&gateway=${encodeURIComponent(gateway)}` : '';
  return z
    .array(ScenarioRowSchema)
    .parse(await getJson(`/api/scenarios?workspace=${workspace}${query}`));
}

export async function fetchClock(workspace: string): Promise<ClockState> {
  return ClockStateSchema.parse(await getJson(`/api/clock?workspace=${workspace}`));
}

export async function advanceClock(workspace: string, ms: number): Promise<ClockState> {
  return ClockStateSchema.parse(
    await sendJson('POST', '/api/clock/advance', { workspaceKey: workspace, ms }),
  );
}

export async function resetClock(workspace: string): Promise<ClockState> {
  return ClockStateSchema.parse(
    await sendJson('POST', '/api/clock/reset', { workspaceKey: workspace }),
  );
}

export async function createApp(input: {
  workspaceKey: string;
  gateway: string;
  name: string;
  credentials: Record<string, unknown>;
}): Promise<AppRecord> {
  return PublicAppSchema.parse(await sendJson('POST', '/api/apps', input));
}

export const SealedActivitySchema = z.object({
  sealed: z.object({
    capability: z.string(),
    expiresAt: z.number(),
    queryFingerprint: z.string(),
  }),
});

export async function fetchSealedActivity(
  workspace: string,
): Promise<SealedLiveQuery<ActivityRow>> {
  const parsed = SealedActivitySchema.parse(
    await sendJson('POST', '/api/live/activity', { workspaceKey: workspace }),
  );
  return parsed.sealed as SealedLiveQuery<ActivityRow>;
}

export async function updateAppDefault(
  appId: string,
  scenarioId: string | null,
): Promise<AppRecord> {
  return PublicAppSchema.parse(
    await sendJson('PATCH', `/api/apps/${appId}`, { defaultScenarioId: scenarioId }),
  );
}

export async function attachTxnScenario(
  txnId: string,
  scenarioId: string | null,
): Promise<TxnRecord> {
  return TxnRecordSchema.parse(
    await sendJson('POST', `/api/txns/${txnId}/scenario`, { scenarioId }),
  );
}

export async function replayDelivery(txnId: string, deliveryId?: string): Promise<DeliveryRecord> {
  return DeliveryRecordSchema.parse(
    await sendJson('POST', `/api/txns/${txnId}/replay`, { deliveryId }),
  );
}

export interface RefundEntryView {
  refundId: string;
  merchantRef: string | null;
  amountMinor: number;
  status: 'completed' | 'failed';
  reason: string;
  failureReason?: string;
  source: 'api' | 'dashboard';
  createdAt: string;
}

/** Dashboard refund; errors carry the API's human message. */
export async function refundTxn(
  txnId: string,
  input: {
    amountMinor: number;
    reason?: string;
    idempotencyKey: string;
    simulateFailure?: boolean;
  },
): Promise<{ refund: RefundEntryView; replayed: boolean }> {
  const res = await fetch(`/api/txns/${txnId}/refunds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as {
    refund?: RefundEntryView;
    replayed?: boolean;
    message?: string;
    error?: string;
  } | null;
  if (!res.ok || !body?.refund) {
    throw new Error(body?.message ?? body?.error ?? `Refund failed (HTTP ${res.status})`);
  }
  return { refund: body.refund, replayed: body.replayed === true };
}
