// In-process scheduler over the persisted jobs table. Design for Neon
// scale-to-zero: exactly ONE timer, armed only for the earliest pending
// job and disarmed when the queue empties — an idle simulator issues no
// queries at all. Anything overdue runs on boot (start) and on kick
// (job scheduled, clock jumped). Claiming always uses wall-clock time;
// job run_at values are wall-clock too, and fake-clock jumps shift the
// pending scenario/expiry jobs so delays stay fake-timeline-correct.

import type { GatewayPlugin, PluginContext, PluginLogger } from '@paysim/core';

import type { Db } from './db/client.js';
import type { Job } from './db/schema.js';
import type { AttemptInput } from './deliver.js';
import {
  DeliveryRetryPayloadSchema,
  ScenarioStepPayloadSchema,
  SessionExpiryPayloadSchema,
  claimDueJobs,
  markJobDone,
  markJobFailed,
  nextPendingRunAt,
  reclaimRunningJobs,
  scheduleJob,
  type DeliveryRetryPayload,
  type ScenarioStepPayload,
  type SessionExpiryPayload,
} from './jobs.js';

/** Largest setTimeout delay; longer waits re-arm on fire. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface SchedulerDeps {
  db: Db;
  /** Shared host context used for plugin runScenarioAction calls. */
  ctx: PluginContext;
  logger: PluginLogger;
  plugins: GatewayPlugin[];
  /** Execute one delivery attempt (wired to deliver.ts by the host). */
  runRetry: (input: AttemptInput & { attempt: number }) => Promise<unknown>;
}

export class Scheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;
  private kickQueued = false;
  private stopped = false;

  constructor(private readonly deps: SchedulerDeps) {}

  /** Reclaim crashed jobs, run everything overdue, arm the timer. */
  async start(): Promise<void> {
    const reclaimed = await reclaimRunningJobs(this.deps.db);
    if (reclaimed > 0) {
      this.deps.logger.info('reclaimed interrupted jobs', { count: reclaimed });
    }
    await this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Wake the scheduler: run due jobs now, re-arm for the rest. */
  kick(): void {
    if (this.stopped) return;
    if (this.ticking) {
      this.kickQueued = true;
      return;
    }
    this.tick().catch((err: unknown) => {
      this.deps.logger.error('scheduler tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /** Test hook: run one synchronous pass over due jobs. */
  async runDueNow(): Promise<void> {
    await this.processDue();
  }

  private armFor(next: Date | null): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.stopped || !next) return;
    const delay = Math.min(Math.max(next.getTime() - Date.now(), 0), MAX_TIMER_DELAY_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick();
    }, delay);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    this.ticking = true;
    try {
      do {
        this.kickQueued = false;
        await this.processDue();
      } while (this.kickQueued && !this.stopped);
    } finally {
      this.ticking = false;
    }
    if (!this.stopped) {
      this.armFor(await nextPendingRunAt(this.deps.db));
    }
  }

  private async processDue(): Promise<void> {
    const due = await claimDueJobs(this.deps.db, new Date());
    for (const job of due) {
      if (this.stopped) return;
      await this.execute(job);
    }
  }

  private pluginFor(gateway: string): GatewayPlugin {
    const plugin = this.deps.plugins.find((candidate) => candidate.name === gateway);
    if (!plugin) throw new Error(`No plugin loaded for gateway ${gateway}`);
    return plugin;
  }

  private async execute(job: Job): Promise<void> {
    try {
      switch (job.type) {
        case 'scenario-step':
          await this.runScenarioStep(ScenarioStepPayloadSchema.parse(job.payload));
          break;
        case 'session-expiry':
          await this.runSessionExpiry(SessionExpiryPayloadSchema.parse(job.payload));
          break;
        case 'delivery-retry':
          await this.runDeliveryRetry(DeliveryRetryPayloadSchema.parse(job.payload));
          break;
        default:
          throw new Error(`Unknown job type: ${job.type}`);
      }
      await markJobDone(this.deps.db, job.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await markJobFailed(this.deps.db, job.id, message);
      this.deps.logger.error('job failed', { jobId: job.id, type: job.type, error: message });
      if (job.transactionId) {
        await this.deps.ctx.stores
          .recordEvent({
            workspaceId: job.workspaceId,
            transactionId: job.transactionId,
            type: 'job.failed',
            data: { jobId: job.id, jobType: job.type, error: message },
          })
          .catch(() => undefined);
      }
    }
  }

  private async runScenarioStep(payload: ScenarioStepPayload): Promise<void> {
    const { stores } = this.deps.ctx;
    const txn = await stores.getTransaction(payload.txnId);
    if (!txn) return;
    const plugin = this.pluginFor(txn.gateway);
    const ended = async (reason: string, extra: Record<string, unknown> = {}): Promise<void> => {
      await stores.recordEvent({
        workspaceId: txn.workspaceId,
        transactionId: txn.id,
        type: 'scenario.ended',
        data: { scenarioName: payload.scenarioName, reason, ...extra },
      });
    };
    // No terminal guard here on purpose: post-completion steps (duplicate /
    // late IPN) are MEANT to run on settled transactions. Plugins skip
    // inapplicable actions tolerantly per the contract.
    const step = payload.steps[payload.stepIndex];
    if (!step) {
      throw new Error(
        `Scenario ${payload.scenarioName} has no step at index ${payload.stepIndex} (snapshot corrupt)`,
      );
    }
    const app = await stores.getApp(txn.gatewayAppId);
    if (!app) throw new Error(`Gateway app ${txn.gatewayAppId} is missing`);
    if (step.action === 'settle_later') {
      // Engine-level: the step's own delay already elapsed while this job
      // waited, so settle inline and end the scenario here.
      await plugin.runScenarioAction(this.deps.ctx, txn, app, 'redirect_success', {});
      await ended('settled');
      return;
    }
    await plugin.runScenarioAction(this.deps.ctx, txn, app, step.action, step.params);
    if (step.action === 'stay_pending') {
      await ended('stay_pending');
      return;
    }
    const next = payload.steps[payload.stepIndex + 1];
    if (!next) {
      await ended('completed');
      return;
    }
    await scheduleJob(this.deps.db, {
      workspaceId: txn.workspaceId,
      transactionId: txn.id,
      type: 'scenario-step',
      payload: { ...payload, stepIndex: payload.stepIndex + 1 },
      runAt: new Date(Date.now() + next.delayMs),
    });
  }

  private async runSessionExpiry(payload: SessionExpiryPayload): Promise<void> {
    const { stores } = this.deps.ctx;
    const txn = await stores.getTransaction(payload.txnId);
    if (!txn) return;
    const plugin = this.pluginFor(txn.gateway);
    if (plugin.isTerminalState(txn.state)) return;
    const app = await stores.getApp(txn.gatewayAppId);
    if (!app) throw new Error(`Gateway app ${txn.gatewayAppId} is missing`);
    await plugin.runScenarioAction(this.deps.ctx, txn, app, 'timeout', {});
  }

  private async runDeliveryRetry(payload: DeliveryRetryPayload): Promise<void> {
    const txn = await this.deps.ctx.stores.getTransaction(payload.txnId);
    if (!txn) return;
    await this.deps.runRetry({
      txn,
      kind: payload.kind,
      targetUrl: payload.targetUrl,
      payload: payload.payload,
      attempt: payload.attempt,
    });
  }
}
