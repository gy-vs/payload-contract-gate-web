import {describe, expect, it} from 'vitest';
import {coverKind, errorPath, parsePath} from '../src/server/paths';

function cover(write: string, errorPathText: string, required: boolean) {
  return coverKind(parsePath(write), errorPath(errorPathText, required));
}

describe('coverKind', () => {
  it('matches exact static writes (value and required)', () => {
    expect(cover('$.a.b', '$.a.b', false)?.kind).toBe('exact');
    expect(cover('$.a.b', '$.a.b', true)?.certainty).toBe('definite');
  });

  it('matches ancestor writes as parent replacement', () => {
    expect(cover('$.a', '$.a.b.c', false)?.kind).toBe('parent');
    expect(cover('$.a', '$.a.b', true)?.kind).toBe('parent');
  });

  it('does not let a child write explain an error on its parent', () => {
    expect(cover('$.a.b.c', '$.a', false)).toBeNull();
    expect(cover('$.a.b.c', '$.a', true)).toBeNull();
  });

  it('treats wildcard element writes as definite covers', () => {
    expect(cover('$.items[*].sku', '$.items[2].sku', false)?.kind).toBe('wildcard');
    expect(cover('$.items[*].sku', '$.items[2].sku', false)?.certainty).toBe('definite');
    expect(cover('$.items[*]', '$.items', true)?.kind).toBe('wildcard-parent');
  });

  it('treats dynamic expressions only as candidates', () => {
    const c = cover('$.tags["x_"+$.k]', '$.tags.x_1', false);
    expect(c?.kind).toBe('dynamic');
    expect(c?.certainty).toBe('candidate');
    // required under a dynamic prefix: the container exists only if the mapping ran.
    const r = cover('$.tags[$.k].id', '$.tags.foo.id', true);
    expect(r?.kind).toBe('dynamic-required');
    expect(r?.certainty).toBe('candidate');
  });

  it('does not match a wildcard against a missing token', () => {
    expect(cover('$.items[*]', '$.items', false)).toBeNull();
  });
});
