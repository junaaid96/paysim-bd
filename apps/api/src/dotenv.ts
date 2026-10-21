// Central .env loader for API entrypoints.
//
// `pnpm --filter` runs scripts with cwd=apps/api, so a bare
// dotenv.config() only reads apps/api/.env and never the repo-root .env
// the README tells you to create. Resolve both files relative to this
// module instead of the cwd: package-local .env first (highest priority),
// then the repo root. dotenv never overrides already-set variables, so
// real environment (Docker, CI, Vercel) always wins, and missing files
// are silently skipped.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

/** .env search paths for a module living directly under the API src/ dir. */
export function dotenvPaths(moduleUrl: string | URL): [packageEnv: string, rootEnv: string] {
  const srcDir = dirname(fileURLToPath(moduleUrl));
  const packageDir = join(srcDir, '..');
  return [join(packageDir, '.env'), join(packageDir, '..', '..', '.env')];
}

const [packageEnv, rootEnv] = dotenvPaths(import.meta.url);
dotenv.config({ path: packageEnv });
dotenv.config({ path: rootEnv });
