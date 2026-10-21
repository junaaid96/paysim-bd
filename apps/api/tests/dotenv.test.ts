// The API must load the repo-root .env even though pnpm --filter runs it
// with cwd=apps/api (bare dotenv.config() misses the root file entirely).
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { dotenvPaths } from '../src/dotenv.js';

describe('dotenvPaths', () => {
  it('resolves package .env first, then the repo-root .env', () => {
    const fakeModule = join(process.cwd(), 'src', 'dotenv.ts');
    const [packageEnv, rootEnv] = dotenvPaths(pathToFileURL(fakeModule));
    expect(packageEnv).toBe(join(process.cwd(), '.env'));
    // From apps/api, the repo root is two levels up.
    expect(rootEnv).toBe(join(dirname(dirname(process.cwd())), '.env'));
  });
});
