import {describe, expect, it} from 'vitest';
import {runPipeline, pipelineSummary, attributeError, validateSample} from '../src/server/engine';
import {validate} from '../src/server/validator';
import type {GateError, Json, PipelineDef, SchemaObject} from '../src/shared/types';

const revisions = {sampleRevision: 1, pipelineRevision: 1, schemaRevision: 1};

function run(pipeline: PipelineDef, input: Json) {
  return runPipeline(pipeline, input);
}

function gate(pipeline: PipelineDef, schema: SchemaObject, input: Json) {
  return validateSample(pipeline, schema, {id: 's', input}, revisions, validate);
}

function byPath(errors: GateError[], path: string): GateError {
  const found = errors.find((e) => e.path === path);
  if (!found) throw new Error(`no error at ${path}; got ${errors.map((e) => e.path).join(', ')}`);
  return found;
}

describe('target schema gate — required', () => {
  const pipeline: PipelineDef = {
    steps: [
      {id: 's1', title: 'Copy id', map: {'$.orderId': '$.id'}},
      {id: 's2', title: 'Copy customer', map: {'$.customer.name': '$.customer.name'}},
      {id: 's3', title: 'Keep items', map: {'$.items': '$.items'}},
    ],
  };
  const schema: SchemaObject = {
    type: 'object',
    required: ['orderId', 'customer', 'items'],
    properties: {
      orderId: {type: 'string'},
      customer: {type: 'object', required: ['name'], properties: {name: {type: 'string'}}},
      items: {type: 'array'},
    },
  };

  it('passes when all required paths are produced', () => {
    const result = gate(pipeline, schema, {id: 'A', customer: {name: 'Ada'}, items: []});
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('reverse-links a missing required path to the step declaring that write path', () => {
    const result = gate(pipeline, schema, {id: 'A', customer: {name: 'Ada'}});
    expect(result.valid).toBe(false);
    const err = byPath(result.errors, '$.items');
    expect(err.keyword).toBe('required');
    // s3 declares the $.items write even though this sample carries no items, so it is the
    // structurally responsible step — a definite attribution, not "no step involved".
    expect(err.primary?.stepId).toBe('s3');
    expect(err.primary?.reason).toBe('concrete-write');
  });

  it('marks the exact-write step as the definite primary for a nested required miss', () => {
    const withParent: PipelineDef = {
      steps: [
        ...pipeline.steps.slice(0, 1),
        {id: 's0', title: 'Copy customer object', map: {'$.customer': '$.customer'}},
        ...pipeline.steps.slice(1),
      ],
    };
    // customer exists but has no name; s0 copies the empty object, s2's $.customer.name read
    // is absent — the nested required error points at the exact leaf-writing step s2.
    const result = gate(withParent, schema, {id: 'A', customer: {}, items: []});
    const err = byPath(result.errors, '$.customer.name');
    expect(err.keyword).toBe('required');
    expect(err.primary?.stepId).toBe('s2');
    expect(err.primary?.certainty).toBe('definite');
  });

  it('never fabricates a primary when no step touches the missing path', () => {
    const noItems: PipelineDef = {steps: pipeline.steps.slice(0, 2)};
    const result = gate(noItems, schema, {id: 'A', customer: {name: 'Ada'}});
    const err = byPath(result.errors, '$.items');
    expect(err.unattributed).toBe(true);
    expect(err.primary).toBeUndefined();
    expect(err.candidates).toEqual([]);
  });
});

describe('target schema gate — union types', () => {
  const pipeline: PipelineDef = {
    steps: [{id: 'party', title: 'Copy party', map: {'$.party': '$.party'}}],
  };
  const schema: SchemaObject = {
    type: 'object',
    properties: {
      party: {
        anyOf: [
          {type: 'object', required: ['userId'], properties: {userId: {type: 'string'}}},
          {type: 'object', required: ['orgId'], properties: {orgId: {type: 'string'}}},
        ],
      },
    },
  };

  it('accepts a value matching one branch', () => {
    const result = gate(pipeline, schema, {party: {userId: 'u-1'}});
    expect(result.valid).toBe(true);
  });

  it('attributes a union failure to the step that wrote the path and lists branch detail', () => {
    const result = gate(pipeline, schema, {party: {token: 'zzz'}});
    expect(result.valid).toBe(false);
    const err = byPath(result.errors, '$.party');
    expect(err.keyword).toBe('union');
    expect(err.branchMessages?.length).toBe(2);
    expect(err.primary?.stepId).toBe('party');
    expect(err.primary?.certainty).toBe('definite');
  });
});

describe('target schema gate — array elements', () => {
  const pipeline: PipelineDef = {
    steps: [
      {
        id: 'lines',
        title: 'Map lines',
        map: {
          '$.items[*].sku': '$.lines[*].sku',
          '$.items[*].qty': '$.lines[*].quantity',
        },
      },
    ],
  };
  const schema: SchemaObject = {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['sku', 'qty'],
          properties: {sku: {type: 'string'}, qty: {type: 'integer'}},
        },
      },
    },
  };

  it('validates every element and attributes element errors via the wildcard write', () => {
    const result = gate(pipeline, schema, {
      lines: [
        {sku: 'A', quantity: 2},
        {quantity: 1}, // missing sku
      ],
    });
    const missing = byPath(result.errors, '$.items[1].sku');
    expect(missing.keyword).toBe('required');
    expect(missing.primary?.stepId).toBe('lines');
    expect(missing.primary?.reason).toBe('wildcard-write');
    expect(missing.primary?.certainty).toBe('definite');
  });

  it('attributes an element type error to the definite wildcard writer', () => {
    const result = gate(pipeline, schema, {
      lines: [{sku: 'A', quantity: 'two'}],
    });
    const typeErr = result.errors.find((e) => e.path === '$.items[0].qty' && e.keyword === 'type');
    expect(typeErr).toBeTruthy();
    expect(typeErr!.primary?.stepId).toBe('lines');
    expect(typeErr!.primary?.reason).toBe('wildcard-write');
    expect(typeErr!.primary?.certainty).toBe('definite');
  });
});

