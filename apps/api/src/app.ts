import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import cors from 'cors';
import express, {
  type Application,
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';

import type {
  Clock,
  DeliverCallbackInput,
  DeliveryRecord,
  GatewayPlugin,
  PluginStores,
  ScenarioEngine,
} from '@paysim/core';

import type { DbClock } from './clock.js';
import type { Db } from './db/client.js';
import type { Env } from './env.js';
import type { EventBus } from './events/bus.js';
import { adaptPino } from './logger.js';
import { gatewayPrefixes } from './plugins.js';
import { createAppsRouter } from './routes/apps.js';
import { createClockRouter } from './routes/clock.js';
import { createHealthRouter } from './routes/health.js';
import { createLiveRouter } from './routes/live.js';
import { createScenariosRouter } from './routes/scenarios.js';
import { createSpecsRouter } from './routes/specs.js';
import { createStreamRouter } from './routes/stream.js';
import { createTxnsRouter } from './routes/transactions.js';
import type { Queries } from './stores/drizzle-stores.js';
import type { StorageAdapter } from './storage/index.js';
import type { TxnOpsDeps } from './txn-ops.js';

export interface AppDeps {
  env: Env;
  logger: Logger;
  version: string;
  checkDb: () => Promise<void>;
  storage: StorageAdapter;
  db: Db;
  plugins: GatewayPlugin[];
  stores: PluginStores;
  queries: Queries;
  bus: EventBus;
  clock: Clock;
  dbClock: DbClock;
  simBaseUrl: string;
  deliverCallback: (input: DeliverCallbackInput) => Promise<DeliveryRecord>;
  engine: ScenarioEngine;
  ops: TxnOpsDeps;
  /** Wake the scheduler (clock jumps, dashboard actions). */
  kick: () => void;
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

function httpErrorStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null || !('status' in err)) return null;
  const status = (err as { status: unknown }).status;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : null;
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

  // Gateways speak JSON and urlencoded form posts; support both everywhere.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

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

  app.use('/api', createHealthRouter({ version: deps.version, checkDb: deps.checkDb }));
  app.use(
    '/api/apps',
    createAppsRouter({
      db: deps.db,
      plugins: deps.plugins,
      queries: deps.queries,
      stores: deps.stores,
    }),
  );
  app.use('/api/txns', createTxnsRouter({ queries: deps.queries, ops: deps.ops }));
  app.use('/api/specs', createSpecsRouter(deps.plugins));
  app.use(
    '/api/scenarios',
    createScenariosRouter({ db: deps.db, queries: deps.queries, plugins: deps.plugins }),
  );
  app.use(
    '/api/clock',
    createClockRouter({
      db: deps.db,
      clock: deps.dbClock,
      queries: deps.queries,
      bus: deps.bus,
      kick: deps.kick,
    }),
  );
  app.use('/api', createStreamRouter({ bus: deps.bus, queries: deps.queries }));
  app.use('/api/live', createLiveRouter({ env: deps.env, queries: deps.queries }));

  for (const plugin of deps.plugins) {
    const router = plugin.createRouter({
      stores: deps.stores,
      logger: adaptPino(logger.child({ plugin: plugin.name })),
      clock: deps.clock,
      simBaseUrl: deps.simBaseUrl,
      deliverCallback: deps.deliverCallback,
      engine: deps.engine,
    }) as Router;
    app.use(router);
    logger.info({ plugin: plugin.name }, 'mounted gateway plugin');
  }

  // Unknown gateway paths answer JSON (never the dashboard HTML).
  const prefixes = gatewayPrefixes(deps.plugins);
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (prefixes.some((prefix) => req.path.startsWith(prefix))) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    next();
  });

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
    const status = httpErrorStatus(err);
    if (status !== null) {
      res.status(status).json({
        error: 'bad_request',
        message: err instanceof Error ? err.message : 'Bad request',
      });
      return;
    }
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
