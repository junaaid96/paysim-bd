import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// Parity runs against live deployments; they must never move a workspace's
// fake clock (or touch any other dashboard-only state).
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe('parity safety', () => {
  it('never calls the clock API from fixtures or the runner', () => {
    const root = join(__dirname, '..');
    const sources = [...files(join(root, 'fixtures')), ...files(join(root, 'src'))];
    for (const path of sources) {
      expect(readFileSync(path, 'utf8'), path).not.toMatch(/\/api\/clock/);
    }
  });
});
