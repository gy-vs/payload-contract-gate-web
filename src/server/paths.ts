// Path utilities shared by the pipeline engine, the schema validator and the
// error attribution. Concrete paths (Seg[]) address one exact location in a
// document; patterns (PatSeg[]) describe what a step *could* write and may
// contain `[]` (every array element) and `{expr}` (runtime-decided) segments.

export type Seg = string | number;

export type PatSeg =
  | {kind: 'key'; key: string}
  | {kind: 'index'; index: number}
  | {kind: 'each'}
  | {kind: 'dynamic'; expr: string};

export type Pattern = {raw: string; segs: PatSeg[]; dynamic: boolean};

/** Parse a path template such as `attrs.{legacy.key}` or `items[].id`. */
export function parsePattern(raw: string): Pattern {
  const segs: PatSeg[] = [];
  let i = 0;
  let dynamic = false;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '.') { i++; continue; }
    if (c === '{') {
      const end = raw.indexOf('}', i);
      if (end < 0) throw new Error(`unclosed "{" in path "${raw}"`);
      segs.push({kind: 'dynamic', expr: raw.slice(i + 1, end)});
      dynamic = true;
      i = end + 1;
      continue;
    }
    if (c === '[') {
      const end = raw.indexOf(']', i);
      if (end < 0) throw new Error(`unclosed "[" in path "${raw}"`);
      const inner = raw.slice(i + 1, end);
      if (inner === '') segs.push({kind: 'each'});
      else {
        const n = Number(inner);
        if (!Number.isInteger(n) || n < 0) throw new Error(`bad index in path "${raw}"`);
        segs.push({kind: 'index', index: n});
      }
      i = end + 1;
      continue;
    }
    let key = '';
    while (i < raw.length && raw[i] !== '.' && raw[i] !== '[' && raw[i] !== '{') key += raw[i++];
    if (!key) throw new Error(`empty segment in path "${raw}"`);
    segs.push({kind: 'key', key});
  }
  if (segs.length === 0) throw new Error(`empty path`);
  return {raw, segs, dynamic};
}

/** Parse a path that must be concrete (no `[]` or `{expr}` segments). */
export function parsePath(raw: string): Seg[] {
  const pattern = parsePattern(raw);
  return pattern.segs.map(seg => {
    if (seg.kind === 'key') return seg.key;
    if (seg.kind === 'index') return seg.index;
    throw new Error(`path "${raw}" must be concrete`);
  });
}

export function renderPath(segs: Seg[]): string {
  let out = '';
  for (const seg of segs) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out ? `.${seg}` : seg;
  }
  return out || '(root)';
}

export function renderPattern(segs: PatSeg[]): string {
  let out = '';
  for (const seg of segs) {
    if (seg.kind === 'key') out += out ? `.${seg.key}` : seg.key;
    else if (seg.kind === 'index') out += `[${seg.index}]`;
    else if (seg.kind === 'each') out += '[]';
    else out += `${out ? '.' : ''}{${seg.expr}}`;
  }
  return out || '(root)';
}

/**
 * A pattern "covers" a concrete error path when the pattern is a prefix of it
 * (a write to an ancestor replaces the whole subtree, so prefix writes count).
 * Returns whether the match relied on a runtime-decided `{expr}` segment.
 */
export function covers(pattern: Pattern, path: Seg[]): {match: boolean; dynamic: boolean} {
  if (pattern.segs.length > path.length) return {match: false, dynamic: false};
  let dynamic = false;
  for (let k = 0; k < pattern.segs.length; k++) {
    const p = pattern.segs[k];
    const c = path[k];
    if (p.kind === 'dynamic') { dynamic = true; continue; }
    if (p.kind === 'each') { if (typeof c !== 'number') return {match: false, dynamic: false}; continue; }
    if (p.kind === 'index') { if (c !== p.index) return {match: false, dynamic: false}; continue; }
    if (c !== p.key) return {match: false, dynamic: false};
  }
  return {match: true, dynamic};
}

export function getAt(value: unknown, segs: Seg[]): unknown {
  let cur = value;
  for (const seg of segs) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg as string];
  }
  return cur;
}

/**
 * Write `value` at `segs`, creating missing plain objects along the way.
 * Never coerces an existing non-object intermediate (returns false instead)
 * so a corrupt parent is surfaced by the gate rather than silently replaced.
 */
export function setAt(doc: unknown, segs: Seg[], value: unknown): boolean {
  if (segs.length === 0) return false;
  let cur = doc;
  for (let k = 0; k < segs.length - 1; k++) {
    if (cur === null || typeof cur !== 'object') return false;
    const seg = segs[k];
    let next = (cur as Record<string, unknown>)[seg as string];
    if (next === undefined) {
      next = typeof segs[k + 1] === 'number' ? [] : {};
      (cur as Record<string, unknown>)[seg as string] = next;
    }
    if (next === null || typeof next !== 'object') return false;
    cur = next;
  }
  if (cur === null || typeof cur !== 'object') return false;
  (cur as Record<string, unknown>)[segs[segs.length - 1] as string] = value;
  return true;
}

export function deleteAt(doc: unknown, segs: Seg[]): boolean {
  if (segs.length === 0) return false;
  let cur = doc;
  for (let k = 0; k < segs.length - 1; k++) {
    if (cur === null || typeof cur !== 'object') return false;
    cur = (cur as Record<string, unknown>)[segs[k] as string];
  }
  if (cur === null || typeof cur !== 'object') return false;
  return delete (cur as Record<string, unknown>)[segs[segs.length - 1] as string];
}

export function deepClone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/** Deterministic stringify used for output fingerprints. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .filter(key => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}
