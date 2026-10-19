import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import cors from 'cors';
import express, { type Application, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';

import type { Env } from './env.js';
import { createHealthRouter } from './routes/health.js';
import type { StorageAdapter } from './storage/index.js';

export interface AppDeps {
  env: Env;
  logger: Logger;
  version: string;
  checkDb: () => Promise<void>;
  storage: StorageAdapter;
}

/**
 * Locate the built dashboard. Defaults to apps/web/dist relative to this
 * file (identical from src/ and dist/); WEB_DIST_DIR overrides. Returns null
 * when the dashboard has not been built — the API still runs standalone.
 */
export function resolveWebDistDir(env: Env): string | null {
  const override = env.WEB_DIST_DIR?.trim();
  const dir =
    override && override.length > 0
      ? override
      : join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
  return existsSync(dir) ? dir : null;
}

export function createApp(deps: AppDeps): Application {
  const { env, logger } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());

  const corsOrigins =
    env.CORS_ORIGIN?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  if (corsOrigins.length > 0) {
    app.use(cors({ origin: corsOrigins }));
  } else if (env.NODE_ENV !== 'production') {
    app.use(cors());
  }

  app.use(express.json({ limit: '1mb' }));

  // Request log: method/url/status/duration only — never bodies or headers.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = Date.now();
    res.on('finish', () => {
      logger.info(
        {
          method: req.method,
          url: req.originalUrl ?? req.url,
          status: res.statusCode,
          durationMs: Date.now() - started,
        },
        'request',
      );
    });
    next();
  });

  // Stashed for Phase 1 gateway routes; also proves the driver boots.
  app.set('storage', deps.storage satisfies StorageAdapter);

  app.use('/api', createHealthRouter({ version: deps.version, checkDb: deps.checkDb }));

  const webDir = resolveWebDistDir(env);
  if (webDir) {
    app.use(express.static(webDir, { index: 'index.html', maxAge: '1h' }));
    // SPA fallback for dashboard routes; API paths fall through to the 404.
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' || req.path === '/api' || req.path.startsWith('/api/')) {
        return next();
      }
      res.sendFile(join(webDir, 'index.html'));
    });
    logger.info({ webDir }, 'serving dashboard');
  } else {
    logger.info('dashboard not built; serving API only');
  }

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Express 5 catches async throwns; this formats them as JSON.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, 'unhandled error');
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
