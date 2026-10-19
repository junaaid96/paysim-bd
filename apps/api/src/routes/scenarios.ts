import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { DEFAULT_WORKSPACE_KEY, ScenarioDefinitionSchema, type GatewayPlugin } from '@paysim/core';

import type { Db } from '../db/client.js';
import {
  BuiltinScenarioError,
  DuplicateScenarioError,
  createScenario,
  deleteScenario,
  getScenarioById,
  listScenarios,
  updateScenario,
} from '../scenarios.js';
import type { Queries } from '../stores/drizzle-stores.js';
import { sendError, zodIssues } from './http.js';

export interface ScenariosDeps {
  db: Db;
  queries: Queries;
  plugins: GatewayPlugin[];
}

const ListQuerySchema = z.object({
  workspace: z.string().min(1).default(DEFAULT_WORKSPACE_KEY),
  gateway: z.string().min(1).optional(),
});

const IdParamSchema = z.object({ id: z.string().uuid() });

const CreateSchema = z.object({
  workspaceKey: z.string().min(1).default(DEFAULT_WORKSPACE_KEY),
  gateway: z.string().min(1),
  name: z.string().min(1).max(100),
  definition: ScenarioDefinitionSchema,
});

const UpdateSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    definition: ScenarioDefinitionSchema.optional(),
  })
  .refine((value) => value.name !== undefined || value.definition !== undefined, {
    message: 'nothing to update: provide name and/or definition',
  });

export function createScenariosRouter(deps: ScenariosDeps): Router {
  const router = Router();
  const gateways = new Set(deps.plugins.map((plugin) => plugin.name));

  function asPublic(row: {
    id: string;
    workspaceId: string | null;
    gateway: string;
    name: string;
    definition: unknown;
    createdAt: string;
    updatedAt: string;
  }): Record<string, unknown> {
    return { ...row, global: row.workspaceId === null };
  }

  router.get('/', async (req: Request, res: Response) => {
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', { issues: zodIssues(parsed.error) });
      return;
    }
    const workspace = await deps.queries.getWorkspaceByKey(parsed.data.workspace);
    if (!workspace) {
      sendError(res, 404, 'unknown_workspace');
      return;
    }
    if (parsed.data.gateway && !gateways.has(parsed.data.gateway)) {
      sendError(res, 400, 'unknown_gateway');
      return;
    }
    res.json((await listScenarios(deps.db, workspace.id, parsed.data.gateway)).map(asPublic));
  });

  router.get('/:id', async (req: Request, res: Response) => {
    const parsed = IdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', { issues: zodIssues(parsed.error) });
      return;
    }
    const row = await getScenarioById(deps.db, parsed.data.id);
    if (!row) {
      sendError(res, 404, 'not_found');
      return;
    }
    res.json(asPublic(row));
  });

  router.post('/', async (req: Request, res: Response) => {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', { issues: zodIssues(parsed.error) });
      return;
    }
    const workspace = await deps.queries.getWorkspaceByKey(parsed.data.workspaceKey);
    if (!workspace) {
      sendError(res, 404, 'unknown_workspace');
      return;
    }
    if (!gateways.has(parsed.data.gateway)) {
      sendError(res, 400, 'unknown_gateway');
      return;
    }
    try {
      const row = await createScenario(deps.db, {
        workspaceId: workspace.id,
        gateway: parsed.data.gateway,
        name: parsed.data.name,
        definition: parsed.data.definition,
      });
      res.status(201).json(asPublic(row));
    } catch (err) {
      if (err instanceof DuplicateScenarioError) {
        sendError(res, 409, 'duplicate_scenario', { message: err.message });
        return;
      }
      throw err;
    }
  });

  router.patch('/:id', async (req: Request, res: Response) => {
    const idParam = IdParamSchema.safeParse(req.params);
    const parsed = UpdateSchema.safeParse(req.body);
    if (!idParam.success || !parsed.success) {
      const issues = [
        ...(!idParam.success ? zodIssues(idParam.error) : []),
        ...(!parsed.success ? zodIssues(parsed.error) : []),
      ];
      sendError(res, 400, 'invalid_request', { issues });
      return;
    }
    try {
      const row = await updateScenario(deps.db, idParam.data.id, parsed.data);
      if (!row) {
        sendError(res, 404, 'not_found');
        return;
      }
      res.json(asPublic(row));
    } catch (err) {
      if (err instanceof BuiltinScenarioError) {
        sendError(res, 403, 'builtin_readonly', { message: err.message });
        return;
      }
      if (err instanceof DuplicateScenarioError) {
        sendError(res, 409, 'duplicate_scenario', { message: err.message });
        return;
      }
      throw err;
    }
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    const parsed = IdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', { issues: zodIssues(parsed.error) });
      return;
    }
    try {
      const row = await deleteScenario(deps.db, parsed.data.id);
      if (!row) {
        sendError(res, 404, 'not_found');
        return;
      }
      res.json({ id: row.id });
    } catch (err) {
      if (err instanceof BuiltinScenarioError) {
        sendError(res, 403, 'builtin_readonly', { message: err.message });
        return;
      }
      throw err;
    }
  });

  return router;
}
