// Declarative scenarios: ordered steps of {delay, action}. Definitions are
// zod-validated; the API scheduler executes them. Selection order (highest
// first): per-transaction dashboard override, magic init values, app default.

import { z } from 'zod';

export const SCENARIO_ACTIONS = [
  'redirect_success',
  'redirect_cancel',
  'redirect_fail',
  'send_ipn',
  'send_ipn_duplicate',
  'send_ipn_late',
  'mutate_amount',
  'stay_pending',
  'settle_later',
  'timeout',
] as const;
export type ScenarioAction = (typeof SCENARIO_ACTIONS)[number];

export const ScenarioStepSchema = z.object({
  /** Wait after the previous step before running this one. */
  delayMs: z
    .number()
    .int()
    .min(0)
    .max(24 * 60 * 60 * 1000)
    .default(0),
  action: z.enum(SCENARIO_ACTIONS),
  params: z.record(z.string(), z.unknown()).default({}),
});
export type ScenarioStep = z.infer<typeof ScenarioStepSchema>;

export const ScenarioDefinitionSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  steps: z.array(ScenarioStepSchema).max(50),
});
export type ScenarioDefinition = z.infer<typeof ScenarioDefinitionSchema>;
/** Authoring shape (defaults apply at validation). */
export type ScenarioDefinitionInput = z.input<typeof ScenarioDefinitionSchema>;

/**
 * Magic init marker: `<field>="SIM:<scenario-name>"` selects a scenario.
 * Which init field carries it is per-gateway (SSLCommerz: value_d).
 */
export const MAGIC_VALUE_PREFIX = 'SIM:';

/** Thrown when a magic scenario name matches nothing (init must fail loud). */
export class ScenarioNotFoundError extends Error {
  public readonly scenarioName: string;
  constructor(scenarioName: string) {
    super(`Unknown scenario: ${scenarioName}`);
    this.name = 'ScenarioNotFoundError';
    this.scenarioName = scenarioName;
  }
}

/**
 * Extract a scenario name from a magic marker: `SIM:<name>` with an
 * optional `:<suffix>` (e.g. `SIM:immediate-success:run-42`) so merchants
 * can keep unique order ids across repeated sim runs.
 */
export function parseMagicScenario(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!value.startsWith(MAGIC_VALUE_PREFIX)) return null;
  const rest = value.slice(MAGIC_VALUE_PREFIX.length).trim();
  const name = rest.split(':')[0]?.trim() ?? '';
  return name.length > 0 ? name : null;
}
