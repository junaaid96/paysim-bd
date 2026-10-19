import { describe, expect, it } from 'vitest';

import { capturePath, substitute, substituteString, type Vars } from '../src/vars.js';

function vars(entries: [string, unknown][] = []): Vars {
  return new Map(entries);
}

describe('substitute', () => {
  it('splices exact matches raw and embeds stringified', () => {
    const v = vars([
      ['id', 'abc'],
      ['n', 42],
    ]);
    expect(substituteString('{{id}}', v)).toBe('abc');
    expect(substituteString('{{n}}', v)).toBe(42);
    expect(substituteString('id-{{id}}-{{n}}', v)).toBe('id-abc-42');
  });

  it('recurses through objects and arrays', () => {
    const v = vars([['t', 'X']]);
    expect(substitute({ a: ['{{t}}', 1], b: { c: 'v={{t}}' } }, v)).toEqual({
      a: ['X', 1],
      b: { c: 'v=X' },
    });
  });

  it('fails loudly on unknown variables', () => {
    expect(() => substituteString('{{nope}}', vars())).toThrow(/Unknown variable {{nope}}/);
    expect(() => substituteString('a-{{nope}}', vars())).toThrow(/Unknown variable {{nope}}/);
  });
});

describe('capturePath', () => {
  const body = { a: { b: [{ c: 'hit' }] }, n: 7 };

  it('reads dotted paths with array indices', () => {
    expect(capturePath(body, 'a.b.0.c')).toBe('hit');
    expect(capturePath(body, 'n')).toBe(7);
  });

  it('fails loudly on missing hops', () => {
    expect(() => capturePath(body, 'a.zzz')).toThrow(/missing key "zzz"/);
    expect(() => capturePath(body, 'a.b.3')).toThrow(/out of bounds/);
    expect(() => capturePath(body, 'a.b.x')).toThrow(/not an array index/);
    expect(() => capturePath(body, 'n.deeper')).toThrow(/cannot descend/);
    expect(() => capturePath(null, 'a')).toThrow(/null\/undefined/);
  });
});
