import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { createRealtime } from '@neon/realtime/server';
import { DEFAULT_WORKSPACE_KEY } from '@paysim/core';

import { nonEmpty, type Env } from '../env.js';
import { activityQuery, dbNameFromUrl } from '../live-queries.js';
import type { Queries } from '../stores/drizzle-stores.js';
import { isWellFormedWorkspaceKey, sendError, zodIssues } from './http.js';

export interface LiveDeps {
  env: Env;
  queries: Queries;
}

const SealBodySchema = z.object({
  workspaceKey: z.string().min(1).default(DEFAULT_WORKSPACE_KEY),
});

export function createLiveRouter(deps: LiveDeps): Router {
  const router = Router();
  // Sealing is local Web Crypto work (no network), so one server per process.
  // A missing or malformed secret degrades to 501, never a boot crash.
  let cached: ReturnType<typeof createRealtime> | null | undefined;
  const server = (): ReturnType<typeof createRealtime> | null => {
    if (cached !== undefined) return cached;
    const secret = nonEmpty(deps.env.NEON_REALTIME_SECRET);
    if (secret === undefined) {
      cached = null;
      return cached;
    }
    try {
      cached = createRealtime({
        secret,
        db: dbNameFromUrl(deps.env.DATABASE_URL),
        debugMode: deps.env.NODE_ENV === 'development',
      });
    } catch {
      cached = null;
    }
    return cached;
  };

  // Seal the workspace activity feed for one browser subscription. The sealed
  // query is a bearer token: send over HTTPS, never log or persist it.
  router.post('/activity', async (req: Request, res: Response) => {
    const parsed = SealBodySchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', { issues: zodIssues(parsed.error) });
      return;
    }
    const workspaceKey = parsed.data.workspaceKey;
    // Unknown but well-formed keys are brand-new, empty workspaces: the
    // activity query joins on the key, so it is sealed and returns no rows.
    if (!isWellFormedWorkspaceKey(workspaceKey)) {
      sendError(res, 400, 'invalid_workspace');
      return;
    }
    const realtime = server();
    if (!realtime) {
      sendError(res, 501, 'realtime_not_configured', {
        message: 'NEON_REALTIME_SECRET is not set on the API',
      });
      return;
    }
    res.json({ sealed: await realtime.seal({ query: activityQuery(workspaceKey) }) });
  });

  return router;
}
