import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import {
  DEFAULT_WORKSPACE_KEY,
  assertFakeCredentials,
  redactValue,
  type AppRecord,
  type GatewayPlugin,
  type PluginStores,
} from '@paysim/core';

import type { Db } from '../db/client.js';
import { getScenarioById } from '../scenarios.js';
import type { Queries } from '../stores/drizzle-stores.js';
import { encryptJson, maskSecret, secretsConfigured } from '../secrets.js';
import { sendError, zodIssues } from './http.js';

export interface AppsDeps {
  db: Db;
  plugins: GatewayPlugin[];
  queries: Queries;
  stores: PluginStores;
}

const CreateAppSchema = z.object({
  workspaceKey: z.string().min(1).default(DEFAULT_WORKSPACE_KEY),
  gateway: z.string().min(1),
  name: z.string().min(1).max(100),
  credentials: z.record(z.string(), z.unknown()),
});

const IdParamSchema = z.object({ id: z.string().uuid() });

const UpdateAppSchema = z.object({ defaultScenarioId: z.string().uuid().nullable() });

/**
 * Public view of an app: secret-looking credential fields are redacted.
 * Identifiers (store_id, app_key, merchant_id) stay visible so the
 * dashboard can label apps; the secrets are only echoed once, on create.
 */
export interface PublicSandbox {
  mode: 'simulator' | 'real';
  configured: boolean;
  /** Identifiers in full, secrets as a masked hint (last 4 characters). */
  hints: Record<string, string>;
}

export type PublicApp = Omit<AppRecord, 'sandbox'> & { sandbox: PublicSandbox };

export function publicApp(app: AppRecord, plugin?: GatewayPlugin): PublicApp {
  const keys = app.sandbox?.keys ?? null;
  const hints: Record<string, string> = {};
  if (keys) {
    for (const [name, value] of Object.entries(keys)) {
      const field = plugin?.sandbox?.fields.find((candidate) => candidate.name === name);
      hints[name] = field && !field.secret ? value : maskSecret(value);
    }
  }
  return {
    ...app,
    credentials: redactValue(app.credentials),
    sandbox: { mode: app.sandbox?.mode ?? 'simulator', configured: !!keys, hints },
  };
}

const SandboxUpdateSchema = z.object({
  mode: z.enum(['simulator', 'real']),
  /** Omit to keep the saved keys; send to replace them. */
  keys: z.record(z.string(), z.string().max(512)).optional(),
  /** Forget the saved keys (forces simulator mode). */
  clearKeys: z.boolean().optional(),
});

