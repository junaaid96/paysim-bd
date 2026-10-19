import { describe, expect, it } from 'vitest';

import {
  ScenarioDefinitionSchema,
  ScenarioStepSchema,
  parseMagicScenario,
} from '../src/scenario.js';

describe('ScenarioStepSchema', () => {
  it('defaults delay and params', () => {
    expect(ScenarioStepSchema.parse({ action: 'send_ipn' })).toEqual({
      delayMs: 0,
      action: 'send_ipn',
      params: {},
    });
  });

  it('rejects unknown actions, negative delays and huge delays', () => {
    expect(() => ScenarioStepSchema.parse({ action: 'explode' })).toThrow();
    expect(() => ScenarioStepSchema.parse({ action: 'send_ipn', delayMs: -1 })).toThrow();
    expect(() =>
      ScenarioStepSchema.parse({ action: 'send_ipn', delayMs: 25 * 60 * 60 * 1000 }),
    ).toThrow();
  });
});

describe('ScenarioDefinitionSchema', () => {
  it('accepts an empty manual scenario', () => {
    const parsed = ScenarioDefinitionSchema.parse({ name: 'manual', steps: [] });
    expect(parsed.steps).toEqual([]);
  });

  it('caps step counts', () => {
    const steps = Array.from({ length: 51 }, () => ({ action: 'send_ipn' }));
    expect(() => ScenarioDefinitionSchema.parse({ name: 'x', steps })).toThrow();
  });
});

describe('parseMagicScenario', () => {
  it('extracts SIM: names', () => {
    expect(parseMagicScenario('SIM:duplicate-ipn')).toBe('duplicate-ipn');
    expect(parseMagicScenario('SIM: spaced ')).toBe('spaced');
  });

  it('accepts an optional :suffix for unique order ids', () => {
    expect(parseMagicScenario('SIM:immediate-success:run-42')).toBe('immediate-success');
    expect(parseMagicScenario('SIM:immediate-success:')).toBe('immediate-success');
  });

  it('ignores non-magic values', () => {
    expect(parseMagicScenario('ref001')).toBeNull();
    expect(parseMagicScenario('SIM:')).toBeNull();
    expect(parseMagicScenario('SIM:   ')).toBeNull();
    expect(parseMagicScenario('SIM::suffix-only')).toBeNull();
    expect(parseMagicScenario(42)).toBeNull();
    expect(parseMagicScenario(undefined)).toBeNull();
  });
});
