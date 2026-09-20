import {createHash} from 'node:crypto';
import {Attribution, attributePath} from './attribute';
import {Seg, renderPath, stableStringify} from './paths';
import {Step, runPipeline, summarizeStep} from './pipeline';
import {SchemaNode, ValidationError, validateValue} from './schema';

export type Sample = {id: string; name: string; input: unknown};

export type Pipeline = {
  id: string;
  name: string;
  revision: number;
  steps: Step[];
  schema: {id: string; revision: number; node: SchemaNode};
  samples: Sample[];
  updatedAt: string;
};

export type AttributedError = Omit<ValidationError, 'path'> & {
  path: string;
  segments: Seg[];
  attribution: Attribution;
};

export type SampleResult = {
  sampleId: string;
  status: 'passed' | 'failed';
  revalidated: boolean; // false when the previous verdict was provably reusable
  reused: boolean;
  errors: AttributedError[];
  output: unknown;
};

type StoredVerdict = {status: 'passed' | 'failed'; errors: AttributedError[]};

export type GateStore = {
  pipelines: Pipeline[];
  validate: (pipeline: Pipeline, samples: Sample[]) => SampleResult[];
  invalidate: (pipelineId: string) => number;
};

function fingerprint(value: unknown): string {
  return createHash('sha1').update(stableStringify(value)).digest('hex');
}

/**
 * The gate keeps two separate structures:
 *  - `verdictCache`, keyed by (pipeline revision, schema revision, sample).
 *    Schema revision is pinned together with pipeline revision, so any change
 *    to either makes every old entry unreachable; edits also actively sweep
 *    the pipeline's entries (`invalidate`).
 *  - `lastRun`, a per-sample output fingerprint. After a pipeline edit a
 *    sample whose transformed output is byte-identical (and whose schema
 *    revision is unchanged) provably produces the same verdict, so the gate
 *    skips re-validating it and reports it as reused instead of re-stamping
 *    an old result as a fresh pass.
 */
export function createGateStore(): GateStore {
  const verdictCache = new Map<string, StoredVerdict>();
  const lastRun = new Map<string, {outputHash: string; schemaRevision: number; verdict: StoredVerdict}>();

  const validate = (pipeline: Pipeline, samples: Sample[]): SampleResult[] => {
    const summaries = pipeline.steps.map((step, index) => summarizeStep(step, index));
    return samples.map(sample => {
      const output = runPipeline(pipeline.steps, sample.input);
      const outputHash = fingerprint(output);
      const cacheKey = `${pipeline.id}:${pipeline.revision}:${pipeline.schema.revision}:${sample.id}`;
      const runKey = `${pipeline.id}:${sample.id}`;

      let verdict = verdictCache.get(cacheKey);
      let revalidated = false;
      if (!verdict) {
        const last = lastRun.get(runKey);
        if (last && last.outputHash === outputHash && last.schemaRevision === pipeline.schema.revision) {
          verdict = last.verdict; // same output + same schema revision ⇒ same verdict
        }
      }
      if (!verdict) {
        const raw: ValidationError[] = [];
        validateValue(output, pipeline.schema.node, [], raw);
        const errors: AttributedError[] = raw.map(error => ({
          ...error,
          segments: error.path,
          path: renderPath(error.path),
          attribution: attributePath(error.path, summaries),
        }));
        verdict = {status: errors.length > 0 ? 'failed' : 'passed', errors};
        revalidated = true;
      }
      verdictCache.set(cacheKey, verdict);
      lastRun.set(runKey, {outputHash, schemaRevision: pipeline.schema.revision, verdict});
      return {
        sampleId: sample.id,
        status: verdict.status,
        revalidated,
        reused: !revalidated,
        errors: verdict.errors,
        output,
      };
    });
  };

  const invalidate = (pipelineId: string): number => {
    let swept = 0;
    for (const key of [...verdictCache.keys()]) {
      if (key.startsWith(`${pipelineId}:`)) {
        verdictCache.delete(key);
        swept++;
      }
    }
    return swept;
  };

  return {pipelines: seedPipelines(), validate, invalidate};
}

