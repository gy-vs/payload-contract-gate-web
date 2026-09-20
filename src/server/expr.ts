import type {Json} from '../shared/types';
import {parsePath} from './paths';

// Tiny expression language used by step `when` guards and dynamic path segments:
//   $.path refs, identifiers (locals), literals, !, +, ===, !==, ==, &&, ||

type Token = {type: 'num' | 'str' | 'name' | 'path' | 'op'; value: string};

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '"' || ch === "'") {
      const quote = ch;
      let out = '';
      i++;
      while (i < expr.length && expr[i] !== quote) {
        if (expr[i] === '\\') out += expr[++i];
        else out += expr[i];
        i++;
      }
      i++;
      tokens.push({type: 'str', value: out});
    } else if (ch === '$') {
      let j = i + 1;
      while (j < expr.length && /[\w$.[\]\s"'\-*+]/.test(expr[j])) {
        // Stop a path ref at an expression operator inside brackets (handled conservatively).
        if (expr[j] === '[' && /["'*\d]/.test(expr[j + 1] ?? '') === false) break;
        j++;
      }
      tokens.push({type: 'path', value: expr.slice(i, j).trim()});
      i = j;
    } else if (/\d/.test(ch)) {
      let j = i;
      while (j < expr.length && /[\d.]/.test(expr[j])) j++;
      tokens.push({type: 'num', value: expr.slice(i, j)});
      i = j;
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < expr.length && /[\w$]/.test(expr[j])) j++;
      tokens.push({type: 'name', value: expr.slice(i, j)});
      i = j;
    } else {
      const three = expr.slice(i, i + 3);
      const two = expr.slice(i, i + 2);
      if (three === '===' || three === '!==') {
        tokens.push({type: 'op', value: three});
        i += 3;
      } else if (two === '==' || two === '&&' || two === '||') {
        tokens.push({type: 'op', value: two});
        i += 2;
      } else if ('!+-'.includes(ch)) {
        tokens.push({type: 'op', value: ch});
        i++;
      } else {
        throw new Error(`Unexpected '${ch}' in expression: ${expr}`);
      }
    }
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  parse(): EvalFn {
    const fn = this.parseOr();
    if (this.pos !== this.tokens.length) throw new Error('Trailing tokens in expression');
    return fn;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private take(op?: string): Token {
    const tok = this.tokens[this.pos++];
    if (!tok) throw new Error('Unexpected end of expression');
    if (op && (tok.type !== 'op' || tok.value !== op)) throw new Error(`Expected ${op}`);
    return tok;
  }

  private parseOr(): EvalFn {
    let left = this.parseAnd();
    while (this.peek()?.type === 'op' && this.peek()?.value === '||') {
      this.take();
      const right = this.parseAnd();
      const l = left;
      left = (scope) => truthy(l(scope)) || truthy(right(scope));
    }
    return left;
  }
  private parseAnd(): EvalFn {
    let left = this.parseEquality();
    while (this.peek()?.type === 'op' && this.peek()?.value === '&&') {
      this.take();
      const right = this.parseEquality();
      const l = left;
      left = (scope) => truthy(l(scope)) && truthy(right(scope));
    }
    return left;
  }
  private parseEquality(): EvalFn {
    let left = this.parseUnary();
    while (this.peek()?.type === 'op' && ['===', '!==', '=='].includes(this.peek()!.value)) {
      const op = this.take().value;
      const right = this.parseUnary();
      const l = left;
      left = (scope) => {
        const a = l(scope);
        const b = right(scope);
        return op === '!==' ? a !== b : a === b;
      };
    }
    return left;
  }
  private parseUnary(): EvalFn {
    if (this.peek()?.type === 'op' && this.peek()?.value === '!') {
      this.take();
      const inner = this.parseUnary();
      return (scope) => !truthy(inner(scope));
    }
    return this.parseAdd();
  }
  private parseAdd(): EvalFn {
    let left = this.parsePrimary();
    while (this.peek()?.type === 'op' && this.peek()?.value === '+') {
      this.take();
      const right = this.parsePrimary();
      const l = left;
      left = (scope) => plus(l(scope), right(scope));
    }
    return left;
  }
  private parsePrimary(): EvalFn {
    const tok = this.take();
    if (tok.type === 'num') {
      const n = Number(tok.value);
      return () => n;
    }
    if (tok.type === 'str') return () => tok.value;
    if (tok.type === 'name') {
      if (tok.value === 'true') return () => true;
      if (tok.value === 'false') return () => false;
      if (tok.value === 'null' || tok.value === 'undefined') return () => null;
      return (scope) => (tok.value in scope.locals ? scope.locals[tok.value] : undefined);
    }
    if (tok.type === 'path') {
      const pathTokens = parsePath(tok.value);
      return (scope) => readByTokens(scope.input, pathTokens, scope.locals);
    }
    throw new Error(`Unexpected token: ${tok.value}`);
  }
}

type Scope = {input: Json; locals: Record<string, Json>};
type EvalFn = (scope: Scope) => unknown;

function plus(a: unknown, b: unknown): Json {
  if (typeof a === 'string' || typeof b === 'string') return String(a ?? '') + String(b ?? '');
  return Number(a ?? 0) + Number(b ?? 0);
}

export function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return !!value;
}

const cache = new Map<string, (scope: Scope) => unknown>();

export function compile(expr: string): (scope: Scope) => unknown {
  let fn = cache.get(expr);
  if (!fn) {
    fn = new Parser(tokenize(expr)).parse();
    cache.set(expr, fn);
  }
  return fn;
}

/** Evaluate with the sample as input; returns undefined on any unresolved reference. */
export function evalExpr(expr: string, input: Json, locals: Record<string, Json> = {}): Json | undefined {
  try {
    const value = compile(expr)({input, locals});
    return value === undefined ? undefined : (value as Json);
  } catch {
    return undefined;
  }
}

export function readByTokens(
  root: Json,
  tokens: ReturnType<typeof parsePath>,
  locals: Record<string, Json> = {},
): Json | undefined {
  let current: Json = root;
  for (const tok of tokens) {
    if (current === null || current === undefined) return undefined;
    if (tok.kind === 'key') {
      if (typeof current !== 'object' || Array.isArray(current)) return undefined;
      current = (current as Record<string, Json>)[tok.name];
    } else if (tok.kind === 'index') {
      if (!Array.isArray(current)) return undefined;
      current = current[tok.value];
    } else if (tok.kind === 'wild') {
      return undefined; // wildcard reads must be handled by the fan-out walker
    } else {
      const key = evalExpr(tok.expr, root, locals);
      if (typeof key === 'number') {
        if (!Array.isArray(current)) return undefined;
        current = current[key];
      } else if (typeof key === 'string') {
        if (typeof current !== 'object' || Array.isArray(current)) return undefined;
        current = (current as Record<string, Json>)[key];
      } else {
        return undefined;
      }
    }
  }
  return current;
}

const PATH_RE = /\$(?:\.[A-Za-z_$][\w$-]*|\[(?:\*|-?\d+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\])*/g;

/** All $-paths statically referenced anywhere in an expression (including inside bracket exprs). */
export function extractPaths(expr: string): string[] {
  const out: string[] = [];
  for (const match of expr.matchAll(PATH_RE)) {
    const p = match[0];
    if (p !== '$') out.push(p);
  }
  return [...new Set(out)];
}
