import { Router, type Request, type Response } from 'express';

import { DEFAULT_WORKSPACE_KEY } from '@paysim/core';

import type { EventBus } from '../events/bus.js';
import type { Queries } from '../stores/drizzle-stores.js';
import { sendError } from './http.js';

export interface StreamDeps {
  bus: EventBus;
  queries: Queries;
}

export function createStreamRouter(deps: StreamDeps): Router {
  const router = Router();

  router.get('/stream', async (req: Request, res: Response) => {
    const workspaceKey =
      typeof req.query['workspace'] === 'string' ? req.query['workspace'] : DEFAULT_WORKSPACE_KEY;
    const workspace = await deps.queries.getWorkspaceByKey(workspaceKey);
    if (!workspace) {
      sendError(res, 404, 'unknown_workspace');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ workspace: workspaceKey })}\n\n`);
    const unsubscribe = deps.bus.subscribe(workspaceKey, (message) => {
      res.write(
        `id: ${message.id}\nevent: ${message.type}\ndata: ${JSON.stringify(message.data)}\n\n`,
      );
    });
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, 15_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return router;
}