function seedPipelines(): Pipeline[] {
  const steps: Step[] = [
    {id: 's1', name: 'Adopt legacy profile', kind: 'set', path: 'profile', from: 'legacy.profile'},
    {id: 's2', name: 'Move fullName', kind: 'rename', from: 'fullName', path: 'profile.name'},
    {id: 's3', name: 'Copy years to age', kind: 'set', path: 'profile.age', from: 'years'},
    {
      id: 's4',
      name: 'Normalize items',
      kind: 'map',
      path: 'items',
      item: [
        {id: 's4a', name: 'Rename label', kind: 'rename', from: 'label', path: 'name'},
        {id: 's4b', name: 'Copy code to id', kind: 'set', path: 'id', from: 'code'},
      ],
    },
    {id: 's5', name: 'Spread legacy attr', kind: 'dynamicSet', pathTemplate: 'attrs.{legacy.attrKey}', from: 'legacy.attrValue'},
    {id: 's6', name: 'Apply age override', kind: 'rename', from: 'ageOverride', path: 'profile.age'},
    {id: 's7', name: 'Drop legacy bag', kind: 'delete', path: 'legacy'},
  ];
  const schema: SchemaNode = {
    type: 'object',
    required: ['id', 'profile'],
    properties: {
      id: {type: 'string'},
      profile: {
        type: 'object',
        required: ['name'],
        properties: {
          name: {type: 'string'},
          age: {anyOf: [{type: 'number'}, {type: 'null'}]},
          email: {type: ['string', 'null']},
        },
      },
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'name'],
          properties: {id: {type: 'string'}, name: {type: 'string'}},
        },
      },
      attrs: {type: 'object', additionalProperties: {type: 'string'}},
    },
  };
  const samples: Sample[] = [
    {
      id: 'ok-basic',
      name: 'Happy path',
      input: {
        id: 'c-1',
        fullName: 'Ada Lovelace',
        years: 36,
        legacy: {profile: {email: 'ada@example.io'}, attrKey: 'tier', attrValue: 'gold'},
        items: [{code: 'a1', label: 'Apple'}],
      },
    },
    {
      id: 'missing-id',
      name: 'Missing id',
      input: {fullName: 'No Identifier', years: 5, legacy: {profile: {}}},
    },
    {
      id: 'bad-age',
      name: 'Age as text',
      input: {id: 'c-3', fullName: 'Bad Age', years: 'thirty', legacy: {profile: {}}},
    },
    {
      id: 'age-override-bad',
      name: 'Bad age override',
      input: {id: 'c-4', fullName: 'Override Age', years: 30, ageOverride: 'old', legacy: {profile: {}}},
    },
    {
      id: 'bad-item',
      name: 'Broken array element',
      input: {id: 'c-5', fullName: 'Bad Item', years: 1, legacy: {profile: {}}, items: [{code: 'a', label: 'ok'}, {code: 42}]},
    },
    {
      id: 'bad-attr',
      name: 'Dynamic attr value',
      input: {id: 'c-6', fullName: 'Dynamic Attr', years: 2, legacy: {profile: {}, attrKey: 'level', attrValue: 7}},
    },
    {
      id: 'bad-profile',
      name: 'Corrupt parent',
      input: {id: 'c-7', fullName: 'Corrupt Profile', years: 3, legacy: {profile: 'corrupt'}},
    },
    {
      id: 'bad-email',
      name: 'Wrong email type',
      input: {id: 'c-8', fullName: 'Bad Email', years: 4, legacy: {profile: {email: 5}}},
    },
  ];
  return [
    {
      id: 'payload-migration',
      name: 'Payload migration',
      revision: 1,
      steps,
      schema: {id: 'customer-v2', revision: 1, node: schema},
      samples,
      updatedAt: new Date(0).toISOString(),
    },
  ];
}
