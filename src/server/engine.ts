import type {
  Attribution,
  AttributionReason,
  GateError,
  Json,
  PipelineDef,
  SampleGateResult,
  SchemaObject,
  StepDef,
  StepPathSummary,
} from '../shared/types';
import {evalExpr, extractPaths, readByTokens, truthy} from './expr';
import {coverKind, errorPath, parsePath, renderTokens, summarizePath} from './paths';
import type {PathToken} from './paths';
import type {RawError} from './validator';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/* --------------------------------- summary -------------------------------- */

export function stepSummary(step: StepDef, index: number): StepPathSummary {
  const writes = Object.keys(step.map ?? {}).map(summarizePath);
  const reads = new Map<string, ReturnType<typeof summarizePath>>();
  for (const source of Object.values(step.map ?? {})) {
    for (const p of extractPaths(source)) {
      if (!reads.has(p)) reads.set(p, summarizePath(p));
    }
  }
  if (step.when) {
    for (const p of extractPaths(step.when)) {
      if (!reads.has(p)) reads.set(p, summarizePath(p));
    }
  }
  return {
    stepId: step.id,
    index,
    title: step.title ?? step.id,
    reads: [...reads.values()],
    writes,
  };
}

export function pipelineSummary(pipeline: PipelineDef): StepPathSummary[] {
  return pipeline.steps.map((step, index) => stepSummary(step, index));
}

/* -------------------------------- execution ------------------------------- */

type Container = Json[] | Record<string, Json>;
type VarTok = Extract<PathToken, {kind: 'wild' | 'dynamic'}>;
type Locals = Record<string, Json>;

function isContainer(v: Json | undefined): v is Container {
  return typeof v === 'object' && v !== null;
}

function isVarTok(tok: PathToken | undefined): tok is VarTok {
  return !!tok && (tok.kind === 'wild' || tok.kind === 'dynamic');
}

/** Split tokens into fixed runs separated by wildcard/dynamic tokens (vars.length + 1 runs). */
function segments(tokens: PathToken[]): {fixed: PathToken[][]; vars: VarTok[]} {
  const fixed: PathToken[][] = [[]];
  const vars: VarTok[] = [];
  for (const tok of tokens) {
    if (isVarTok(tok)) {
      vars.push(tok);
      fixed.push([]);
    } else {
      fixed[fixed.length - 1].push(tok);
    }
  }
  return {fixed, vars};
}
// Note: a path with N var tokens yields exactly N+1 fixed runs (the last may be empty),
// e.g. $.items[*].qty  -> fixed: [[items],[qty]] -> vars:[*] -> runs [[items],[qty]]
//      $.items[*]      -> fixed: [[items],[]]

function readRun(value: Json, run: PathToken[], locals: Locals): Json | undefined {
  let current: Json = value;
  for (const tok of run) {
    const next = readByTokens(current, [tok], locals);
    if (next === undefined) return undefined;
    current = next;
  }
  return current;
}

function assignKey(container: Container, tok: PathToken, value: Json, root: Json, locals: Locals): boolean {
  if (tok.kind === 'key') {
    if (Array.isArray(container)) return false;
    container[tok.name] = clone(value);
    return true;
  }
  if (tok.kind === 'index') {
    if (!Array.isArray(container)) return false;
    container[tok.value] = clone(value);
    return true;
  }
  if (tok.kind === 'dynamic') {
    const key = evalExpr(tok.expr, root, locals);
    if (typeof key === 'number' && Array.isArray(container)) {
      container[key] = clone(value);
      return true;
    }
    if (typeof key === 'string' && !Array.isArray(container)) {
      container[key] = clone(value);
      return true;
    }
  }
  return false;
}

/** Materialize the containers of a fixed run; the node feeding a [*] is made an array. */
function ensureRun(parent: Container, run: PathToken[], nextVar: VarTok | undefined): Container | null {
  let current: Json = parent;
  for (let i = 0; i < run.length; i++) {
    const tok = run[i];
    const needArray = i === run.length - 1 && nextVar?.kind === 'wild';
    if (tok.kind === 'key') {
      if (!isContainer(current) || Array.isArray(current)) return null;
      if (!isContainer(current[tok.name])) current[tok.name] = needArray ? [] : {};
      current = current[tok.name];
    } else if (tok.kind === 'index') {
      if (!Array.isArray(current)) return null;
      if (!isContainer(current[tok.value])) current[tok.value] = needArray ? [] : {};
      current = current[tok.value];
    } else {
      return null;
    }
  }
  return isContainer(current) ? current : null;
}

