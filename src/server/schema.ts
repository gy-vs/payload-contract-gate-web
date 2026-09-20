import {Seg, stableStringify} from './paths';

// Minimal JSON-Schema-like target schema. Supports object properties/required,
// array items, unions (`type: [...]` and `anyOf`), enums and
// additionalProperties-as-schema (used to gate dynamically written keys).
export type SchemaNode = {
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
  anyOf?: SchemaNode[];
  enum?: unknown[];
  additionalProperties?: SchemaNode;
};

export type ValidationError = {
  path: Seg[];
  code: 'required' | 'type' | 'union' | 'enum';
  message: string;
  expected?: string;
  actual?: string;
};

export function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    default: return typeof value === type;
  }
}

function describe(type: string | string[]): string {
  return Array.isArray(type) ? type.join(' | ') : type;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateValue(value: unknown, schema: SchemaNode, path: Seg[], errors: ValidationError[]): void {
  if (schema.anyOf) {
    const matched = schema.anyOf.some(branch => {
      const branchErrors: ValidationError[] = [];
      validateValue(value, branch, path, branchErrors);
      return branchErrors.length === 0;
    });
    if (!matched) {
      const expected = schema.anyOf.map(branch => (branch.type ? describe(branch.type) : 'schema')).join(' | ');
      errors.push({path, code: 'union', expected, actual: typeOf(value), message: `expected ${expected}, got ${typeOf(value)}`});
    }
    return; // one union error at this path instead of cascading branch errors
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(type => matchesType(value, type))) {
      const expected = describe(schema.type);
      errors.push({path, code: 'type', expected, actual: typeOf(value), message: `expected ${expected}, got ${typeOf(value)}`});
      return; // do not descend into a value of the wrong shape
    }
  }
  if (schema.enum && !schema.enum.some(option => stableStringify(option) === stableStringify(value))) {
    errors.push({path, code: 'enum', expected: schema.enum.map(option => JSON.stringify(option)).join(' | '), actual: JSON.stringify(value), message: `expected one of ${schema.enum.map(option => JSON.stringify(option)).join(', ')}`});
    return;
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((element, index) => validateValue(element, schema.items!, [...path, index], errors));
    return;
  }
  if (isObject(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) {
        errors.push({path: [...path, key], code: 'required', message: `missing required property "${key}"`});
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) validateValue(value[key], sub, [...path, key], errors);
    }
    if (schema.additionalProperties) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!known.has(key)) validateValue(value[key], schema.additionalProperties, [...path, key], errors);
      }
    }
  }
}
