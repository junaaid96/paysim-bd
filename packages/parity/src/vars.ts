// {{variable}} substitution for requests and dotted-path capture from
// responses. Captured values keep their JSON type; a request string that
// is exactly "{{name}}" splices the raw value, embedded occurrences are
// stringified. Unknown variables fail loudly (fixture bug, not a diff).

export type Vars = Map<string, unknown>;

const VAR_PATTERN = /\{\{(\$?[A-Za-z0-9_]+)\}\}/g;

export function substituteString(template: string, vars: Vars): unknown {
  const exact = /^\{\{(\$?[A-Za-z0-9_]+)\}\}$/.exec(template);
  if (exact) {
    const name = exact[1] as string;
    if (!vars.has(name)) throw new Error(`Unknown variable {{${name}}} (no capture produced it)`);
    return vars.get(name);
  }
  return template.replace(VAR_PATTERN, (_match, name: string) => {
    if (!vars.has(name)) throw new Error(`Unknown variable {{${name}}} (no capture produced it)`);
    const value = vars.get(name);
    return typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null');
  });
}

/** Recursively substitute {{variables}} in any JSON-ish request value. */
export function substitute<T>(value: T, vars: Vars): T {
  if (typeof value === 'string') return substituteString(value, vars) as T;
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, vars)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[String(substituteString(key, vars))] = substitute(entry, vars);
    }
    return out as T;
  }
  return value;
}

/**
 * Read a dotted capture path ("a.b.0.c"; numeric segments index arrays).
 * Throws on any missing hop so fixtures fail loudly instead of capturing
 * undefined.
 */
export function capturePath(root: unknown, path: string): unknown {
  let current: unknown = root;
  const segments = path.split('.');
  for (const segment of segments) {
    if (current === null || current === undefined) {
      throw new Error(`Capture path "${path}" hits null/undefined at "${segment}"`);
    }
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) {
        throw new Error(`Capture path "${path}": "${segment}" is not an array index`);
      }
      const index = Number(segment);
      if (index >= current.length) {
        throw new Error(`Capture path "${path}": index ${index} out of bounds`);
      }
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') {
      throw new Error(`Capture path "${path}": cannot descend into ${typeof current}`);
    }
    const record = current as Record<string, unknown>;
    if (!(segment in record)) {
      throw new Error(`Capture path "${path}": missing key "${segment}"`);
    }
    current = record[segment];
  }
  return current;
}
