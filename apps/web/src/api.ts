import { z } from 'zod';

// Mirrors the API's HealthResponseSchema; API responses are validated at the
// boundary instead of trusted.
export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  now: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch('/api/health');
  if (!res.ok) {
    throw new Error(`API health check failed: HTTP ${res.status}`);
  }
  return HealthResponseSchema.parse(await res.json());
}
