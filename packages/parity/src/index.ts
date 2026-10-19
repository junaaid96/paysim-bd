// @paysim/parity: replay recorded request/response fixtures against a
// running simulator and diff response shape. See fixtures/ and badges.ts
// for the honesty labels and the verified-badge rule.

export { evaluateBadges } from './badges.js';
export type { BadgeReport, GatewaySpecSummary, GatewayVerdict } from './badges.js';
export { loadBodyJson } from './bodies.js';
export type { BodyLoaderOptions } from './bodies.js';
export { diffShape } from './diff.js';
export { discoverFixtures } from './discover.js';
export type { DiscoveredFixture } from './discover.js';
export {
  FixtureExpectSchema,
  FixtureFileSchema,
  FixtureRequestSchema,
  FixtureSetupAppSchema,
  FixtureSourceSchema,
  FixtureStepSchema,
  normalizeCoverageKey,
} from './fixture.js';
export type {
  FixtureExpect,
  FixtureFile,
  FixtureRequest,
  FixtureSetupApp,
  FixtureSource,
  FixtureStep,
} from './fixture.js';
export { runFixture } from './run.js';
export type { FixtureResult, RunFixtureOptions, StepFailure } from './run.js';
export { capturePath, substitute, substituteString } from './vars.js';
export type { Vars } from './vars.js';
