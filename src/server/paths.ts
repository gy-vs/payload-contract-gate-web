import type {PathKind, PathSummaryEntry} from '../shared/types';

// Path DSL:
//   $.a.b[0]            static
//   $.items[*].id       wildcard (concrete array mapping at runtime)
//   $.tags["x_" + k]    dynamic expression segment (not statically decidable)
// A path is dynamic from its first bracketed non-integer, non-"*" expression.

type StaticTok = {kind: 'key'; name: string} | {kind: 'index'; value: number};
export type PathToken = StaticTok | {kind: 'wild'} | {kind: 'dynamic'; expr: string};

export function parsePath(path: string): PathToken[] {
  const expr = path.trim();
  if (!expr.startsWith('$')) {
    throw new Error(`Path must start with '$': ${path}`);
  }
  const tokens: PathToken[] = [];
  let i = 1;
  const readIdent = () => {
    let start = i;
    while (i < expr.length && /[\w$-]/.test(expr[i])) i++;
    const name = expr.slice(start, i);
    if (!name) throw new Error(`Invalid path: ${path}`);
    return name;
  };
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === '.') {
      i++;
      if (expr[i] === '"' || expr[i] === "'") {
        const quote = expr[i++];
        let start = i;
        let out = '';
        while (i < expr.length && expr[i] !== quote) {
          if (expr[i] === '\\') out += expr[++i];
          else out += expr[i];
          i++;
        }
        if (expr[i] !== quote) throw new Error(`Unterminated string in path: ${path}`);
        i++;
        tokens.push({kind: 'key', name: out || expr.slice(start, start)});
      } else {
        tokens.push({kind: 'key', name: readIdent()});
      }
    } else if (ch === '[') {
      i++;
      const inner = readBracket(expr, i, path);
      i = inner.next;
      if (inner.text === '*') {
        tokens.push({kind: 'wild'});
      } else if (/^-?\d+$/.test(inner.text)) {
        tokens.push({kind: 'index', value: Number(inner.text)});
      } else {
        tokens.push({kind: 'dynamic', expr: inner.text});
      }
    } else {
      throw new Error(`Unexpected '${ch}' in path: ${path}`);
    }
  }
  return tokens;
}

function readBracket(expr: string, start: number, fullPath: string): {text: string; next: number} {
  let i = start;
  let depth = 1;
  let quote: string | null = null;
  const begin = i;
  while (i < expr.length) {
    const ch = expr[i];
    if (quote) {
      if (ch === '\\') i += 2;
      else if (ch === quote) {
        quote = null;
        i++;
      } else i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i++;
    } else if (ch === '[') {
      depth++;
      i++;
    } else if (ch === ']') {
      depth--;
      i++;
      if (depth === 0) return {text: expr.slice(begin, i - 1).trim(), next: i};
    } else i++;
  }
  throw new Error(`Unbalanced brackets in path: ${fullPath}`);
}

export function classifyPath(path: string): PathKind {
  for (const tok of parsePath(path)) {
    if (tok.kind === 'dynamic') return 'dynamic';
    if (tok.kind === 'wild') return 'wild';
  }
  return 'static';
}

/** Tokens up to and excluding the first wildcard/dynamic segment. */
function fixedPrefix(tokens: PathToken[]): StaticTok[] {
  const out: StaticTok[] = [];
  for (const tok of tokens) {
    if (tok.kind === 'wild' || tok.kind === 'dynamic') break;
    out.push(tok);
  }
  return out;
}

function tokName(tok: StaticTok): string {
  return tok.kind === 'key' ? tok.name : String(tok.value);
}

export function renderTokens(tokens: PathToken[]): string {
  if (!tokens.length) return '$';
  let out = '$';
  for (const tok of tokens) {
    if (tok.kind === 'key') {
      out += /^[\w$-]+$/.test(tok.name) ? `.${tok.name}` : `[${JSON.stringify(tok.name)}]`;
    } else if (tok.kind === 'index') {
      out += `[${tok.value}]`;
    } else if (tok.kind === 'wild') {
      out += '[*]';
    } else {
      out += `[${tok.expr}]`;
    }
  }
  return out;
}

