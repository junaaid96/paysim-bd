// Fixture file schema (v1). A fixture is a recorded request/response flow:
// ordered HTTP steps against a running simulator, each asserting status +
// response SHAPE (see diff.ts). Later steps reuse earlier responses via
// {{variables}} captured with dotted paths ("a.b.0.c").
//
// Sources are honesty labels, and the badge rule keys off them:
// - "docs-sample": transcribed from official doc samples. Proves the sim
//   matches the docs, not the real sandbox. Caps the badge at docs-only.
// - "community-sample": transcribed from community SDKs/captures. Caps at
//   docs-only and is weaker evidence (community code may itself be wrong).
// - "real-sandbox": recorded against the vendor's real sandbox. Only this
//   can promote a gateway to "verified" (see badges.ts).

import { z } from 'zod';

export const FixtureSourceSchema = z.enum(['docs-sample', 'community-sample', 'real-sandbox']);
export type FixtureSource = z.infer<typeof FixtureSourceSchema>;

export const FixtureSetupAppSchema = z
  .object({
    gateway: z.string().min(1),
    name: z.string().min(1),
    credentials: z.record(z.string(), z.unknown()),
  })
  .strict();
export type FixtureSetupApp = z.infer<typeof FixtureSetupAppSchema>;

export const FixtureRequestSchema = z
  .object({
    method: z.enum(['GET', 'POST']),
    /** Path; may contain {{variables}} from earlier captures. */
    path: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    /** Inline JSON body (mutually exclusive with jsonKey). */
    json: z.unknown().optional(),
    /** Storage ref for a large JSON body (fs path or s3://bucket/key). */
    jsonKey: z.string().min(1).optional(),
    /** application/x-www-form-urlencoded body. */
    form: z.record(z.string(), z.string()).optional(),
  })
  .strict()
  .refine((value) => !(value.json !== undefined && value.jsonKey !== undefined), {
    message: 'json and jsonKey are mutually exclusive',
  })
  .refine((value) => !(value.json !== undefined && value.form !== undefined), {
    message: 'json and form are mutually exclusive',
  })
  .refine((value) => !(value.jsonKey !== undefined && value.form !== undefined), {
    message: 'jsonKey and form are mutually exclusive',
  });
export type FixtureRequest = z.infer<typeof FixtureRequestSchema>;

export const FixtureExpectSchema = z
  .object({
    status: z.number().int().min(100).max(599),
    /** Inline expected shape (mutually exclusive with shapeKey). */
    shape: z.unknown().optional(),
    /** Storage ref for a large expected shape. */
    shapeKey: z.string().min(1).optional(),
  })
  .strict()
  .refine((value) => !(value.shape !== undefined && value.shapeKey !== undefined), {
    message: 'shape and shapeKey are mutually exclusive',
  });
export type FixtureExpect = z.infer<typeof FixtureExpectSchema>;

export const FixtureStepSchema = z
  .object({
    name: z.string().min(1),
    /**
     * "METHOD path-template" strings copied verbatim from the gateway's
     * spec/vN.json. Drives badge coverage (see badges.ts).
     */
    covers: z.array(z.string().min(1)).default([]),
    request: FixtureRequestSchema,
    expect: FixtureExpectSchema,
    /** variable name -> dotted capture path in the JSON response. */
    capture: z.record(z.string(), z.string().min(1)).default({}),
  })
  .strict();
export type FixtureStep = z.infer<typeof FixtureStepSchema>;

export const FixtureFileSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1),
    gateway: z.string().min(1),
    source: FixtureSourceSchema,
    sourceUrl: z.string().url().optional(),
    notes: z.string().optional(),
    /**
     * Merchant app to create via POST /api/apps before step 1 (409 =
     * already exists, tolerated). The server fake-guards credentials.
     */
    setupApp: FixtureSetupAppSchema.optional(),
    steps: z.array(FixtureStepSchema).min(1),
  })
  .strict();
export type FixtureFile = z.infer<typeof FixtureFileSchema>;

/** Normalize "method path" coverage keys for comparison. */
export function normalizeCoverageKey(raw: string): string {
  const [method, ...rest] = raw.trim().split(/\s+/);
  return `${(method ?? '').toUpperCase()} ${rest.join(' ')}`;
}
