import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { DEFAULT_WORKSPACE_KEY } from '@paysim/core';

import type { DbClock } from '../clock.js';
import type { Db } from '../db/client.js';
import type { EventBus } from '../events/bus.js';
import { shiftPendingJobs, type JobType } from '../jobs.js';
import type { Queries } from '../stores/drizzle-stores.js';
import { sendError, zodIssues } from './http.js';

/** Fake-timeline jobs shift on clock jumps; delivery retries never do. */
const SHIFTED_JOB_TYPES: JobType[] = ['scenario-step', 'session-expiry'];

export interface ClockDeps {
  db: Db;
  clock: DbClock;
  queries: Queries;
  bus: EventBus;
  /** Wake the scheduler: a jump may have made jobs due. */
  kick: () => void;
}

const WorkspaceQuerySchema = z.object({
  workspace: z.string().min(1).default(DEFAULT_WORKSPACE_KEY),
});

const AdvanceSchema = z.object({
  workspaceKey: z.string().min(1).default(DEFAULT_WORKSPACE_KEY),
  /** Milliseconds to move (negative moves backward). Capped at ±31 days. */
  ms: z
    .number()
    .int()
    .min(-31 * 24 * 60 * 60 * 1000)
    .max(31 * 24 * 60 * 60 * 1000),
});

const SetSchema = z.object({
  workspaceKey: z.string().min(1).default(DEFAULT_WORKSPACE_KEY),
  now: z.string().datetime({ offset: true }),
});

const ResetSchema = z.object({
  workspaceKey: z.string().min(1).default(DEFAULT_WORKSPACE_KEY),
});

export function createClockRouter(deps: ClockDeps): Router {
  const router = Router();

  async function workspaceKeyOr404(res: Response, key: string): Promise<string | null> {
    const workspace = await deps.queries.getWorkspaceByKey(key);
    if (!workspace) {
      sendError(res, 404, 'unknown_workspace');
      return null;
    }
    return workspace.id;
  }

  async function afterJump(
    workspaceKey: string,
    workspaceId: string,
    beforeMs: number,
    view: { offsetMs: number; now: string },
  ): Promise<{ jobsShifted: number }> {
    const jobsShifted = await shiftPendingJobs(
      deps.db,
      workspaceId,
      view.offsetMs - beforeMs,
      SHIFTED_JOB_TYPES,
    );
    deps.bus.publish({
      type: 'clock.changed',
      workspaceKey,
      data: { offsetMs: view.offsetMs, now: view.now, jobsShifted },
    });
    deps.kick();
    return { jobsShifted };
  }

  router.get('/', async (req: Request, res: Response) => {
    const parsed = WorkspaceQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', { issues: zodIssues(parsed.error) });
      return;
    }
    const workspaceId = await workspaceKeyOr404(res, parsed.data.workspace);
    if (!workspaceId) return;
    res.json({ workspaceKey: parsed.data.workspace, ...deps.clock.view(workspaceId) });
  });

  router.post('/advance', async (req: Request, res: Response) => {
    const parsed = AdvanceSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', { issues: zodIssues(parsed.error) });
      return;
    }
    const workspaceId = await workspaceKeyOr404(res, parsed.data.workspaceKey);
    if (!workspaceId) return;
    const beforeMs = deps.clock.offsetMs(workspaceId);
    const view = await deps.clock.advance(workspaceId, parsed.data.ms);
    const { jobsShifted } = await afterJump(parsed.data.workspaceKey, workspaceId, beforeMs, view);
    res.json({ workspaceKey: parsed.data.workspaceKey, ...view, jobsShifted });
  });

  router.put('/', async (req: Request, res: Response) => {
    const parsed = SetSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', { issues: zodIssues(parsed.error) });
      return;
    }
    const workspaceId = await workspaceKeyOr404(res, parsed.data.workspaceKey);
    if (!workspaceId) return;
    const beforeMs = deps.clock.offsetMs(workspaceId);
    const view = await deps.clock.setTime(workspaceId, new Date(parsed.data.now));
    const { jobsShifted } = await afterJump(parsed.data.workspaceKey, workspaceId, beforeMs, view);
    res.json({ workspaceKey: parsed.data.workspaceKey, ...view, jobsShifted });
  });

  router.post('/reset', async (req: Request, res: Response) => {
    const parsed = ResetSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', { issues: zodIssues(parsed.error) });
      return;
    }
    const workspaceId = await workspaceKeyOr404(res, parsed.data.workspaceKey);
    if (!workspaceId) return;
    const beforeMs = deps.clock.offsetMs(workspaceId);
    const view = await deps.clock.reset(workspaceId);
    const { jobsShifted } = await afterJump(parsed.data.workspaceKey, workspaceId, beforeMs, view);
    res.json({ workspaceKey: parsed.data.workspaceKey, ...view, jobsShifted });
  });

  return router;
}
