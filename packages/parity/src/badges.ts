// Badge evaluation: maps parity results + spec manifests to the per-gateway
// fidelity verdict, and enforces the headline rule — a "verified" claim in
// spec/vN.json fails CI unless every implemented endpoint is covered by a
// PASSING real-sandbox fixture. docs-sample/community-sample fixtures can
// never promote past docs-only, no matter how green.

import type { Fidelity } from '@paysim/core';

import { normalizeCoverageKey } from './fixture.js';
import type { FixtureResult } from './run.js';

export interface GatewaySpecSummary {
  gateway: string;
  claimed: Fidelity;
  /** "METHOD path" for every implemented endpoint in spec/vN.json. */
  implementedEndpoints: string[];
}

export interface GatewayVerdict {
  gateway: string;
  claimed: Fidelity;
  /** Highest badge the evidence supports (never above the claim). */
  supported: 'verified' | 'docs-only' | 'unverified';
  fixturesRun: number;
  fixturesPassed: number;
  coveredImplemented: string[];
  uncoveredImplemented: string[];
  realSandboxCovered: string[];
}

export interface BadgeReport {
  verdicts: GatewayVerdict[];
  /** Non-empty = CI must fail. */
  errors: string[];
  ok: boolean;
}

function coverageOf(results: FixtureResult[], source?: string): Set<string> {
  const keys = new Set<string>();
  for (const result of results) {
    if (!result.pass) continue;
    if (source !== undefined && result.source !== source) continue;
    for (const raw of result.covered) keys.add(normalizeCoverageKey(raw));
  }
  return keys;
}

export function evaluateBadges(specs: GatewaySpecSummary[], results: FixtureResult[]): BadgeReport {
  const verdicts: GatewayVerdict[] = [];
  const errors: string[] = [];

  const failing = results.filter((result) => !result.pass);
  for (const result of failing) {
    errors.push(
      `fixture FAILED: ${result.gateway}/${result.name} (${result.failures.map((f) => `${f.step}: ${f.message}`).join('; ')})`,
    );
  }

  for (const spec of specs) {
    const gatewayResults = results.filter((result) => result.gateway === spec.gateway);
    const implemented = spec.implementedEndpoints.map(normalizeCoverageKey);
    const covered = coverageOf(gatewayResults);
    const realCovered = coverageOf(gatewayResults, 'real-sandbox');
    const coveredImplemented = implemented.filter((endpoint) => covered.has(endpoint));
    const uncoveredImplemented = implemented.filter((endpoint) => !covered.has(endpoint));
    const realSandboxCovered = implemented.filter((endpoint) => realCovered.has(endpoint));

    const allPass = gatewayResults.length > 0 && gatewayResults.every((r) => r.pass);
    const fullyRealCovered =
      implemented.length > 0 &&
      realSandboxCovered.length === implemented.length &&
      gatewayResults.filter((r) => r.source === 'real-sandbox').every((r) => r.pass);
    let supported: GatewayVerdict['supported'] = 'unverified';
    if (fullyRealCovered) {
      supported = 'verified';
    } else if (allPass && gatewayResults.length > 0) {
      supported = 'docs-only';
    }

    if (spec.claimed === 'verified' && supported !== 'verified') {
      if (gatewayResults.length === 0) {
        errors.push(`badge REJECTED: ${spec.gateway} claims "verified" but has no parity fixtures`);
      } else if (!gatewayResults.every((r) => r.pass)) {
        errors.push(`badge REJECTED: ${spec.gateway} claims "verified" but has failing fixtures`);
      } else {
        const missing = implemented.filter((endpoint) => !realCovered.has(endpoint));
        errors.push(
          `badge REJECTED: ${spec.gateway} claims "verified" but lacks passing real-sandbox coverage for: ${missing.join(', ') || '(none — check fixture sources)'}`,
        );
      }
    }
    // A docs-only claim with zero fixtures is allowed (docs grounding lives
    // in the spec manifest), but flag it so the gap is visible.
    if (
      (spec.claimed === 'docs-only' || spec.claimed === 'verified') &&
      gatewayResults.length === 0
    ) {
      errors.push(
        `coverage GAP: ${spec.gateway} claims "${spec.claimed}" but has no parity fixtures`,
      );
    }

    verdicts.push({
      gateway: spec.gateway,
      claimed: spec.claimed,
      supported,
      fixturesRun: gatewayResults.length,
      fixturesPassed: gatewayResults.filter((r) => r.pass).length,
      coveredImplemented,
      uncoveredImplemented,
      realSandboxCovered,
    });
  }

  // Results for gateways with no spec summary are authoring bugs.
  const known = new Set(specs.map((spec) => spec.gateway));
  for (const result of results) {
    if (!known.has(result.gateway)) {
      errors.push(`fixture ${result.name} targets unknown gateway "${result.gateway}"`);
    }
  }

  return { verdicts, errors, ok: errors.length === 0 };
}
