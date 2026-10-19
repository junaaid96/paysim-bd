import { describe, expect, it } from 'vitest';

import { evaluateBadges, type GatewaySpecSummary } from '../src/badges.js';
import type { FixtureResult } from '../src/run.js';

function result(
  overrides: Partial<FixtureResult> & { name: string; gateway: string },
): FixtureResult {
  return {
    source: 'docs-sample',
    pass: true,
    failures: [],
    covered: [],
    stepsRun: 1,
    ...overrides,
  };
}

const SPEC: GatewaySpecSummary = {
  gateway: 'demo',
  claimed: 'docs-only',
  implementedEndpoints: ['POST /a', 'GET /b'],
};

describe('evaluateBadges', () => {
  it('passes green docs-only runs and reports coverage', () => {
    const report = evaluateBadges(SPEC ? [SPEC] : [], [
      result({ name: 'f1', gateway: 'demo', covered: ['POST /a'] }),
    ]);
    expect(report.ok).toBe(true);
    expect(report.verdicts[0]).toMatchObject({
      supported: 'docs-only',
      fixturesRun: 1,
      fixturesPassed: 1,
      coveredImplemented: ['POST /a'],
      uncoveredImplemented: ['GET /b'],
      realSandboxCovered: [],
    });
  });

  it('fails on any fixture failure', () => {
    const report = evaluateBadges(
      [SPEC],
      [
        result({
          name: 'f1',
          gateway: 'demo',
          pass: false,
          failures: [{ step: 's', message: 'boom', diffs: [] }],
        }),
      ],
    );
    expect(report.ok).toBe(false);
    expect(report.errors[0]).toMatch(/fixture FAILED/);
  });

  it('rejects verified claims without passing real-sandbox coverage', () => {
    const claimed = { ...SPEC, claimed: 'verified' as const };
    const docsOnly = evaluateBadges(
      [claimed],
      [result({ name: 'f1', gateway: 'demo', covered: ['POST /a', 'GET /b'] })],
    );
    expect(docsOnly.ok).toBe(false);
    expect(docsOnly.errors.join('\n')).toMatch(/badge REJECTED.*real-sandbox coverage/);

    const partial = evaluateBadges(
      [claimed],
      [result({ name: 'f1', gateway: 'demo', source: 'real-sandbox', covered: ['POST /a'] })],
    );
    expect(partial.ok).toBe(false);
    expect(partial.errors.join('\n')).toMatch(/GET \/b/);
  });

  it('accepts verified claims with full passing real-sandbox coverage', () => {
    const report = evaluateBadges(
      [{ ...SPEC, claimed: 'verified' }],
      [
        result({ name: 'f1', gateway: 'demo', source: 'real-sandbox', covered: ['POST /a'] }),
        result({ name: 'f2', gateway: 'demo', source: 'real-sandbox', covered: ['GET /b'] }),
      ],
    );
    expect(report.ok).toBe(true);
    expect(report.verdicts[0]?.supported).toBe('verified');
  });

  it('flags coverage gaps and unknown gateways', () => {
    const gap = evaluateBadges([SPEC], []);
    expect(gap.ok).toBe(false);
    expect(gap.errors.join('\n')).toMatch(/coverage GAP/);

    const unknown = evaluateBadges([SPEC], [result({ name: 'x', gateway: 'nope' })]);
    expect(unknown.errors.join('\n')).toMatch(/unknown gateway/);
  });

  it('normalizes coverage keys before matching', () => {
    const report = evaluateBadges(
      [SPEC],
      [result({ name: 'f1', gateway: 'demo', covered: ['post   /a'] })],
    );
    expect(report.verdicts[0]?.coveredImplemented).toEqual(['POST /a']);
  });
});
