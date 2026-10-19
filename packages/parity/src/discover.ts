// Fixture discovery: <root>/<gateway>/*.json, parsed + validated.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { FixtureFileSchema, type FixtureFile } from './fixture.js';

export interface DiscoveredFixture {
  path: string;
  fixture: FixtureFile;
}

export async function discoverFixtures(
  root: string,
  gateways: string[] | null = null,
): Promise<DiscoveredFixture[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (gateways && !gateways.includes(entry.name)) continue;
    const dir = join(root, entry.name);
    for (const file of await readdir(dir)) {
      if (file.endsWith('.json')) files.push(join(dir, file));
    }
  }
  files.sort();
  const out: DiscoveredFixture[] = [];
  for (const path of files) {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    const parsed = FixtureFileSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new Error(
        `Invalid fixture ${path}: ${first?.path.join('.') || '(root)'} ${first?.message ?? ''}`,
      );
    }
    out.push({ path, fixture: parsed.data });
  }
  return out;
}