function staticCopy(input: Json, outputRoot: Json, srcTokens: PathToken[], dstTokens: PathToken[]): boolean {
  const value = readRun(input, srcTokens, {});
  if (value === undefined) return false;
  let parent: Json = outputRoot;
  for (const tok of dstTokens.slice(0, -1)) {
    if (tok.kind === 'key') {
      if (!isContainer(parent) || Array.isArray(parent)) return false;
      if (!isContainer(parent[tok.name])) parent[tok.name] = {};
      parent = parent[tok.name];
    } else if (tok.kind === 'index') {
      if (!Array.isArray(parent)) return false;
      if (!isContainer(parent[tok.value])) parent[tok.value] = {};
      parent = parent[tok.value];
    } else {
      return false;
    }
  }
  const last = dstTokens[dstTokens.length - 1];
  if (!last || isVarTok(last)) return false;
  if (last.kind === 'index') {
    if (!Array.isArray(parent)) return false;
    parent[last.value] = clone(value); // whole-subtree replacement
  } else {
    if (!isContainer(parent) || Array.isArray(parent)) return false;
    parent[last.name] = clone(value);
  }
  return true;
}

/* -------------------------------- fan-out --------------------------------- */

type MapEntry = {dest: string; source: string; dstTokens: PathToken[]; srcTokens: PathToken[]};

/**
 * Entries walking the same source collection into the same dest collection are one group, so
 * $.lines[*].sku -> $.items[*].sku and $.lines[*].quantity -> $.items[*].qty merge onto the
 * same dest elements (aligned by iteration index).
 */
function groupKey(entry: MapEntry): string {
  const dVar = entry.dstTokens.findIndex(isVarTok);
  const sVar = entry.srcTokens.findIndex(isVarTok);
  const dPrefix = renderTokens(entry.dstTokens.slice(0, dVar + 1));
  const sPrefix = sVar >= 0 ? renderTokens(entry.srcTokens.slice(0, sVar + 1)) : '$';
  return `${sPrefix}=>${dPrefix}`;
}

type Iter = {key: Json; elem: Json; locals: Locals};

function sourceIterations(root: Json, container: Json, varTok: VarTok | undefined, locals: Locals): Iter[] {
  if (varTok) {
    if (!isContainer(container)) return [];
    const out: Iter[] = [];
    if (varTok.kind === 'wild') {
      if (!Array.isArray(container)) return [];
      container.forEach((elem, index) => out.push({key: index, elem, locals: {...locals, k: index}}));
      return out;
    }
    for (const [name, elem] of Object.entries(container)) {
      const l = {...locals, k: name};
      const computed = evalExpr(varTok.expr, root, l);
      if (computed !== name && computed !== Number(name)) continue;
      out.push({key: name, elem, locals: l});
    }
    return out;
  }
  // Source side has no variable here: a scalar feeds one leaf; a container is enumerated so
  // expressions can key off each member (k = member name / index).
  if (!isContainer(container)) return [{key: '', elem: container, locals}];
  const out: Iter[] = [];
  const items: [Json, Json][] = Array.isArray(container)
    ? container.map((v, i) => [i, v])
    : Object.entries(container);
  for (const [name, elem] of items) out.push({key: name, elem, locals: {...locals, k: name}});
  return out;
}

/** Fetch/create the dest container for one iteration's variable token. */
function destSlot(parent: Container, varTok: VarTok, iterationKey: Json, root: Json, locals: Locals): Container | null {
  if (varTok.kind === 'wild') {
    if (!Array.isArray(parent)) return null;
    const index = typeof iterationKey === 'number' ? iterationKey : parent.length;
    if (!isContainer(parent[index])) parent[index] = {};
    return parent[index];
  }
  const key = evalExpr(varTok.expr, root, locals);
  if (key === undefined || key === null) return null;
  if (typeof key === 'number') {
    if (!Array.isArray(parent)) return null;
    if (!isContainer(parent[key])) parent[key] = {};
    return parent[key];
  }
  if (typeof key !== 'string' || Array.isArray(parent)) return null;
  if (!isContainer(parent[key])) parent[key] = {};
  return parent[key];
}