export function summarizePath(path: string): PathSummaryEntry {
  const tokens = parsePath(path);
  for (const tok of tokens) {
    if (tok.kind === 'dynamic') {
      return {expr: path, kind: 'dynamic', prefix: renderTokens(fixedPrefix(tokens))};
    }
  }
  return {expr: path, kind: classifyPath(path), prefix: renderTokens(tokens)};
}

export type CoverKind =
  | 'exact'
  | 'parent'
  | 'wildcard'
  | 'wildcard-parent'
  | 'dynamic'
  | 'dynamic-required'
  | 'dynamic-parent'
  | null;

export type Cover = {kind: Exclude<CoverKind, null>; certainty: 'definite' | 'candidate'};

export type ErrorPath = {tokens: StaticTok[]; required: boolean};

export function errorPath(path: string, required: boolean): ErrorPath {
  const tokens = parsePath(path).filter((t): t is StaticTok => t.kind === 'key' || t.kind === 'index');
  return {tokens, required};
}

/**
 * How a write spec covers an error path.
 * - value errors (required=false): static exact / ancestor replacement / wildcard / dynamic
 * - required errors: only a write at-or-above the missing path can create it; child writes cannot.
 * Wildcards ([*]) are structurally determinate -> definite. Bracket expressions are not statically
 * decidable -> candidate, including prefix containers that exist only when the mapping actually ran.
 */
export function coverKind(write: PathToken[], err: ErrorPath): Cover | null {
  let i = 0;
  for (; i < write.length; i++) {
    const w = write[i];
    if (w.kind === 'wild' || w.kind === 'dynamic') break;
    const e = err.tokens[i];
    if (e === undefined) {
      // Write path strictly below the error path: the object at the error path must exist already
      // for the write to succeed, so it neither creates it (required) nor sets its value.
      return null;
    }
    if (tokName(w) !== tokName(e)) return null;
  }

  if (i === write.length) {
    if (i === err.tokens.length) return {kind: 'exact', certainty: 'definite'};
    // write is an ancestor of the error => whole-subtree replacement.
    return {kind: 'parent', certainty: 'definite'};
  }

  // First non-fixed write token at position i.
  if (i > err.tokens.length) return null;
  const nonFixed = write[i];
  const e = err.tokens[i];

  if (nonFixed.kind === 'wild') {
    if (err.required) {
      if (e === undefined) {
        // The wildcard mapping materializes the container while iterating.
        return i === err.tokens.length ? {kind: 'wildcard-parent', certainty: 'definite'} : null;
      }
      return matchTail(write, i + 1, err.tokens, i + 1)
        ? {kind: 'wildcard', certainty: 'definite'}
        : null;
    }
    if (e === undefined) return null; // wild cannot match "no token"
    return matchTail(write, i + 1, err.tokens, i + 1)
      ? {kind: 'wildcard', certainty: 'definite'}
      : null;
  }

  // Dynamic bracket expression: never statically decidable -> candidate.
  if (err.required) {
    if (e === undefined) {
      // Error path is the dynamic write's prefix container; it exists only if the mapping ran.
      return i === err.tokens.length ? {kind: 'dynamic-parent', certainty: 'candidate'} : null;
    }
    return matchTail(write, i + 1, err.tokens, i + 1)
      ? {kind: 'dynamic-required', certainty: 'candidate'}
      : null;
  }
  if (e === undefined) return null;
  return matchTail(write, i + 1, err.tokens, i + 1)
    ? {kind: 'dynamic', certainty: 'candidate'}
    : null;
}

function matchTail(write: PathToken[], wi: number, err: StaticTok[], ei: number): boolean {
  if (write.length - wi !== err.length - ei) return false;
  for (let k = 0; k < write.length - wi; k++) {
    const w = write[wi + k];
    const e = err[ei + k];
    if (w.kind === 'wild' || w.kind === 'dynamic') continue;
    if (tokName(w) !== tokName(e)) return false;
  }
  return true;
}

/** Static prefix address, e.g. "$.items[*].id" -> ["items"], "$[\"x_\"+k]" -> []. */
export function prefixAddress(path: string): (string | number)[] {
  return fixedPrefix(parsePath(path)).map(tokName);
}
