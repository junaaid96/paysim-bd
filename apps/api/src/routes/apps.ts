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
export function publicApp(app: AppRecord): AppRecord {
  return { ...app, credentials: redactValue(app.credentials) };
}

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
    res.json((await deps.queries.listApps(workspaceKey)).map(publicApp));
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
    res.status(201).json(app);
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
    res.json(publicApp(updated));
  });

  return router;
}