function writeLeaf(root: Json, value: Json, dstParent: Container, tail: PathToken[], locals: Locals): boolean {
  let parent: Json = dstParent;
  for (const tok of tail.slice(0, -1)) {
    if (tok.kind === 'key') {
      if (!isContainer(parent) || Array.isArray(parent)) return false;
      if (!isContainer(parent[tok.name])) parent[tok.name] = {};
      parent = parent[tok.name];
    } else if (tok.kind === 'index') {
      if (!Array.isArray(parent)) return false;
      if (!isContainer(parent[tok.value])) parent[tok.value] = {};
      parent = parent[tok.value];
    } else {
      return false;
    }
  }
  const last = tail[tail.length - 1];
  const ok = last && isContainer(parent) ? assignKey(parent, last, value, root, locals) : false;
  return ok;
}

function walkEntry(root: Json, output: Json, entry: MapEntry): boolean {
  const sSeg = segments(entry.srcTokens);
  const dSeg = segments(entry.dstTokens);
  const levels = dSeg.vars.length;
  let written = false;

  const recurse = (level: number, srcElem: Json, dstMerged: Container | null, locals: Locals): void => {
    // Source container/value for this level.
    let srcContainer: Json;
    let srcVar: VarTok | undefined;
    if (level < sSeg.vars.length) {
      const resolved = readRun(srcElem, sSeg.fixed[level], locals);
      if (resolved === undefined) return;
      srcContainer = resolved;
      srcVar = sSeg.vars[level];
    } else if (level === 0 && sSeg.vars.length === 0) {
      // Source path is fully static: resolve it once from the root.
      const resolved = readRun(srcElem, sSeg.fixed[0], locals);
      if (resolved === undefined) return;
      srcContainer = resolved;
      srcVar = undefined;
    } else {
      srcContainer = srcElem;
      srcVar = undefined;
    }

    // Dest base for this level (the container the variable token indexes).
    let destBase: Container | null;
    if (level === 0) {
      destBase = ensureRun(output as Container, dSeg.fixed[0], dSeg.vars[0]);
    } else if (dstMerged) {
      destBase = dSeg.fixed[level].length
        ? ensureRun(dstMerged, dSeg.fixed[level], dSeg.vars[level])
        : dstMerged;
    } else {
      destBase = null;
    }
    if (!destBase) return;

    const iterations = sourceIterations(root, srcContainer, srcVar, locals);
    if (iterations.length === 0) return;
    // A carried scalar source can only feed the final leaf.
    if (!srcVar && level + 1 < levels) return;

    for (const it of iterations) {
      const carriedElem = it.elem;
      const tail = dSeg.fixed[levels];
      // With zero source variables, fixed[0] was already resolved into srcContainer above,
      // so there is no tail run left to read.
      const srcTailRun = sSeg.vars.length === 0 ? [] : sSeg.fixed[sSeg.vars.length];
      const valueAtLeaf =
        level + 1 === levels && srcTailRun && srcTailRun.length
          ? readRun(carriedElem, srcTailRun, it.locals)
          : level + 1 === levels
            ? carriedElem
            : undefined;

      if (level + 1 === levels && (!tail || tail.length === 0)) {
        // Value lands exactly at the variable slot: assign parent[key] directly (scalar leaf).
        if (valueAtLeaf !== undefined && assignKey(destBase, dSeg.vars[level], valueAtLeaf, root, it.locals)) {
          written = true;
        }
        continue;
      }

      // Container element for this iteration; group entries reuse it by iteration key.
      const slot = destSlot(destBase, dSeg.vars[level], it.key, root, it.locals);
      if (!slot) continue;

      if (level + 1 === levels) {
        if (valueAtLeaf !== undefined && writeLeaf(root, valueAtLeaf, slot, tail, it.locals)) written = true;
      } else {
        recurse(level + 1, carriedElem, slot, it.locals);
      }
    }
  };

  recurse(0, root, null, {});
  return written;
}

/* ------------------------------ public runner ------------------------------ */

export type RunResult = {
  output: Json;
  executedStepIds: string[];
  writesByStep: Record<string, string[]>;
};

