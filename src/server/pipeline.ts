import {
  PatSeg,
  Pattern,
  Seg,
  deepClone,
  deleteAt,
  getAt,
  parsePath,
  parsePattern,
  renderPattern,
  setAt,
} from './paths';

// A transform step. `set`/`rename`/`delete` address static paths, `map`
// applies sub-steps to every element of an array, and `dynamicSet` writes to
// a path that is only known at runtime (`{expr}` segments read from the doc).
export type Step = {
  id: string;
  name: string;
  kind: 'set' | 'rename' | 'delete' | 'map' | 'dynamicSet';
  path?: string;
  from?: string;
  value?: unknown;
  pathTemplate?: string;
  item?: Step[];
};

export type StepSummary = {
  id: string;
  name: string;
  order: number;
  reads: string[];
  writes: Pattern[];
};

function applyStep(doc: unknown, step: Step): void {
  switch (step.kind) {
    case 'set': {
      const hasFrom = typeof step.from === 'string' && step.from.length > 0;
      const value = hasFrom ? getAt(doc, parsePath(step.from!)) : step.value;
      if (hasFrom && value === undefined) return; // missing source: no-op
      setAt(doc, parsePath(step.path!), deepClone(value));
      return;
    }
    case 'rename': {
      const value = getAt(doc, parsePath(step.from!));
      if (value === undefined) return;
      if (setAt(doc, parsePath(step.path!), value)) deleteAt(doc, parsePath(step.from!));
      return;
    }
    case 'delete': {
      deleteAt(doc, parsePath(step.path!));
      return;
    }
    case 'map': {
      const arr = getAt(doc, parsePath(step.path!));
      if (!Array.isArray(arr)) return;
      for (const element of arr) for (const sub of step.item ?? []) applyStep(element, sub);
      return;
    }
    case 'dynamicSet': {
      const pattern = parsePattern(step.pathTemplate!);
      const concrete: Seg[] = [];
      for (const seg of pattern.segs) {
        if (seg.kind === 'dynamic') {
          const key = getAt(doc, parsePath(seg.expr));
          if (typeof key !== 'string' && typeof key !== 'number') return; // unresolvable: no-op
          concrete.push(String(key));
        } else if (seg.kind === 'key') {
          concrete.push(seg.key);
        } else {
          return; // `[]`/index segments are not supported in templates
        }
      }
      const hasFrom = typeof step.from === 'string' && step.from.length > 0;
      const value = hasFrom ? getAt(doc, parsePath(step.from!)) : step.value;
      if (hasFrom && value === undefined) return;
      setAt(doc, concrete, deepClone(value));
      return;
    }
  }
}

export function runPipeline(steps: Step[], input: unknown): unknown {
  const doc = deepClone(input);
  for (const step of steps) applyStep(doc, step);
  return doc;
}

function prefixed(prefix: PatSeg[], raw: string): Pattern {
  const pattern = parsePattern(raw);
  const segs = [...prefix, ...pattern.segs];
  return {raw: renderPattern(segs), segs, dynamic: segs.some(seg => seg.kind === 'dynamic')};
}

/**
 * Static read/write path summary for a step. This is the only input the error
 * attribution uses, so it deliberately keeps dynamic segments dynamic instead
 * of guessing concrete paths.
 */
export function summarizeStep(step: Step, order: number): StepSummary {
  const reads: string[] = [];
  const writes: Pattern[] = [];
  const collect = (current: Step, prefix: PatSeg[]): void => {
    const read = (raw: string) => reads.push(prefixed(prefix, raw).raw);
    const write = (raw: string) => writes.push(prefixed(prefix, raw));
    switch (current.kind) {
      case 'set':
        if (current.from) read(current.from);
        write(current.path!);
        break;
      case 'rename':
        read(current.from!);
        write(current.path!);
        write(current.from!); // rename also removes the source path
        break;
      case 'delete':
        write(current.path!);
        break;
      case 'map': {
        read(current.path!);
        const base: PatSeg[] = [...parsePattern(current.path!).segs, {kind: 'each'}];
        for (const sub of current.item ?? []) collect(sub, [...prefix, ...base]);
        break;
      }
      case 'dynamicSet': {
        if (current.from) read(current.from);
        for (const seg of parsePattern(current.pathTemplate!).segs) {
          if (seg.kind === 'dynamic') read(seg.expr);
        }
        write(current.pathTemplate!);
        break;
      }
    }
  };
  collect(step, []);
  return {id: step.id, name: step.name, order, reads, writes};
}

/** Validate a step definition coming over the wire. Returns an error message or null. */
export function stepProblem(step: unknown, depth = 0): string | null {
  if (step === null || typeof step !== 'object' || Array.isArray(step)) return 'step must be an object';
  const s = step as Step;
  if (typeof s.id !== 'string' || !s.id) return 'step.id is required';
  if (typeof s.name !== 'string' || !s.name) return 'step.name is required';
  const isPath = (p: unknown): p is string => {
    if (typeof p !== 'string' || !p) return false;
    try { parsePattern(p); return true; } catch { return false; }
  };
  switch (s.kind) {
    case 'set':
      if (!isPath(s.path)) return 'set.path must be a valid path';
      if (s.from !== undefined && !isPath(s.from)) return 'set.from must be a valid path';
      return null;
    case 'rename':
      if (!isPath(s.from) || !isPath(s.path)) return 'rename requires valid from and path';
      return null;
    case 'delete':
      if (!isPath(s.path)) return 'delete.path must be a valid path';
      return null;
    case 'map': {
      if (depth > 0) return 'nested map steps are not supported';
      if (!isPath(s.path)) return 'map.path must be a valid path';
      if (!Array.isArray(s.item)) return 'map.item must be an array of sub-steps';
      for (const sub of s.item) {
        if (sub?.kind === 'map' || sub?.kind === 'dynamicSet') return 'map sub-steps must be set/rename/delete';
        const problem = stepProblem(sub, depth + 1);
        if (problem) return problem;
      }
      return null;
    }
    case 'dynamicSet':
      if (depth > 0) return 'dynamicSet is not supported inside map';
      if (!isPath(s.pathTemplate)) return 'dynamicSet.pathTemplate must be a valid path template';
      if (s.from !== undefined && !isPath(s.from)) return 'dynamicSet.from must be a valid path';
      return null;
    default:
      return `unknown step kind "${String(s.kind)}"`;
  }
}
