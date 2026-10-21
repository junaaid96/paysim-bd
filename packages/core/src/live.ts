import { z } from 'zod';

/**
 * One row of the live activity feed: the workspace's newest payment events
 * with transaction context. Shared by the API (seals the live query) and the
 * dashboard (subscribes to it). `created_at` is the decoded timestamptz.
 */
export const ActivityRowSchema = z.object({
  id: z.string(),
  type: z.string(),
  created_at: z.date(),
  transaction_id: z.string(),
  gateway: z.string(),
  state: z.string(),
  gateway_txn_id: z.string().nullable(),
  amount_minor: z.number(),
  currency: z.string(),
});
export type ActivityRow = z.infer<typeof ActivityRowSchema>;
