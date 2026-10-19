// Engine resolution/attach, scenario store CRUD, builtin seeding, and the
// database clock. Needs TEST_DATABASE_URL (serial with other files).

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ScenarioDefinitionSchema, ScenarioNotFoundError } from '@paysim/core';

import { jobs } from '../src/db/schema.js';
import { ensureBuiltinScenarios } from '../src/db/seed.js';
import { manualScenario } from '../src/engine.js';
import { hasPendingJob } from '../src/jobs.js';
import {
  BuiltinScenarioError,
  DuplicateScenarioError,
  createScenario,
  deleteScenario,
  findScenarioByName,
  getScenarioById,
  getGlobalScenario,
  listScenarios,
  updateScenario,
} from '../src/scenarios.js';
import { createTestHost, type TestHost } from './host-harness.js';

const TEST_URL = process.env['TEST_DATABASE_URL'];
const maybe = TEST_URL ? describe : describe.skip;

maybe('engine + scenarios integration', () => {
  let host: TestHost;

  beforeAll(async () => {
    host = await createTestHost();
  }, 60_000);

  afterAll(async () => {
    await host.cleanup();
  });

  it('seeds built-in scenarios idempotently', async () => {
    const again = await ensureBuiltinScenarios(host.db, host.plugins);
    expect(again).toBe(0);
    const globals = await listScenarios(host.db, host.workspace.id, 'sslcommerz');
    const names = globals.filter((row) => row.workspaceId === null).map((row) => row.name);
    expect(names).toContain('manual');
    expect(names).toContain('immediate-success');
    expect(names).toContain('duplicate-ipn');
    expect(names).toContain('late-ipn');
    expect(names).toContain('stay-pending');
  });

  it('resolves magic > app default > manual', async () => {
    const magic = await host.ctx.engine.resolveForInit({
      workspaceId: host.workspace.id,
      gateway: 'sslcommerz',
      defaultScenarioId: null,
      magicName: 'immediate-success',
    });
    expect(magic.source).toBe('magic');
    expect(magic.definition.name).toBe('immediate-success');
    expect(magic.definition.steps).toHaveLength(1);
    expect(magic.scenarioId).toBe(
      (await getGlobalScenario(host.db, 'sslcommerz', 'immediate-success'))?.id,
    );

    const manual = await host.ctx.engine.resolveForInit({
      workspaceId: host.workspace.id,
      gateway: 'sslcommerz',
      defaultScenarioId: null,
      magicName: null,
    });
    expect(manual).toMatchObject({ source: 'manual', scenarioId: null });
    expect(manual.definition.steps).toHaveLength(0);
    expect(manualScenario().definition.name).toBe('manual');

    const custom = await createScenario(host.db, {
      workspaceId: host.workspace.id,
      gateway: 'sslcommerz',
      name: 'custom-default',
      definition: ScenarioDefinitionSchema.parse({
        name: 'custom-default',
        steps: [{ action: 'redirect_fail' }],
      }),
    });
    const viaDefault = await host.ctx.engine.resolveForInit({
      workspaceId: host.workspace.id,
      gateway: 'sslcommerz',
      defaultScenarioId: custom.id,
      magicName: null,
    });
    expect(viaDefault).toMatchObject({ source: 'default', scenarioId: custom.id });
  });

  it('fails loud on unknown magic and unusable app defaults', async () => {
    await expect(
      host.ctx.engine.resolveForInit({
        workspaceId: host.workspace.id,
        gateway: 'sslcommerz',
        defaultScenarioId: null,
        magicName: 'nope',
      }),
    ).rejects.toBeInstanceOf(ScenarioNotFoundError);

    await expect(
      host.ctx.engine.resolveForInit({
        workspaceId: host.workspace.id,
        gateway: 'sslcommerz',
        defaultScenarioId: '00000000-0000-0000-0000-000000000000',
        magicName: null,
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it('lets workspace scenarios shadow global presets by name', async () => {
    const shadow = await createScenario(host.db, {
      workspaceId: host.workspace.id,
      gateway: 'sslcommerz',
      name: 'immediate-success',
      definition: ScenarioDefinitionSchema.parse({
        name: 'immediate-success',
        steps: [{ action: 'redirect_fail' }],
      }),
    });
    const resolved = await host.ctx.engine.resolveForInit({
      workspaceId: host.workspace.id,
      gateway: 'sslcommerz',
      defaultScenarioId: null,
      magicName: 'immediate-success',
    });
    expect(resolved.scenarioId).toBe(shadow.id);
    expect(resolved.definition.steps[0]?.action).toBe('redirect_fail');
    await deleteScenario(host.db, shadow.id);
  });

  it('CRUDs workspace scenarios with duplicate and builtin guards', async () => {
    const created = await createScenario(host.db, {
      workspaceId: host.workspace.id,
      gateway: 'sslcommerz',
      name: 'crud-case',
      definition: ScenarioDefinitionSchema.parse({ name: 'crud-case', steps: [] }),
    });
    expect((await getScenarioById(host.db, created.id))?.name).toBe('crud-case');

    await expect(
      createScenario(host.db, {
        workspaceId: host.workspace.id,
        gateway: 'sslcommerz',
        name: 'crud-case',
        definition: ScenarioDefinitionSchema.parse({ name: 'crud-case', steps: [] }),
      }),
    ).rejects.toBeInstanceOf(DuplicateScenarioError);

    const renamed = await updateScenario(host.db, created.id, { name: 'crud-renamed' });
    expect(renamed?.name).toBe('crud-renamed');
    expect(renamed?.definition.name).toBe('crud-renamed');

    const missing = await findScenarioByName(host.db, host.workspace.id, 'sslcommerz', 'nope');
    expect(missing).toBeNull();

    const global = await getGlobalScenario(host.db, 'sslcommerz', 'manual');
    expect(global).not.toBeNull();
    await expect(updateScenario(host.db, global?.id ?? '', { name: 'x' })).rejects.toBeInstanceOf(
      BuiltinScenarioError,
    );
    await expect(deleteScenario(host.db, global?.id ?? '')).rejects.toBeInstanceOf(
      BuiltinScenarioError,
    );

    expect((await deleteScenario(host.db, created.id))?.id).toBe(created.id);
    expect(await getScenarioById(host.db, created.id)).toBeNull();
  });

  it('attach schedules the first step plus one expiry timer', async () => {
    const txn = await host.seedTxn();
    const resolved = await host.ctx.engine.resolveForInit({
      workspaceId: host.workspace.id,
      gateway: 'sslcommerz',
      defaultScenarioId: null,
      magicName: 'duplicate-ipn',
    });
    await host.ctx.engine.attach({
      txn,
      scenarioId: resolved.scenarioId,
      definition: resolved.definition,
      source: resolved.source,
    });
    expect(await hasPendingJob(host.db, txn.id, 'scenario-step')).toBe(true);
    expect(await hasPendingJob(host.db, txn.id, 'session-expiry')).toBe(true);

    // Attaching again does not duplicate the expiry timer.
    await host.ctx.engine.attach({
      txn,
      scenarioId: resolved.scenarioId,
      definition: resolved.definition,
      source: resolved.source,
    });
    const expiryJobs = await host.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.transactionId, txn.id),
          eq(jobs.type, 'session-expiry'),
          eq(jobs.status, 'pending'),
        ),
      );
    expect(expiryJobs).toHaveLength(1);
  });

  it('attach of a manual scenario only ensures expiry', async () => {
    const txn = await host.seedTxn();
    await host.ctx.engine.attach({ txn, ...manualScenario() });
    expect(await hasPendingJob(host.db, txn.id, 'scenario-step')).toBe(false);
    expect(await hasPendingJob(host.db, txn.id, 'session-expiry')).toBe(true);
  });

  it('moves the database clock forward, backward and to a wall time', async () => {
    const ws = host.workspace.id;
    const start = await host.clock.view(ws);
    expect(start.offsetMs).toBe(0);

    const forward = await host.clock.advance(ws, 60_000);
    expect(forward.offsetMs).toBe(60_000);
    expect(Date.parse(forward.now) - Date.now()).toBeGreaterThan(59_000);

    const back = await host.clock.advance(ws, -120_000);
    expect(back.offsetMs).toBe(-60_000);

    const target = new Date(Date.now() + 3_600_000);
    const set = await host.clock.setTime(ws, target);
    expect(Math.abs(Date.parse(set.now) - target.getTime())).toBeLessThan(5_000);

    const reset = await host.clock.reset(ws);
    expect(reset.offsetMs).toBe(0);
    expect(Math.abs(Date.parse(reset.now) - Date.now())).toBeLessThan(5_000);
  });
});
