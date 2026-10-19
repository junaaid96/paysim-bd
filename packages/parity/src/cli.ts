// paysim-parity: replay every fixture against a running simulator and
// enforce the badge rule. Usage:
//   node dist/cli.js --base-url http://127.0.0.1:3001 [--fixtures <dir>]
//     [--gateway sslcommerz] [--workspace-key local-default]
//     [--bodies-dir <dir>] [--specs <gateway:spec-path,...>]
// Exit 1 on any fixture failure, false "verified" claim, or coverage gap.

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GatewaySpecSchema } from '@paysim/core';

import { evaluateBadges, type GatewaySpecSummary } from './badges.js';
import { loadBodyJson } from './bodies.js';
import { discoverFixtures } from './discover.js';
import type { FixtureFile } from './fixture.js';
import { runFixture } from './run.js';

interface CliOptions {
  baseUrl: string;
  fixturesDir: string;
  gateways: string[] | null;
  workspaceKey: string;
  bodiesDir: string | undefined;
  specs: { gateway: string; path: string }[];
}

function usage(): string {
  return [
    'paysim-parity --base-url <url> [options]',
    '',
    '  --fixtures <dir>       fixture root (default: bundled fixtures/)',
    '  --gateway <name>       only run this gateway (repeatable)',
    '  --workspace-key <key>  workspace header (default: local-default)',
    '  --bodies-dir <dir>     filesystem root for jsonKey/shapeKey refs (default: fixtures dir)',
    '  --specs <g:path,...>   spec manifests for badge checks',
    '                          (default: ../../gateways/<name>/spec/v1.json per gateway)',
  ].join('\n');
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    baseUrl: '',
    fixturesDir: join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures'),
    gateways: null,
    workspaceKey: 'local-default',
    bodiesDir: undefined,
    specs: [],
  };
  const gateways: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}\n${usage()}`);
      i += 1;
      return value;
    };
    if (arg === '--base-url') options.baseUrl = next();
    else if (arg === '--fixtures') options.fixturesDir = resolve(next());
    else if (arg === '--gateway') gateways.push(next());
    else if (arg === '--workspace-key') options.workspaceKey = next();
    else if (arg === '--bodies-dir') options.bodiesDir = resolve(next());
    else if (arg === '--specs') {
      for (const entry of next().split(',')) {
        const [gateway, path] = entry.split(':');
        if (!gateway || !path) throw new Error(`Bad --specs entry "${entry}" (want gateway:path)`);
        options.specs.push({ gateway, path: resolve(path) });
      }
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument ${arg}\n${usage()}`);
    }
  }
  if (!options.baseUrl) throw new Error(`Missing --base-url\n${usage()}`);
  if (gateways.length > 0) options.gateways = gateways;
  return options;
}

async function loadSpecSummaries(
  options: CliOptions,
  gateways: string[],
): Promise<GatewaySpecSummary[]> {
  const summaries: GatewaySpecSummary[] = [];
  for (const gateway of gateways) {
    const override = options.specs.find((spec) => spec.gateway === gateway);
    const path =
      override?.path ??
      resolve(options.fixturesDir, '..', '..', 'gateways', gateway, 'spec', 'v1.json');
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    const spec = GatewaySpecSchema.parse(raw);
    summaries.push({
      gateway,
      claimed: spec.fidelity,
      implementedEndpoints: spec.endpoints
        .filter((endpoint) => endpoint.implemented)
        .map((endpoint) => `${endpoint.method} ${endpoint.path}`),
    });
  }
  return summaries;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const discovered = await discoverFixtures(options.fixturesDir, options.gateways);
  if (discovered.length === 0) {
    console.error('No fixtures found.');
    process.exit(1);
  }
  const fixtures: FixtureFile[] = discovered.map((entry) => entry.fixture);

  let failed = 0;
  const results = [];
  for (const fixture of fixtures) {
    if (options.gateways && !options.gateways.includes(fixture.gateway)) continue;
    const result = await runFixture(fixture, {
      baseUrl: options.baseUrl,
      workspaceKey: options.workspaceKey,
      loadBody: (ref) => loadBodyJson(ref, { bodiesDir: options.bodiesDir ?? options.fixturesDir }),
      onStep: ({ step, status }) => console.log(`  step ${step} -> ${status}`),
    });
    results.push(result);
    console.log(
      `${result.pass ? 'PASS' : 'FAIL'} ${fixture.gateway}/${fixture.name} [${fixture.source}]`,
    );
    for (const failure of result.failures) {
      console.log(`  ${failure.step}: ${failure.message}`);
      for (const diff of failure.diffs.slice(0, 25)) console.log(`    ${diff}`);
      if (failure.diffs.length > 25) console.log(`    … +${failure.diffs.length - 25} more`);
    }
    if (!result.pass) failed += 1;
  }

  const gateways = [...new Set(results.map((result) => result.gateway))].sort();
  const specs = await loadSpecSummaries(options, gateways);
  const report = evaluateBadges(specs, results);
  console.log('\nBadges:');
  for (const verdict of report.verdicts) {
    console.log(
      `  ${verdict.gateway}: claimed=${verdict.claimed} supported=${verdict.supported} ` +
        `fixtures=${verdict.fixturesPassed}/${verdict.fixturesRun} ` +
        `covered=${verdict.coveredImplemented.length}/${verdict.coveredImplemented.length + verdict.uncoveredImplemented.length} ` +
        `real-sandbox=${verdict.realSandboxCovered.length}`,
    );
    for (const endpoint of verdict.uncoveredImplemented) {
      console.log(`    uncovered: ${endpoint}`);
    }
  }
  for (const error of report.errors) console.log(`ERROR: ${error}`);
  process.exit(report.ok && failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