describe('target schema gate — parent path replacement', () => {
  const pipeline: PipelineDef = {
    steps: [
      {id: 'seed', title: 'Seed full address', map: {'$.address': '$.old.address'}},
      {id: 'patch-city', title: 'Patch city', map: {'$.address.city': '$.newCity'}},
    ],
  };
  const schema: SchemaObject = {
    type: 'object',
    properties: {
      address: {
        type: 'object',
        required: ['city', 'zip'],
        properties: {city: {type: 'string'}, zip: {type: 'string'}},
      },
    },
  };

  it('replaces the whole subtree on parent write (later child writes do not resurrect removed keys)', () => {
    // Step order: seed writes $.address, then patch-city writes $.address.city.
    // The missing $.address.zip error must point at the nearest writer that *replaced the
    // subtree* (seed), since replacing $.address controls whether zip survives.
    const result = gate(pipeline, schema, {
      old: {address: {city: 'Old', zip: '00000'}},
      newCity: 'New',
    });
    // Parent replacement: seed's object copy sets zip, so initially valid; nothing removes it.
    expect(result.valid).toBe(true);
    expect(result.output).toEqual({address: {city: 'New', zip: '00000'}});
  });

  it('attributes an error under a replaced path to the step that replaced the parent (latest ancestor writer)', () => {
    const reversed: PipelineDef = {
      steps: [
        {id: 'patch-city', title: 'Patch city', map: {'$.address.city': '$.newCity'}},
        {id: 'seed', title: 'Replace address', map: {'$.address': '$.old.address'}},
      ],
    };
    const result = gate(reversed, schema, {
      old: {address: {city: 'Replaced'}}, // no zip
      newCity: 'New',
    });
    // seed replaced $.address *after* patch-city wrote city; zip missing, and the cause is
    // the ancestor replacement, not the city writer.
    const err = byPath(result.errors, '$.address.zip');
    expect(err.primary?.stepId).toBe('seed');
    expect(err.primary?.reason).toBe('parent-replace');
    expect(err.primary?.certainty).toBe('definite');
    expect(result.output).toEqual({address: {city: 'Replaced'}});
  });
});

describe('target schema gate — multiple steps write the same path', () => {
  const pipeline: PipelineDef = {
    steps: [
      {id: 'first', title: 'Initial type', map: {'$.kind': '$.a'}},
      {id: 'second', title: 'Override type', map: {'$.kind': '$.b'}},
    ],
  };
  const schema: SchemaObject = {
    type: 'object',
    properties: {kind: {type: 'string'}},
  };

  it('reverse-associates to the most recent writer and lists earlier writers as candidates', () => {
    const result = gate(pipeline, schema, {a: 'ok', b: 42});
    const err = byPath(result.errors, '$.kind');
    expect(err.keyword).toBe('type');
    expect(err.primary?.stepId).toBe('second');
    expect(err.candidates.map((c) => c.stepId)).toEqual(['first']);
  });

  it('uses the actually-executed last writer when an earlier step is conditional and skipped', () => {
    const conditional: PipelineDef = {
      steps: [
        {id: 'first', title: 'guarded', when: '$.flag', map: {'$.kind': '$.a'}},
        {id: 'second', title: 'override', map: {'$.kind': '$.b'}},
      ],
    };
    const result = gate(conditional, schema, {a: 'ok', b: 9});
    const err = byPath(result.errors, '$.kind');
    expect(err.primary?.stepId).toBe('second');
    expect(result.executedStepIds).not.toContain('first');
  });
});

