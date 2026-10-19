import { describe, expect, it } from 'vitest';

import { diffShape } from '../src/diff.js';

describe('diffShape', () => {
  it('matches identical structures', () => {
    expect(
      diffShape({ a: 1, b: 'x', c: null, d: [1, 2] }, { a: 1, b: 'x', c: null, d: [1, 2] }),
    ).toEqual([]);
    expect(diffShape('SUCCESS', 'SUCCESS')).toEqual([]);
  });

  it('reports missing, unexpected and mismatched values with paths', () => {
    const diffs = diffShape(
      { keep: 1, gone: 2, nested: { x: 'a' }, num: 5 },
      { keep: 1, extra: true, nested: { x: 'b' }, num: '5' },
    );
    expect(diffs).toContain('- gone: missing, expected 2');
    expect(diffs).toContain('+ extra: unexpected, got true');
    expect(diffs).toContain('~ nested.x: expected "a", got "b"');
    expect(diffs).toContain('~ num: expected 5, got "5"');
  });

  it('supports $any type placeholders', () => {
    expect(diffShape({ t: { $any: 'string' } }, { t: 'abc' })).toEqual([]);
    expect(diffShape({ t: { $any: 'number' } }, { t: 'abc' })).toEqual([
      '~ t: expected $number (any), got "abc"',
    ]);
    expect(diffShape({ t: { $any: 'array' } }, { t: [1] })).toEqual([]);
    expect(diffShape({ t: { $any: 'null' } }, { t: null })).toEqual([]);
  });

  it('supports $regex partial matching', () => {
    expect(diffShape({ u: { $regex: 'SESSIONKEY=' } }, { u: 'https://x/?SESSIONKEY=1' })).toEqual(
      [],
    );
    expect(diffShape({ u: { $regex: '^[0-9A-F]{32}$' } }, { u: 'ZZZ' })).toHaveLength(1);
    expect(diffShape({ u: { $regex: '([' } }, { u: 'x' })[0]).toMatch(/invalid \$regex/);
    expect(diffShape({ u: { $regex: 'x' } }, { u: 5 })[0]).toMatch(/expected string matching/);
  });

  it('supports $optional object properties', () => {
    const shape = { a: 1, b: { $optional: { $any: 'string' } } };
    expect(diffShape(shape, { a: 1 })).toEqual([]);
    expect(diffShape(shape, { a: 1, b: 'ok' })).toEqual([]);
    expect(diffShape(shape, { a: 1, b: 5 })).toEqual(['~ b: expected $string (any), got 5']);
  });

  it('treats single-item arrays as per-item shapes', () => {
    const item = { name: { $any: 'string' } };
    expect(diffShape([item], [{ name: 'a' }, { name: 'b' }])).toEqual([]);
    const diffs = diffShape([item], [{ name: 'a' }, { name: 1 }]);
    expect(diffs).toEqual(['~ <root>[1].name: expected $string (any), got 1']);
  });

  it('diffs tuples pairwise with exact length', () => {
    expect(diffShape([1, 2], [1, 2])).toEqual([]);
    expect(diffShape([1, 2], [1])).toEqual(['~ <root>: expected array[2], got array[1]']);
    expect(diffShape([1, 2], [1, 3])).toEqual(['~ <root>[1]: expected 2, got 3']);
  });

  it('flags type changes at the root', () => {
    expect(diffShape({ a: 1 }, [1])).toEqual(['~ <root>: expected object, got array[1]']);
    expect(diffShape([1], { a: 1 })).toEqual(['~ <root>: expected array[1], got object']);
  });
});
