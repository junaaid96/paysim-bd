// Deploy routing parity: every gateway plugin prefix must be reachable on
// every host. The Express app mounts plugins at their prefixes, but the
// hosted playground (vercel.json rewrites) and the docker-compose dashboard
// (nginx.conf proxy) each need their own copy of that list — this test fails
// loudly when a new gateway prefix is added to a plugin but not to the
// deploy configs. (Regression: gateway POSTs to the hosted playground once
// answered 405/HTML because only /api/* was rewritten.)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { gatewayPrefixes } from '../src/plugins.js';
import { loadPlugins } from '../src/plugins.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function prefixToVercelSource(prefix: string): string {
  // '/gwprocess/' -> '/gwprocess/(.*)'
  return `${prefix}(.*)`;
}

describe('deploy routing parity', () => {
  const prefixes = gatewayPrefixes(loadPlugins());

  it('has at least one gateway prefix to guard', () => {
    expect(prefixes.length).toBeGreaterThan(0);
  });

  it('vercel.json rewrites every gateway prefix to the API function', () => {
    const vercel = JSON.parse(readFileSync(join(repoRoot, 'vercel.json'), 'utf8')) as {
      rewrites: Array<{ source: string; destination: string }>;
    };
    const apiSources = new Set(
      vercel.rewrites.filter((r) => r.destination === '/api').map((r) => r.source),
    );
    for (const prefix of prefixes) {
      expect(apiSources.has(prefixToVercelSource(prefix))).toBe(true);
    }
  });

  it('nginx.conf proxies every gateway prefix to the API container', () => {
    const nginx = readFileSync(join(repoRoot, 'apps/web/nginx.conf'), 'utf8');
    for (const prefix of prefixes) {
      expect(nginx.includes(`location ${prefix}`)).toBe(true);
    }
  });
});
