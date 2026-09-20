import type {Json, SchemaObject} from '../shared/types';

export type RawError = {
  path: string;
  keyword: 'required' | 'type' | 'union';
  message: string;
  missingProperty?: string;
  branchMessages?: string[];
};

const TYPE_NAMES: Record<string, (v: Json) => boolean> = {
  object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
};

function joinPath(base: string, token: string | number): string {
  return typeof token === 'number' || /^\d+$/.test(String(token))
    ? `${base}[${token}]`
    : /^[A-Za-z_$][\w$-]*$/.test(String(token))
      ? `${base}.${token}`
      : `${base}[${JSON.stringify(String(token))}]`;
}

function typeName(v: Json): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** Validate one schema branch; returns the list of errors (empty => branch matches). */
function validateSchema(value: Json, schema: SchemaObject, path: string, errors: RawError[]): void {
  if (schema.anyOf || schema.oneOf) {
    const branches = (schema.anyOf ?? schema.oneOf)!;
    const branchReports: {index: number; messages: string[]}[] = [];
    let matched = 0;
    for (let i = 0; i < branches.length; i++) {
      const branchErrors: RawError[] = [];
      validateSchema(value, branches[i], path, branchErrors);
      if (branchErrors.length === 0) matched++;
      else branchReports.push({index: i, messages: branchErrors.map((e) => e.message)});
    }
    const valid = schema.oneOf ? matched === 1 : matched >= 1;
    if (!valid) {
      errors.push({
        path,
        keyword: 'union',
        message: `value does not match any of ${branches.length} ${schema.oneOf ? 'oneOf' : 'anyOf'} branches`,
        branchMessages: branchReports.map((r) => `branch ${r.index}: ${r.messages.join('; ')}`),
      });
    }
    return;
  }

  if (schema.type) {
    const check = TYPE_NAMES[schema.type];
    if (!check) throw new Error(`Unsupported schema type: ${schema.type}`);
    if (!check(value)) {
      errors.push({path, keyword: 'type', message: `expected ${schema.type}, got ${typeName(value)}`});
      return; // deeper checks would be noise after a type mismatch
    }
  }

  if (schema.type === 'object' || (!schema.type && schema.properties)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
    const obj = value as Record<string, Json>;
    for (const key of schema.required ?? []) {
      if (!(key in obj) || obj[key] === undefined) {
        errors.push({
          path: joinPath(path, key),
          keyword: 'required',
          message: `missing required property '${key}'`,
          missingProperty: key,
        });
      }
    }
    for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
      if (key in obj && obj[key] !== undefined) {
        validateSchema(obj[key], propSchema, joinPath(path, key), errors);
      }
    }
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const [key, value] of Object.entries(obj)) {
        if (!known.has(key)) validateSchema(value, schema.additionalProperties, joinPath(path, key), errors);
      }
    }
  }

  if (schema.items && Array.isArray(value)) {
    value.forEach((item, index) => validateSchema(item, schema.items!, `${path}[${index}]`, errors));
  }
}

export function validate(value: Json, schema: SchemaObject): RawError[] {
  const errors: RawError[] = [];
  validateSchema(value, schema, '$', errors);
  return errors;
}
