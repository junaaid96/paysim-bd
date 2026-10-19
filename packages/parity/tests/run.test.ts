import { describe, expect, it } from 'vitest';

import { FixtureFileSchema, normalizeCoverageKey } from '../src/fixture.js';
import { runFixture } from '../src/run.js';

const BASE = {
  version: 1,
  name: 'stubbed',
  gateway: 'demo',
  source: 'docs-sample',
  steps: [
    {
      name: 'one',
      request: { method: 'GET', path: '/thing/{{$rand8}}' },
      expect: { status: 200, shape: { ok: true, echo: 'E1' } },
      capture: { captured: 'echo' },
    },
    {
      name: 'two',
      covers: ['GET /thing/{id}'],
      request: { method: 'GET', path: '/other?x={{captured}}' },
      expect: { status: 200 },
    },
  ],
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('FixtureFileSchema', () => {
  it('accepts the stubbed flow and normalizes coverage keys', () => {
    const parsed = FixtureFileSchema.parse(BASE);
    expect(parsed.steps).toHaveLength(2);
    expect(normalizeCoverageKey('post   /a')).toBe('POST /a');
  });

  it('rejects body/shape key mixing', () => {
    const bad = structuredClone(BASE) as unknown as {
      steps: [{ request: Record<string, unknown>; expect: Record<string, unknown> }];
    };
    bad.steps[0]!.request['json'] = { a: 1 };
    bad.steps[0]!.request['jsonKey'] = 'a.json';
    expect(() => FixtureFileSchema.parse(bad)).toThrow(/mutually exclusive/);
    bad.steps[0]!.request = { method: 'GET', path: '/x' };
    bad.steps[0]!.expect = { status: 200, shape: {}, shapeKey: 'b.json' };
    expect(() => FixtureFileSchema.parse(bad)).toThrow(/mutually exclusive/);
  });
});

describe('runFixture (stubbed fetch)', () => {
  it('substitutes builtins, captures across steps, and reports coverage', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      const path = String(url);
      seen.push(path);
      if (path.includes('/thing/')) return jsonResponse({ ok: true, echo: 'E1' });
      return jsonResponse({ other: true });
    }) as typeof fetch;
    const result = await runFixture(FixtureFileSchema.parse(BASE), {
      baseUrl: 'http://stub',
      workspaceKey: 'local-default',
      loadBody: async () => {
        throw new Error('no keys in this fixture');
      },
      fetchImpl,
    });
    expect(result.pass).toBe(true);
    expect(result.covered).toEqual(['GET /thing/{id}']);
    expect(seen[0]).toMatch(/\/thing\/[0-9a-f]{8}$/);
    expect(seen[1]).toBe('http://stub/other?x=E1');
  });

  it('fails on status mismatch and shape diffs with paths', async () => {
    const statusFail = await runFixture(FixtureFileSchema.parse(BASE), {
      baseUrl: 'http://stub',
      workspaceKey: 'local-default',
      loadBody: async () => null,
      fetchImpl: (async () => jsonResponse({ ok: true }, 500)) as typeof fetch,
    });
    expect(statusFail.pass).toBe(false);
    expect(statusFail.failures[0]?.message).toMatch(/expected status 200, got 500/);

    const shapeFail = await runFixture(FixtureFileSchema.parse(BASE), {
      baseUrl: 'http://stub',
      workspaceKey: 'local-default',
      loadBody: async () => null,
      fetchImpl: (async () => jsonResponse({ ok: false, echo: 'E1' })) as typeof fetch,
    });
    expect(shapeFail.pass).toBe(false);
    expect(shapeFail.failures[0]?.diffs).toEqual(['~ ok: expected true, got false']);
  });

  it('treats setup 409 as already-exists but fails other setup errors', async () => {
    const withSetup = FixtureFileSchema.parse({
      ...BASE,
      setupApp: { gateway: 'demo', name: 'n', credentials: { a: 'b' } },
    });
    const loadBody = async (): Promise<unknown> => null;
    const conflict = await runFixture(withSetup, {
      baseUrl: 'http://stub',
      workspaceKey: 'local-default',
      loadBody,
      fetchImpl: (async (url: unknown) => {
        if (String(url).endsWith('/api/apps')) return new Response('dup', { status: 409 });
        return jsonResponse({ ok: true, echo: 'E1' });
      }) as typeof fetch,
    });
    expect(conflict.pass).toBe(true);

    const rejected = await runFixture(withSetup, {
      baseUrl: 'http://stub',
      workspaceKey: 'local-default',
      loadBody,
      fetchImpl: (async (url: unknown) => {
        if (String(url).endsWith('/api/apps')) return jsonResponse({ error: 'nope' }, 400);
        return jsonResponse({ ok: true, echo: 'E1' });
      }) as typeof fetch,
    });
    expect(rejected.pass).toBe(false);
    expect(rejected.failures[0]?.step).toBe('(setupApp)');
  });
});
