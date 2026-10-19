// Rejects anything that looks like REAL gateway infrastructure or
// production credentials. Simulator credentials must be obviously fake.
// NOTE: merchant callback URLs (success/fail/cancel/ipn) are EXEMPT — they
// are the user's own endpoints (usually localhost), governed by the SSRF
// guard, not by this module.

export class FakeCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FakeCredentialError';
  }
}

const PRODUCTION_WORD = /\b(live|prod|production)\b/i;

export function assertFakeValue(knownHosts: readonly string[], value: unknown, what: string): void {
  if (typeof value !== 'string') return;
  const lower = value.toLowerCase();
  for (const host of knownHosts) {
    if (lower.includes(host.toLowerCase())) {
      throw new FakeCredentialError(
        `${what} references real gateway infrastructure (${host}); simulator credentials must be obviously fake`,
      );
    }
  }
  if (PRODUCTION_WORD.test(value)) {
    throw new FakeCredentialError(
      `${what} looks like a production credential; simulator credentials must be obviously fake`,
    );
  }
}

/** Recursively inspect every string in a credentials object. */
export function assertFakeCredentials(
  knownHosts: readonly string[],
  credentials: Record<string, unknown>,
): void {
  const visit = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      assertFakeValue(knownHosts, value, `credential ${path}`);
    } else if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
    } else if (value !== null && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) visit(entry, `${path}.${key}`);
    }
  };
  for (const [key, value] of Object.entries(credentials)) visit(value, key);
}
