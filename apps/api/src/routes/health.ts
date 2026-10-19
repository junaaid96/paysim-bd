import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('paysim-api'),
  version: z.string(),
  now: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ReadyResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.literal('paysim-api'),
});
export type ReadyResponse = z.infer<typeof ReadyResponseSchema>;

export interface HealthDeps {
  version: string;
  /** Throws when the database is unreachable. */
  checkDb: () => Promise<void>;
}

export function createHealthRouter(deps: HealthDeps): Router {
  const router = Router();

  router.get('/health', (_req: Request, res: Response) => {
    res.json(
      HealthResponseSchema.parse({
        status: 'ok',
        service: 'paysim-api',
        version: deps.version,
        now: new Date().toISOString(),
      }),
    );
  });

  router.get('/ready', async (_req: Request, res: Response) => {
    try {
      await deps.checkDb();
      res.json(ReadyResponseSchema.parse({ status: 'ok', service: 'paysim-api' }));
    } catch {
      res
        .status(503)
        .json(ReadyResponseSchema.parse({ status: 'degraded', service: 'paysim-api' }));
    }
  });

  return router;
}
