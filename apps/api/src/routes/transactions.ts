import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { DEFAULT_WORKSPACE_KEY, RefundError, ScenarioNotFoundError } from '@paysim/core';

import { ScenarioGatewayError, TerminalOverrideError } from '../engine.js';
import type { Queries } from '../stores/drizzle-stores.js';
import {
  DeliveryNotFoundError,
  TransactionNotFoundError,
  UnreplayableDeliveryError,
  RefundUnsupportedError,
  applyTxnScenario,
  refundTxn,
  replayDelivery,
  type TxnOpsDeps,
} from '../txn-ops.js';
import { sendError, zodIssues } from './http.js';

export interface TxnsDeps {
  queries: Queries;
  ops: TxnOpsDeps;
}

const ListQuerySchema = z.object({
  workspace: z.string().min(1).default(DEFAULT_WORKSPACE_KEY),
  gateway: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const IdParamSchema = z.object({ id: z.string().uuid() });

const OverrideSchema = z.object({ scenarioId: z.string().uuid().nullable() });

const ReplaySchema = z.object({ deliveryId: z.string().uuid().optional() });

const RefundSchema = z.object({
  amountMinor: z.number().int().positive().max(1_000_000_000),
  reason: z.string().max(255).optional(),
  idempotencyKey: z.string().min(1).max(64).optional(),
  simulateFailure: z.boolean().optional(),
});

export function createTxnsRouter(deps: TxnsDeps): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', { issues: zodIssues(parsed.error) });
      return;
    }
    const workspace = await deps.queries.getWorkspaceByKey(parsed.data.workspace);
    if (!workspace) {
      sendError(res, 404, 'unknown_workspace');
      return;
    }
    res.json(
      await deps.queries.listTransactions({
        workspaceKey: parsed.data.workspace,
        gateway: parsed.data.gateway,
        state: parsed.data.state,
        limit: parsed.data.limit,
      }),
    );
  });

  router.get('/:id', async (req: Request, res: Response) => {
    const idParam = req.params['id'];
    const detail = await deps.queries.getTransactionDetail(
      typeof idParam === 'string' ? idParam : '',
    );
    if (!detail) {
      sendError(res, 404, 'not_found');
      return;
    }
    res.json(detail);
  });

  router.post('/:id/scenario', async (req: Request, res: Response) => {
    const params = IdParamSchema.safeParse(req.params);
    const parsed = OverrideSchema.safeParse(req.body);
    if (!params.success || !parsed.success) {
      const issues = [
        ...(!params.success ? zodIssues(params.error) : []),
        ...(!parsed.success ? zodIssues(parsed.error) : []),
      ];
      sendError(res, 400, 'invalid_request', { issues });
      return;
    }
    try {
      res.json(await applyTxnScenario(deps.ops, params.data.id, parsed.data.scenarioId));
    } catch (err) {
      if (err instanceof TransactionNotFoundError) {
        sendError(res, 404, 'not_found');
        return;
      }
      if (err instanceof ScenarioNotFoundError) {
        sendError(res, 404, 'unknown_scenario', { message: err.message });
        return;
      }
      if (err instanceof ScenarioGatewayError) {
        sendError(res, 400, 'gateway_mismatch', { message: err.message });
        return;
      }
      if (err instanceof TerminalOverrideError) {
        sendError(res, 422, 'transaction_terminal', { message: err.message });
        return;
      }
      throw err;
    }
  });

  router.post('/:id/replay', async (req: Request, res: Response) => {
    const params = IdParamSchema.safeParse(req.params);
    const parsed = ReplaySchema.safeParse(req.body ?? {});
    if (!params.success || !parsed.success) {
      const issues = [
        ...(!params.success ? zodIssues(params.error) : []),
        ...(!parsed.success ? zodIssues(parsed.error) : []),
      ];
      sendError(res, 400, 'invalid_request', { issues });
      return;
    }
    try {
      res.json(await replayDelivery(deps.ops, params.data.id, parsed.data.deliveryId));
    } catch (err) {
      if (err instanceof TransactionNotFoundError || err instanceof DeliveryNotFoundError) {
        sendError(res, 404, 'not_found');
        return;
      }
      if (err instanceof UnreplayableDeliveryError) {
        sendError(res, 422, 'no_recorded_body', { message: err.message });
        return;
      }
      throw err;
    }
  });

  router.post('/:id/refunds', async (req: Request, res: Response) => {
    const params = IdParamSchema.safeParse(req.params);
    const parsed = RefundSchema.safeParse(req.body ?? {});
    if (!params.success || !parsed.success) {
      const issues = [
        ...(!params.success ? zodIssues(params.error) : []),
        ...(!parsed.success ? zodIssues(parsed.error) : []),
      ];
      sendError(res, 400, 'invalid_request', { issues });
      return;
    }
    try {
      const result = await refundTxn(deps.ops, params.data.id, parsed.data);
      res.status(result.replayed ? 200 : 201).json({
        refund: result.entry,
        ledger: result.ledger,
        replayed: result.replayed,
        txn: result.txn,
      });
    } catch (err) {
      if (err instanceof TransactionNotFoundError) {
        sendError(res, 404, 'not_found');
        return;
      }
      if (err instanceof RefundUnsupportedError) {
        sendError(res, 422, 'refund_unsupported', { message: err.message });
        return;
      }
      if (err instanceof RefundError) {
        sendError(res, err.code === 'reference_conflict' ? 409 : 422, err.code, {
          message: err.message,
        });
        return;
      }
      throw err;
    }
  });

  return router;
}
