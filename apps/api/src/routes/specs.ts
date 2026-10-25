import { Router, type Request, type Response } from 'express';

import type { GatewayPlugin } from '@paysim/core';

import { sendError } from './http.js';

export function createSpecsRouter(plugins: GatewayPlugin[]): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    res.json(
      plugins.map((plugin) => ({
        gateway: plugin.name,
        displayName: plugin.displayName,
        version: plugin.spec.version,
        fidelity: plugin.spec.fidelity,
        sandbox: plugin.sandbox
          ? {
              status: plugin.sandbox.status,
              note: plugin.sandbox.note,
              docsUrl: plugin.sandbox.docsUrl,
              fields: plugin.sandbox.fields,
              publicTestKeys: plugin.sandbox.publicTestKeys ?? null,
              signupUrl: plugin.sandbox.signupUrl ?? null,
            }
          : null,
      })),
    );
  });

  router.get('/:gateway', (req: Request, res: Response) => {
    const plugin = plugins.find((candidate) => candidate.name === req.params['gateway']);
    if (!plugin) {
      sendError(res, 404, 'unknown_gateway');
      return;
    }
    res.json(plugin.spec);
  });

  return router;
}
