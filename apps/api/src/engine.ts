// ScenarioEngine implementation: resolve a scenario for a fresh
// transaction (magic value > app default > manual), then attach it —
// snapshot its steps into the first job and ensure the session-expiry
// timer. Dashboard overrides reuse attach() via applyScenarioOverride().

import {
  ScenarioDefinitionSchema,
  ScenarioNotFoundError,
  type AttachScenarioInput,
  type GatewayPlugin,
  type PluginLogger,
  type PluginStores,
  type ResolvedScenario,
  type ScenarioEngine,
  type TxnRecord,
} from '@paysim/core';

import type { Db } from './db/client.js';
import { cancelPendingJobsForTxn, hasPendingJob, scheduleJob, type JobType } from './jobs.js';
import { findScenarioByName, getScenarioById } from './scenarios.js';

export interface EngineDeps {
  db: Db;
  stores: PluginStores;
  logger: PluginLogger;
  /** Wake the scheduler after scheduling (wired by the host). */
  kick: () => void;
}

const SCENARIO_JOB_TYPES: JobType[] = ['scenario-step'];

export function manualScenario(): ResolvedScenario {
  return {
    scenarioId: null,
    definition: ScenarioDefinitionSchema.parse({ name: 'manual', steps: [] }),
    source: 'manual',
  };
}

export function createEngine(deps: EngineDeps): ScenarioEngine {
  return {
    async resolveForInit(input): Promise<ResolvedScenario> {
      if (input.magicName) {
        const row = await findScenarioByName(
          deps.db,
          input.workspaceId,
          input.gateway,
          input.magicName,
        );
        if (!row) throw new ScenarioNotFoundError(input.magicName);
        return { scenarioId: row.id, definition: row.definition, source: 'magic' };
      }
      if (input.defaultScenarioId) {
        const row = await getScenarioById(deps.db, input.defaultScenarioId);
        if (!row || (row.workspaceId !== null && row.workspaceId !== input.workspaceId)) {
          throw new Error(
            `App default scenario ${input.defaultScenarioId} does not exist in this workspace`,
          );
        }
        if (row.gateway !== input.gateway) {
          throw new Error(
            `App default scenario ${input.defaultScenarioId} belongs to ${row.gateway}, not ${input.gateway}`,
          );
        }
        return { scenarioId: row.id, definition: row.definition, source: 'default' };
      }
      return manualScenario();
    },

    async attach(input: AttachScenarioInput): Promise<void> {
      const { txn } = input;
      await deps.stores.recordEvent({
        workspaceId: txn.workspaceId,
        transactionId: txn.id,
        type: 'scenario.attached',
        data: {
          scenarioId: input.scenarioId,
          name: input.definition.name,
          source: input.source,
          stepCount: input.definition.steps.length,
        },
      });
      const first = input.definition.steps[0];
      if (first) {
        // Wall-clock run_at: fake and wall time advance together except
        // across jumps, and jumps shift pending jobs (shiftPendingJobs),
        // so wall-based delays are exactly fake-timeline-correct.
        await scheduleJob(deps.db, {
          workspaceId: txn.workspaceId,
          transactionId: txn.id,
          type: 'scenario-step',
          payload: {
            txnId: txn.id,
            scenarioId: input.scenarioId,
            scenarioName: input.definition.name,
            source: input.source,
            stepIndex: 0,
            steps: input.definition.steps,
          },
          runAt: new Date(Date.now() + first.delayMs),
        });
      }
      await ensureSessionExpiry(deps, txn);
      deps.kick();
    },
  };
}

/** Schedule the expiry timer once per transaction (idempotent). */
export async function ensureSessionExpiry(deps: EngineDeps, txn: TxnRecord): Promise<void> {
  if (!txn.expiresAt) return;
  if (await hasPendingJob(deps.db, txn.id, 'session-expiry')) return;
  await scheduleJob(deps.db, {
    workspaceId: txn.workspaceId,
    transactionId: txn.id,
    type: 'session-expiry',
    payload: { txnId: txn.id },
    runAt: new Date(txn.expiresAt),
  });
}

export interface ApplyOverrideDeps extends EngineDeps {
  engine: ScenarioEngine;
  plugins: GatewayPlugin[];
}

export class TerminalOverrideError extends Error {
  constructor(state: string) {
    super(`Transaction is already ${state}; scenarios only drive open transactions`);
    this.name = 'TerminalOverrideError';
  }
}

export class ScenarioGatewayError extends Error {
  constructor(scenarioId: string, scenarioGateway: string, txnGateway: string) {
    super(`Scenario ${scenarioId} belongs to ${scenarioGateway}, not ${txnGateway}`);
    this.name = 'ScenarioGatewayError';
  }
}

/**
 * Dashboard override: cancel the transaction's pending scenario jobs and
 * attach a new scenario (or detach back to manual with null).
 */
export async function applyScenarioOverride(
  deps: ApplyOverrideDeps,
  txn: TxnRecord,
  scenarioId: string | null,
): Promise<ResolvedScenario | null> {
  const plugin = deps.plugins.find((candidate) => candidate.name === txn.gateway);
  if (plugin?.isTerminalState(txn.state)) {
    throw new TerminalOverrideError(txn.state);
  }
  const cancelled = await cancelPendingJobsForTxn(deps.db, txn.id, SCENARIO_JOB_TYPES);
  deps.logger.info('scenario jobs cancelled for override', { txnId: txn.id, cancelled });
  if (scenarioId === null) {
    await deps.stores.recordEvent({
      workspaceId: txn.workspaceId,
      transactionId: txn.id,
      type: 'scenario.detached',
      data: {},
    });
    return null;
  }
  const row = await getScenarioById(deps.db, scenarioId);
  if (!row || (row.workspaceId !== null && row.workspaceId !== txn.workspaceId)) {
    throw new ScenarioNotFoundError(scenarioId);
  }
  if (row.gateway !== txn.gateway) {
    throw new ScenarioGatewayError(scenarioId, row.gateway, txn.gateway);
  }
  await deps.engine.attach({
    txn,
    scenarioId: row.id,
    definition: row.definition,
    source: 'override',
  });
  return { scenarioId: row.id, definition: row.definition, source: 'override' };
}