export function createAppsRouter(deps: AppsDeps): Router {
  const router = Router();
  const knownHosts = [
    ...new Set(deps.plugins.flatMap((p) => [...p.spec.sandboxHosts, ...p.spec.productionHosts])),
  ];

  router.get('/', async (req: Request, res: Response) => {
    const workspaceKey =
      typeof req.query['workspace'] === 'string' ? req.query['workspace'] : DEFAULT_WORKSPACE_KEY;
    const workspace = await deps.queries.getWorkspaceByKey(workspaceKey);
    if (!workspace) {
      sendError(res, 404, 'unknown_workspace');
      return;
    }
    res.json(
      (await deps.queries.listApps(workspaceKey)).map((app) =>
        publicApp(
          app,
          deps.plugins.find((p) => p.name === app.gateway),
        ),
      ),
    );
  });

  router.post('/', async (req: Request, res: Response) => {
    const parsed = CreateAppSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', { issues: zodIssues(parsed.error) });
      return;
    }
    const input = parsed.data;
    const workspace = await deps.queries.getWorkspaceByKey(input.workspaceKey);
    if (!workspace) {
      sendError(res, 404, 'unknown_workspace');
      return;
    }
    const plugin = deps.plugins.find((candidate) => candidate.name === input.gateway);
    if (!plugin) {
      sendError(res, 400, 'unknown_gateway', { message: `No plugin for gateway ${input.gateway}` });
      return;
    }
    const checked = plugin.validateCredentials(input.credentials);
    if (!checked.ok) {
      sendError(res, 400, 'invalid_credentials', { issues: checked.issues });
      return;
    }
    try {
      assertFakeCredentials(knownHosts, checked.value);
    } catch (err) {
      sendError(res, 422, 'fake_credentials_required', {
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const storeId = checked.value[plugin.storeIdField];
    if (typeof storeId === 'string') {
      const duplicate = await deps.stores.findAppByStoreId(
        plugin.name,
        plugin.storeIdField,
        storeId,
      );
      if (duplicate) {
        sendError(res, 409, 'duplicate_store_id', {
          message: `An app with this ${plugin.storeIdField} already exists`,
        });
        return;
      }
    }
    const app = await deps.queries.createApp({
      workspaceId: workspace.id,
      gateway: plugin.name,
      name: input.name,
      credentials: checked.value,
    });
    res.status(201).json({ ...app, sandbox: { mode: 'simulator', configured: false, hints: {} } });
  });

  router.put('/:id/sandbox', async (req: Request, res: Response) => {
    const idParam = IdParamSchema.safeParse(req.params);
    const parsed = SandboxUpdateSchema.safeParse(req.body);
    if (!idParam.success || !parsed.success) {
      const issues = [
        ...(!idParam.success ? zodIssues(idParam.error) : []),
        ...(!parsed.success ? zodIssues(parsed.error) : []),
      ];
      sendError(res, 400, 'invalid_request', { issues });
      return;
    }
    const app = await deps.stores.getApp(idParam.data.id);
    if (!app) {
      sendError(res, 404, 'not_found');
      return;
    }
    const plugin = deps.plugins.find((candidate) => candidate.name === app.gateway);
    const support = plugin?.sandbox;
    const { mode, keys, clearKeys } = parsed.data;
    if (clearKeys) {
      const updated = await deps.queries.updateAppSandbox(app.workspaceKey, app.id, {
        mode: 'simulator',
        updatedAt: new Date().toISOString(),
      });
      res.json(publicApp(updated ?? app, plugin));
      return;
    }
    if (mode === 'real' || keys) {
      if (!support || support.status !== 'available') {
        sendError(res, 400, 'sandbox_unavailable', {
          message: support?.note ?? `${app.gateway} has no real-sandbox mode`,
        });
        return;
      }
      if (!secretsConfigured()) {
        sendError(res, 503, 'secrets_not_configured', {
          message: 'Set PAYSIM_SECRETS_KEY on the server to store sandbox keys.',
        });
        return;
      }
    }
    const raw = (await deps.queries.getAppSandboxRaw(app.id)) ?? {};
    let encrypted = raw.keys;
    if (keys && support) {
      const checked = support.validateKeys(keys);
      if (!checked.ok) {
        sendError(res, 400, 'invalid_sandbox_keys', { issues: checked.issues });
        return;
      }
      encrypted = encryptJson(checked.value as Record<string, string>);
    }
    if (mode === 'real' && !encrypted) {
      sendError(res, 400, 'sandbox_keys_required', {
        message: "Save this gateway's sandbox keys before switching to Real sandbox.",
      });
      return;
    }
    const updated = await deps.queries.updateAppSandbox(app.workspaceKey, app.id, {
      mode,
      ...(encrypted ? { keys: encrypted } : {}),
      updatedAt: new Date().toISOString(),
    });
    if (!updated) {
      sendError(res, 404, 'not_found');
      return;
    }
    if (mode === 'real' && updated.sandbox?.mode !== 'real') {
      sendError(res, 500, 'sandbox_keys_unreadable', {
        message: 'Saved keys could not be decrypted; re-enter them.',
      });
      return;
    }
    res.json(publicApp(updated, plugin));
  });

  router.patch('/:id', async (req: Request, res: Response) => {
    const idParam = IdParamSchema.safeParse(req.params);
    const parsed = UpdateAppSchema.safeParse(req.body);
    if (!idParam.success || !parsed.success) {
      const issues = [
        ...(!idParam.success ? zodIssues(idParam.error) : []),
        ...(!parsed.success ? zodIssues(parsed.error) : []),
      ];
      sendError(res, 400, 'invalid_request', { issues });
      return;
    }
    const app = await deps.stores.getApp(idParam.data.id);
    if (!app) {
      sendError(res, 404, 'not_found');
      return;
    }
    const scenarioId = parsed.data.defaultScenarioId;
    if (scenarioId !== null) {
      const scenario = await getScenarioById(deps.db, scenarioId);
      if (
        !scenario ||
        (scenario.workspaceId !== null && scenario.workspaceId !== app.workspaceId)
      ) {
        sendError(res, 404, 'unknown_scenario');
        return;
      }
      if (scenario.gateway !== app.gateway) {
        sendError(res, 400, 'gateway_mismatch', {
          message: `Scenario belongs to ${scenario.gateway}, not ${app.gateway}`,
        });
        return;
      }
    }
    const updated = await deps.queries.updateAppDefaultScenario(
      app.workspaceKey,
      app.id,
      scenarioId,
    );
    if (!updated) {
      sendError(res, 404, 'not_found');
      return;
    }
    res.json(
      publicApp(
        updated,
        deps.plugins.find((p) => p.name === updated.gateway),
      ),
    );
  });

  return router;
}
