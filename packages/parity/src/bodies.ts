// Large-fixture body loader. Refs without a scheme resolve as files under
// a bodies root (small fixtures live in the repo next to the runner);
// s3://bucket/key refs fetch from object storage (large recordings).

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface BodyLoaderOptions {
  /** Filesystem root for bare refs. Required when a bare ref is loaded. */
  bodiesDir?: string;
  /** Region for s3:// refs (defaults to AWS_REGION). */
  s3Region?: string;
  /** Inject a fake client in tests. */
  s3?: Pick<S3Client, 'send'>;
}

function parseS3Ref(ref: string): { bucket: string; key: string } | null {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(ref.trim());
  if (!match) return null;
  return { bucket: match[1] as string, key: match[2] as string };
}

async function streamToString(body: unknown): Promise<string> {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  // AWS SDK v3 streaming blob: async-iterable of chunks.
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Load a jsonKey/shapeKey ref and parse it as JSON. */
export async function loadBodyJson(ref: string, options: BodyLoaderOptions): Promise<unknown> {
  const s3ref = parseS3Ref(ref);
  let text: string;
  if (s3ref) {
    const client =
      options.s3 ??
      new S3Client({ region: options.s3Region ?? process.env['AWS_REGION'] ?? 'auto' });
    const out = await client.send(new GetObjectCommand({ Bucket: s3ref.bucket, Key: s3ref.key }));
    const body = (out as { Body?: unknown }).Body;
    if (body === undefined) throw new Error(`s3://${s3ref.bucket}/${s3ref.key} has no Body`);
    text = await streamToString(body);
  } else {
    if (!options.bodiesDir) {
      throw new Error(`Body ref "${ref}" needs a bodies dir (pass --bodies-dir)`);
    }
    // resolve() keeps absolute refs working and contains relative ones.
    text = await readFile(resolve(options.bodiesDir, ref), 'utf8');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Body ref "${ref}" is not valid JSON`);
  }
}
