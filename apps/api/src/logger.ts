import pino, { type Logger } from 'pino';

import type { PluginLogger } from '@paysim/core';

import type { Env } from './env.js';

/** JSON logger with secret redaction. Pretty-prints in development only. */
export function createLogger(env: Env): Logger {
  return pino({
    level: env.LOG_LEVEL,
    redact: {
      paths: [
        'DATABASE_URL',
        'TEST_DATABASE_URL',
        'S3_SECRET_ACCESS_KEY',
        'S3_ACCESS_KEY_ID',
        '*.password',
        '*.secret',
        '*.token',
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
      ],
      censor: '[REDACTED]',
    },
    transport:
      env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true, singleLine: true } }
        : undefined,
  });
}

/** Adapt pino to the plugin logger surface. */
export function adaptPino(logger: Logger): PluginLogger {
  const write =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (message: string, data?: unknown): void => {
      logger[level](data === undefined ? {} : { data }, message);
    };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}
