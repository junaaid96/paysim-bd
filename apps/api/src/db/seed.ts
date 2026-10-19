import {
  DEFAULT_WORKSPACE_KEY,
  ScenarioDefinitionSchema,
  assertFakeCredentials,
  type AppRecord,
  type GatewayPlugin,
  type PluginStores,
} from '@paysim/core';
import { eq } from 'drizzle-orm';

import { getGlobalScenario } from '../scenarios.js';
import type { Queries } from '../stores/drizzle-stores.js';
import type { Db } from './client.js';
import { scenarios, workspaces, type Workspace } from './schema.js';

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

export interface SeedAppDeps {
  queries: Queries;
  stores: PluginStores;
}

/** Idempotently seed one sandbox app with the plugin's fake credentials. */
export async function ensureDefaultGatewayApp(
  deps: SeedAppDeps,
  workspace: Workspace,
  plugin: GatewayPlugin,
): Promise<AppRecord> {
  const checked = plugin.validateCredentials(plugin.defaultCredentials);
  if (!checked.ok) {
    throw new Error(
      `Default credentials for ${plugin.name} are invalid: ${checked.issues.join('; ')}`,
    );
  }
  assertFakeCredentials(
    [...plugin.spec.sandboxHosts, ...plugin.spec.productionHosts],
    checked.value,
  );
  const storeId = checked.value[plugin.storeIdField];
  const existing =
    typeof storeId === 'string'
      ? await deps.stores.findAppByStoreId(plugin.name, plugin.storeIdField, storeId)
      : null;
  if (existing) return existing;
  return deps.queries.createApp({
    workspaceId: workspace.id,
    gateway: plugin.name,
    name: `${plugin.displayName} sandbox app`,
    credentials: checked.value,
  });
}

/**
 * Idempotently seed every plugin's built-in scenarios as global presets.
 * Each definition is zod-validated here so bad authoring fails the boot,
 * not a transaction.
 */
export async function ensureBuiltinScenarios(db: Db, plugins: GatewayPlugin[]): Promise<number> {
  let seeded = 0;
  for (const plugin of plugins) {
    for (const builtin of plugin.builtinScenarios) {
      const definition = ScenarioDefinitionSchema.parse(builtin);
      const existing = await getGlobalScenario(db, plugin.name, definition.name);
      if (existing) continue;
      await db.insert(scenarios).values({
        workspaceId: null,
        gateway: plugin.name,
        name: definition.name,
        definition,
      });
      seeded += 1;
    }
  }
  return seeded;
}