export function runPipeline(pipeline: PipelineDef, input: Json): RunResult {
  const output: Json = {};
  const executedStepIds: string[] = [];
  const writesByStep: Record<string, string[]> = {};

  pipeline.steps.forEach((step) => {
    if (step.when && !truthy(evalExpr(step.when, input))) return;
    executedStepIds.push(step.id);
    const written: string[] = [];
    const fanEntries: MapEntry[] = [];

    for (const [dest, source] of Object.entries(step.map ?? {})) {
      const dstTokens = parsePath(dest);
      const srcTokens = parsePath(source);
      if (dstTokens.every((t) => !isVarTok(t)) && srcTokens.every((t) => !isVarTok(t))) {
        if (staticCopy(input, output, srcTokens, dstTokens)) written.push(dest);
      } else if (dstTokens.some(isVarTok)) {
        fanEntries.push({dest, source, dstTokens, srcTokens});
      }
    }

    const groups = new Map<string, MapEntry[]>();
    for (const e of fanEntries) {
      const list = groups.get(groupKey(e)) ?? [];
      list.push(e);
      groups.set(groupKey(e), list);
    }
    for (const list of groups.values()) {
      let groupWritten = false;
      for (const entry of list) {
        if (walkEntry(input, output, entry)) groupWritten = true;
      }
      if (groupWritten) written.push(...list.map((e) => e.dest));
    }

    writesByStep[step.id] = written;
  });

  return {output, executedStepIds, writesByStep};
}

/* ------------------------------- attribution ------------------------------ */

const REASON_BY_COVER: Record<string, AttributionReason> = {
  exact: 'concrete-write',
  parent: 'parent-replace',
  wildcard: 'wildcard-write',
  'wildcard-parent': 'parent-replace',
  dynamic: 'dynamic-write',
  'dynamic-required': 'required-missing',
  'dynamic-parent': 'required-missing',
};

export function attributeError(raw: RawError, summaries: StepPathSummary[], executedStepIds: string[]): GateError {
  const required = raw.keyword === 'required';
  const err = errorPath(raw.path, required);
  const executed = new Set(executedStepIds);

  const hits: Attribution[] = [];
  summaries.forEach((summary) => {
    if (!executed.has(summary.stepId)) return;
    let best: {kind: string; certainty: 'definite' | 'candidate'} | null = null;
    for (const write of summary.writes) {
      const cover = coverKind(parsePath(write.expr), err);
      if (!cover) continue;
      if (!best || rank(cover.kind) > rank(best.kind)) best = cover;
    }
    if (!best) return;
    hits.push({
      stepId: summary.stepId,
      index: summary.index,
      title: summary.title,
      certainty: best.certainty,
      reason: REASON_BY_COVER[best.kind] ?? 'concrete-write',
    });
  });

  // Latest writer first.
  hits.sort((a, b) => b.index - a.index);

  // Reverse-associate to the nearest definite writer. Dynamic expressions are not statically
  // decidable, so they never become a unique primary cause — they remain candidates even for
  // required errors, alongside any definite structural writer.
  const primary = hits.find((h) => h.certainty === 'definite');
  const candidates = hits.filter((h) => h !== primary);

  return {
    path: raw.path,
    keyword: raw.keyword,
    message: raw.message,
    missingProperty: raw.missingProperty,
    branchMessages: raw.branchMessages,
    primary,
    candidates: dedupe(candidates),
    unattributed: hits.length === 0,
  };
}

function rank(kind: string): number {
  return (
    {exact: 5, wildcard: 4, dynamic: 3, parent: 2, 'wildcard-parent': 1, 'dynamic-parent': 1, 'dynamic-required': 1}[
      kind
    ] ?? 0
  );
}

function dedupe(hits: Attribution[]): Attribution[] {
  const seen = new Set<string>();
  return hits.filter((h) => (seen.has(h.stepId) ? false : (seen.add(h.stepId), true)));
}

/* ------------------------------ validate one ------------------------------ */

export function validateSample(
  pipeline: PipelineDef,
  schema: SchemaObject,
  sample: {id: string; input: Json},
  revisions: {sampleRevision: number; pipelineRevision: number; schemaRevision: number},
  validateFn: (value: Json, schema: SchemaObject) => RawError[],
): SampleGateResult {
  const {output, executedStepIds} = runPipeline(pipeline, sample.input);
  const summaries = pipelineSummary(pipeline);
  const rawErrors = validateFn(output, schema);
  const errors = rawErrors.map((raw) => attributeError(raw, summaries, executedStepIds));
  return {
    sampleId: sample.id,
    sampleRevision: revisions.sampleRevision,
    pipelineRevision: revisions.pipelineRevision,
    schemaRevision: revisions.schemaRevision,
    cached: false,
    valid: errors.length === 0,
    executedStepIds,
    errors,
    output,
  };
}

export {renderTokens};
