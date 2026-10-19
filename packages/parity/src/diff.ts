// Recursive response-SHAPE diff. Returns human-readable mismatch lines
// (empty = match). Direction: expected = recorded shape, actual = sim.
//
// Placeholders (objects with a single $ key):
// - { "$any": "string"|"number"|"boolean"|"object"|"array"|"null" }
// - { "$regex": "<js pattern, partial match; anchor with ^$>" }
// - { "$optional": <subshape> } — valid only as an object property value;
//   a missing property matches, a present one diffs against <subshape>.
//
// Objects are strict both ways: missing expected keys and unexpected
// actual keys both mismatch (use $optional for volatile fields).
// Arrays: a single-item expected array is an item-shape applied to every
// actual element; otherwise exact length + pairwise diff.

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array[${value.length}]`;
  switch (typeof value) {
    case 'string':
      return value.length > 60 ? `"${value.slice(0, 57)}…"` : JSON.stringify(value);
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    case 'undefined':
      return 'undefined';
    default:
      return typeof value;
  }
}

function actualType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isPlaceholder(value: unknown): value is Record<string, unknown> {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === 1 &&
    (typeof value['$any'] === 'string' ||
      typeof value['$regex'] === 'string' ||
      '$optional' in value)
  );
}

function diffPlaceholder(
  expected: Record<string, unknown>,
  actual: unknown,
  path: string,
  out: string[],
): void {
  if (typeof expected['$any'] === 'string') {
    if (actualType(actual) !== expected['$any']) {
      out.push(`~ ${path}: expected $${String(expected['$any'])} (any), got ${describe(actual)}`);
    }
    return;
  }
  if (typeof expected['$regex'] === 'string') {
    if (typeof actual !== 'string') {
      out.push(
        `~ ${path}: expected string matching ${String(expected['$regex'])}, got ${describe(actual)}`,
      );
      return;
    }
    let pattern: RegExp;
    try {
      pattern = new RegExp(String(expected['$regex']));
    } catch {
      out.push(`! ${path}: invalid $regex ${describe(expected['$regex'])} in fixture`);
      return;
    }
    if (!pattern.test(actual)) {
      out.push(`~ ${path}: ${describe(actual)} does not match ${String(expected['$regex'])}`);
    }
    return;
  }
  // $optional reaching here means misuse (array item or root); treat as its
  // subshape so the failure message stays intelligible.
  diffValue(expected['$optional'], actual, path, out);
}

function diffObject(
  expected: Record<string, unknown>,
  actual: unknown,
  path: string,
  out: string[],
): void {
  if (!isPlainObject(actual)) {
    out.push(`~ ${path || '<root>'}: expected object, got ${describe(actual)}`);
    return;
  }
  for (const [key, sub] of Object.entries(expected)) {
    const child = path === '' ? key : `${path}.${key}`;
    if (!(key in actual)) {
      if (isPlainObject(sub) && '$optional' in sub && Object.keys(sub).length === 1) continue;
      out.push(`- ${child}: missing, expected ${describe(sub)}`);
      continue;
    }
    const subActual: unknown = actual[key];
    if (isPlainObject(sub) && '$optional' in sub && Object.keys(sub).length === 1) {
      diffValue(sub['$optional'], subActual, child, out);
    } else {
      diffValue(sub, subActual, child, out);
    }
  }
  for (const key of Object.keys(actual)) {
    if (!(key in expected)) {
      out.push(
        `+ ${path === '' ? key : `${path}.${key}`}: unexpected, got ${describe(actual[key])}`,
      );
    }
  }
}

function diffArray(expected: unknown[], actual: unknown, path: string, out: string[]): void {
  if (!Array.isArray(actual)) {
    out.push(`~ ${path || '<root>'}: expected array[${expected.length}], got ${describe(actual)}`);
    return;
  }
  // Single-item expectation = per-item shape (unless actual also has exactly 1).
  if (expected.length === 1 && actual.length !== 1) {
    const item = expected[0];
    actual.forEach((entry: unknown, index: number) => {
      diffValue(item, entry, `${path || '<root>'}[${index}]`, out);
    });
    return;
  }
  if (actual.length !== expected.length) {
    out.push(
      `~ ${path || '<root>'}: expected array[${expected.length}], got array[${actual.length}]`,
    );
    return;
  }
  expected.forEach((item: unknown, index: number) => {
    diffValue(item, actual[index], `${path || '<root>'}[${index}]`, out);
  });
}

function diffValue(expected: unknown, actual: unknown, path: string, out: string[]): void {
  if (isPlaceholder(expected)) {
    diffPlaceholder(expected, actual, path === '' ? '<root>' : path, out);
    return;
  }
  if (isPlainObject(expected)) {
    diffObject(expected, actual, path, out);
    return;
  }
  if (Array.isArray(expected)) {
    diffArray(expected, actual, path, out);
    return;
  }
  if (!Object.is(expected, actual)) {
    out.push(
      `~ ${path === '' ? '<root>' : path}: expected ${describe(expected)}, got ${describe(actual)}`,
    );
  }
}

/** Diff an expected shape against an actual parsed-JSON response. */
export function diffShape(expected: unknown, actual: unknown): string[] {
  const out: string[] = [];
  diffValue(expected, actual, '', out);
  return out;
}
