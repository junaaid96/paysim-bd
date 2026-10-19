import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GetObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';

import { loadBodyJson } from '../src/bodies.js';

describe('loadBodyJson', () => {
  it('loads bare refs from the bodies dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parity-bodies-'));
    writeFileSync(join(dir, 'shape.json'), JSON.stringify({ a: 1 }));
    await expect(loadBodyJson('shape.json', { bodiesDir: dir })).resolves.toEqual({ a: 1 });
    await expect(loadBodyJson('shape.json', {})).rejects.toThrow(/needs a bodies dir/);
  });

  it('rejects non-JSON bodies loudly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parity-bodies-'));
    writeFileSync(join(dir, 'bad.json'), '{nope');
    await expect(loadBodyJson('bad.json', { bodiesDir: dir })).rejects.toThrow(/not valid JSON/);
  });

  it('fetches s3:// refs through the injected client', async () => {
    const seen: string[] = [];
    const fake = {
      send: async (command: unknown) => {
        const input = (command as GetObjectCommand).input;
        seen.push(`${String(input.Bucket)}/${String(input.Key)}`);
        async function* chunks(): AsyncGenerator<Uint8Array> {
          yield Buffer.from(JSON.stringify({ from: 's3' }));
        }
        return { Body: chunks() };
      },
    };
    await expect(loadBodyJson('s3://recordings/big/shape.json', { s3: fake })).resolves.toEqual({
      from: 's3',
    });
    expect(seen).toEqual(['recordings/big/shape.json']);
  });
});
