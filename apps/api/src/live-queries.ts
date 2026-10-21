import { rawSql } from '@neon/realtime/server';

import type { ActivityRow } from '@paysim/core';

/** Newest events in a workspace, with transaction context. Read-only and deterministic. */
export function activityQuery(workspaceKey: string) {
  return rawSql<ActivityRow>(
    `SELECT e.id, e.type, e.created_at, e.transaction_id,
       t.gateway, t.state, t.gateway_txn_id, t.amount_minor, t.currency
     FROM events e
     INNER JOIN transactions t ON t.id = e.transaction_id
     INNER JOIN workspaces w ON w.id = e.workspace_id
     WHERE w.key = $1
     ORDER BY e.created_at DESC
     LIMIT 30`,
    [workspaceKey],
  );
}

/** Database name from a Postgres connection string (Realtime binds to one db). */
export function dbNameFromUrl(connectionString: string): string {
  const name = new URL(connectionString).pathname.replace(/^\//, '');
  return name === '' ? 'neondb' : name;
}
