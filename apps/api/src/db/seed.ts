import { DEFAULT_WORKSPACE_KEY } from '@paysim/core';
import { eq } from 'drizzle-orm';

import type { Db } from './client.js';
import { workspaces, type Workspace } from './schema.js';

/** Idempotently ensure the single local-mode workspace exists. */
export async function ensureDefaultWorkspace(db: Db): Promise<Workspace> {
  await db
    .insert(workspaces)
    .values({ key: DEFAULT_WORKSPACE_KEY, name: 'Local workspace' })
    .onConflictDoNothing({ target: workspaces.key });
  const rows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.key, DEFAULT_WORKSPACE_KEY))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error('Default workspace is missing after upsert');
  }
  return row;
}