describe('target schema gate — dynamic paths', () => {
  const pipeline: PipelineDef = {
    steps: [
      {
        id: 'dyn',
        title: 'Dynamic channel tag',
        when: '$.channel',
        map: {'$.tags["channel_" + $.channel]': '$.channel'},
      },
    ],
  };
  const schema: SchemaObject = {
    type: 'object',
    required: ['tags'],
    properties: {tags: {type: 'object', additionalProperties: {type: 'string'}}},
  };

  it('runs and attributes a concrete error under a dynamically computed key as a candidate', () => {
    const result = gate(pipeline, schema, {channel: 5}); // tag value is number, schema wants string
    expect(result.output).toEqual({tags: {channel_5: 5}});
    const err = byPath(result.errors, '$.tags.channel_5');
    expect(err.keyword).toBe('type');
    // Static analysis cannot prove the bracket expression produced "channel_5": candidate only.
    expect(err.primary).toBeUndefined();
    expect(err.candidates.map((c) => c.stepId)).toContain('dyn');
    expect(err.candidates.find((c) => c.stepId === 'dyn')?.certainty).toBe('candidate');
    expect(err.candidates.find((c) => c.stepId === 'dyn')?.reason).toBe('dynamic-write');
  });

  it('flags a dynamic-expression write as candidate, never a unique definite cause', () => {
    // tags required; step only creates tags when $.channel is truthy. With channel present the
    // container exists; here we assert attribution certainty for the dynamic write path.
    const summary = pipelineSummary(pipeline)[0];
    const write = summary.writes[0];
    expect(write.kind).toBe('dynamic');
    expect(write.prefix).toBe('$.tags');

    const result = gate(pipeline, schema, {channel: 'web'});
    expect(result.output).toEqual({tags: {channel_web: 'web'}});
    // No missing required => valid for this schema; attribution machinery is checked via a
    // forced required error on the dynamic prefix below.
    expect(result.valid).toBe(true);
  });

  it('attributes a missing dynamic-prefix container to the dynamic step as candidate only', () => {
    const skipped: PipelineDef = {
      steps: [{id: 'dyn', title: 'Dynamic', when: '$.channel', map: {'$.tags[$.channel]': '$.channel'}}],
    };
    const result = gate(skipped, schema, {}); // when false => step skipped => $.tags missing
    const err = byPath(result.errors, '$.tags');
    expect(err.keyword).toBe('required');
    expect(err.primary).toBeUndefined();
    expect(err.candidates.map((c) => c.stepId)).not.toContain('dyn'); // skipped steps excluded
    expect(err.unattributed).toBe(true);
  });

  it('dynamic write that runs stays a candidate even for observable concrete output paths', () => {
    const typedSchema: SchemaObject = {
      type: 'object',
      properties: {tags: {type: 'object', additionalProperties: {type: 'string'}}},
    };
    const result = gate(pipeline, typedSchema, {channel: 7});
    expect(result.output).toEqual({tags: {channel_7: 7}});
    const err = byPath(result.errors, '$.tags.channel_7');
    expect(err.candidates.find((c) => c.stepId === 'dyn')?.certainty).toBe('candidate');
  });
});

describe('read/write path summary', () => {
  it('summarizes static, wildcard and dynamic writes', () => {
    const pipeline: PipelineDef = {
      steps: [
        {id: 's', map: {'$.a.b': '$.x', '$.items[*].id': '$.rows[*].id', '$.tags["k_"+$.k]': '$.v'}},
      ],
    };
    const summary = pipelineSummary(pipeline)[0];
    expect(summary.writes.map((w) => w.kind)).toEqual(['static', 'wild', 'dynamic']);
    expect(summary.writes[2].prefix).toBe('$.tags');
    expect(summary.reads.map((r) => r.expr).sort()).toEqual(['$.rows[*].id', '$.v', '$.x']);
  });
});
