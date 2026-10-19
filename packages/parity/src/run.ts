// Fixture runner: replays steps over HTTP against a running simulator.
// Fails loudly on transport errors, status mismatches, shape diffs and
// bad captures; aborts the fixture at the first failing step (later steps
// usually depend on its captures).

import { randomUUID } from 'node:crypto';

import { diffShape } from './diff.js';
import type { FixtureFile, FixtureStep } from './fixture.js';
import { capturePath, substitute, type Vars } from './vars.js';

export interface StepFailure {
  step: string;
  message: string;
  diffs: string[];
}

export interface FixtureResult {
  name: string;
  gateway: string;
  source: string;
  pass: boolean;
  failures: StepFailure[];
  /** Coverage keys ("METHOD path") from steps that ran. */
  covered: string[];
  stepsRun: number;
}

export interface RunFixtureOptions {
  baseUrl: string;
  workspaceKey: string;
  /** Resolve jsonKey/shapeKey refs (see bodies.ts). */
  loadBody: (ref: string) => Promise<unknown>;
  fetchImpl?: typeof fetch;
  /** Per-step progress hook (CLI prints; tests ignore). */
  onStep?: (info: { fixture: string; step: string; status: number }) => void;
}

function isJsonResponse(res: Response): boolean {
  return (res.headers.get('content-type') ?? '').includes('json');
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!isJsonResponse(res)) return text;
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Response is content-type JSON but does not parse: ${text.slice(0, 120)}`);
  }
}

async function runStep(
  baseUrl: string,
  workspaceKey: string,
  step: FixtureStep,
  vars: Vars,
  options: RunFixtureOptions,
): Promise<{ failures: StepFailure[]; covered: string[] }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const path = substitute(step.request.path, vars);
  if (typeof path !== 'string') {
    return {
      failures: [{ step: step.name, message: 'substituted path is not a string', diffs: [] }],
      covered: [],
    };
  }
  const headers: Record<string, string> = { 'x-workspace-key': workspaceKey };
  for (const [key, value] of Object.entries(step.request.headers ?? {})) {
    const substituted = substitute(value, vars);
    headers[key] = typeof substituted === 'string' ? substituted : JSON.stringify(substituted);
  }
  const init: RequestInit = { method: step.request.method, headers };
  if (step.request.form !== undefined) {
    const form = substitute(step.request.form, vars) as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      params.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
    init.body = params.toString();
    headers['content-type'] = 'application/x-www-form-urlencoded';
  } else {
    const rawPayload =
      step.request.json !== undefined
        ? step.request.json
        : step.request.jsonKey !== undefined
          ? await options.loadBody(step.request.jsonKey)
          : undefined;
    const payload = rawPayload === undefined ? undefined : substitute(rawPayload, vars);
    if (payload !== undefined) {
      init.body = JSON.stringify(payload);
      headers['content-type'] = 'application/json';
    }
  }

  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}${path}`, init);
  } catch (error) {
    return {
      failures: [
        { step: step.name, message: `request failed: ${(error as Error).message}`, diffs: [] },
      ],
      covered: [],
    };
  }
  options.onStep?.({ fixture: '', step: step.name, status: res.status });
  if (res.status !== step.expect.status) {
    const snippet = (await res.text()).slice(0, 300);
    return {
      failures: [
        {
          step: step.name,
          message: `expected status ${step.expect.status}, got ${res.status}: ${snippet}`,
          diffs: [],
        },
      ],
      covered: [...step.covers],
    };
  }

  const wantsShape = step.expect.shape !== undefined || step.expect.shapeKey !== undefined;
  const wantsCapture = Object.keys(step.capture).length > 0;
  if (wantsShape || wantsCapture) {
    if (!isJsonResponse(res)) {
      return {
        failures: [
          {
            step: step.name,
            message: `expected a JSON body but content-type is ${res.headers.get('content-type') ?? '(missing)'}`,
            diffs: [],
          },
        ],
        covered: [...step.covers],
      };
    }
    let body: unknown;
    try {
      body = await readBody(res);
    } catch (error) {
      return {
        failures: [{ step: step.name, message: (error as Error).message, diffs: [] }],
        covered: [...step.covers],
      };
    }
    if (wantsShape) {
      const rawExpected =
        step.expect.shape !== undefined
          ? step.expect.shape
          : await options.loadBody(step.expect.shapeKey as string);
      const expected = substitute(rawExpected, vars);
      const diffs = diffShape(expected, body);
      if (diffs.length > 0) {
        return {
          failures: [{ step: step.name, message: `${diffs.length} shape mismatch(es)`, diffs }],
          covered: [...step.covers],
        };
      }
    }
    try {
      for (const [name, capturePathExpr] of Object.entries(step.capture)) {
        vars.set(name, capturePath(body, capturePathExpr));
      }
    } catch (error) {
      return {
        failures: [{ step: step.name, message: (error as Error).message, diffs: [] }],
        covered: [...step.covers],
      };
    }
  }
  return { failures: [], covered: [...step.covers] };
}

export async function runFixture(
  fixture: FixtureFile,
  options: RunFixtureOptions,
): Promise<FixtureResult> {
  const failures: StepFailure[] = [];
  const covered: string[] = [];
  // Per-run builtins (stable within a run): unique ids for idempotency-
  // keyed fields like tran_id so fixtures are re-runnable.
  const vars: Vars = new Map<string, unknown>([
    ['$uuid', randomUUID()],
    ['$rand8', randomUUID().replace(/-/g, '').slice(0, 8)],
    ['$timestamp', String(Date.now())],
  ]);
  const fetchImpl = options.fetchImpl ?? fetch;

  if (fixture.setupApp) {
    try {
      const res = await fetchImpl(`${options.baseUrl}/api/apps`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-workspace-key': options.workspaceKey,
        },
        body: JSON.stringify(fixture.setupApp),
      });
      // 409 = app already exists (re-runs); anything else non-2xx fails.
      if (!res.ok && res.status !== 409) {
        const snippet = (await res.text()).slice(0, 300);
        return {
          name: fixture.name,
          gateway: fixture.gateway,
          source: fixture.source,
          pass: false,
          failures: [
            {
              step: '(setupApp)',
              message: `POST /api/apps -> ${res.status}: ${snippet}`,
              diffs: [],
            },
          ],
          covered,
          stepsRun: 0,
        };
      }
    } catch (error) {
      return {
        name: fixture.name,
        gateway: fixture.gateway,
        source: fixture.source,
        pass: false,
        failures: [
          { step: '(setupApp)', message: `setup failed: ${(error as Error).message}`, diffs: [] },
        ],
        covered,
        stepsRun: 0,
      };
    }
  }

  let stepsRun = 0;
  for (const step of fixture.steps) {
    stepsRun += 1;
    const outcome = await runStep(options.baseUrl, options.workspaceKey, step, vars, options);
    covered.push(...outcome.covered);
    if (outcome.failures.length > 0) {
      failures.push(...outcome.failures);
      break;
    }
  }
  return {
    name: fixture.name,
    gateway: fixture.gateway,
    source: fixture.source,
    pass: failures.length === 0,
    failures,
    covered,
    stepsRun,
  };
}
