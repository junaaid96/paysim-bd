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
  type AppRecord,
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
export type {
  ActivityRow,
  AppRecord,
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
  return z.array(AppRecordSchema).parse(await getJson(`/api/apps?workspace=${workspace}`));
}

export async function fetchTxns(workspace: string): Promise<TxnRecord[]> {
  return z
    .array(TxnRecordSchema)
    .parse(await getJson(`/api/txns?workspace=${workspace}&limit=100`));
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
  return AppRecordSchema.parse(await sendJson('POST', '/api/apps', input));
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
  return AppRecordSchema.parse(
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
