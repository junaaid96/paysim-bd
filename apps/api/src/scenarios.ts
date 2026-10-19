// Scenario persistence shared by the engine and the dashboard routes.
// Workspace rows shadow global presets (workspace_id NULL) by name.

import { and, asc, eq, isNull } from 'drizzle-orm';

import { ScenarioDefinitionSchema, type ScenarioDefinition } from '@paysim/core';

import type { Db } from './db/client.js';
import { scenarios, type Scenario } from './db/schema.js';

export interface ScenarioRow {
  id: string;
  workspaceId: string | null;
  gateway: string;
  name: string;
  definition: ScenarioDefinition;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export class DuplicateScenarioError extends Error {
  constructor(gateway: string, name: string) {
    super(`Scenario ${gateway}/${name} already exists in this workspace`);
    this.name = 'DuplicateScenarioError';
  }
}

/** Built-in global presets are read-only through the API. */
export class BuiltinScenarioError extends Error {
  constructor() {
    super('Built-in scenarios are read-only');
    this.name = 'BuiltinScenarioError';
  }
}

function toRow(row: Scenario): ScenarioRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    gateway: row.gateway,
    name: row.name,
    // Written through zod validation, so a parse failure here means the
    // stored JSON was corrupted — fail loudly, never run half a scenario.
    definition: ScenarioDefinitionSchema.parse(row.definition),
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Workspace-specific row wins; otherwise the global preset. */
export async function findScenarioByName(
  db: Db,
  workspaceId: string,
  gateway: string,
  name: string,
): Promise<ScenarioRow | null> {
  const own = await db
    .select()
    .from(scenarios)
    .where(
      and(
        eq(scenarios.workspaceId, workspaceId),
        eq(scenarios.gateway, gateway),
        eq(scenarios.name, name),
      ),
    )
    .limit(1);
  if (own[0]) return toRow(own[0]);
  const global = await db
    .select()
    .from(scenarios)
    .where(
      and(isNull(scenarios.workspaceId), eq(scenarios.gateway, gateway), eq(scenarios.name, name)),
    )
    .orderBy(asc(scenarios.createdAt))
    .limit(1);
  return global[0] ? toRow(global[0]) : null;
}

export async function getScenarioById(db: Db, id: string): Promise<ScenarioRow | null> {
  const rows = await db.select().from(scenarios).where(eq(scenarios.id, id)).limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function getGlobalScenario(
  db: Db,
  gateway: string,
  name: string,
): Promise<ScenarioRow | null> {
  const rows = await db
    .select()
    .from(scenarios)
    .where(
      and(isNull(scenarios.workspaceId), eq(scenarios.gateway, gateway), eq(scenarios.name, name)),
    )
    .limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function listScenarios(
  db: Db,
  workspaceId: string,
  gateway?: string,
): Promise<ScenarioRow[]> {
  const conditions = [gateway ? eq(scenarios.gateway, gateway) : undefined].filter(
    (c) => c !== undefined,
  );
  const rows = await db
    .select()
    .from(scenarios)
    .where(and(...conditions))
    .orderBy(asc(scenarios.gateway), asc(scenarios.name));
  return rows
    .filter((row) => row.workspaceId === null || row.workspaceId === workspaceId)
    .map(toRow);
}

export interface CreateScenarioInput {
  workspaceId: string;
  gateway: string;
  name: string;
  definition: ScenarioDefinition;
}

export async function createScenario(db: Db, input: CreateScenarioInput): Promise<ScenarioRow> {
  const existing = await db
    .select({ id: scenarios.id })
    .from(scenarios)
    .where(
      and(
        eq(scenarios.workspaceId, input.workspaceId),
        eq(scenarios.gateway, input.gateway),
        eq(scenarios.name, input.name),
      ),
    )
    .limit(1);
  if (existing.length > 0) throw new DuplicateScenarioError(input.gateway, input.name);
  const rows = await db
    .insert(scenarios)
    .values({
      workspaceId: input.workspaceId,
      gateway: input.gateway,
      name: input.name,
      definition: { ...input.definition, name: input.name },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('Failed to insert scenario');
  return toRow(row);
}

export interface UpdateScenarioInput {
  name?: string;
  definition?: ScenarioDefinition;
}

export async function updateScenario(
  db: Db,
  id: string,
  input: UpdateScenarioInput,
): Promise<ScenarioRow | null> {
  const current = await getScenarioById(db, id);
  if (!current) return null;
  if (current.workspaceId === null) throw new BuiltinScenarioError();
  const name = input.name ?? current.name;
  if (name !== current.name) {
    const clash = await db
      .select({ id: scenarios.id })
      .from(scenarios)
      .where(
        and(
          eq(scenarios.workspaceId, current.workspaceId),
          eq(scenarios.gateway, current.gateway),
          eq(scenarios.name, name),
        ),
      )
      .limit(1);
    if (clash.length > 0) throw new DuplicateScenarioError(current.gateway, name);
  }
  const definition = input.definition ?? current.definition;
  const rows = await db
    .update(scenarios)
    .set({ name, definition: { ...definition, name } })
    .where(eq(scenarios.id, id))
    .returning();
  const row = rows[0];
  return row ? toRow(row) : null;
}

export async function deleteScenario(db: Db, id: string): Promise<ScenarioRow | null> {
  const current = await getScenarioById(db, id);
  if (!current) return null;
  if (current.workspaceId === null) throw new BuiltinScenarioError();
  await db.delete(scenarios).where(eq(scenarios.id, id));
  return current;
}
