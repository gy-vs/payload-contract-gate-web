import express from 'express';
import {fileURLToPath} from 'node:url';
import type {Json, PipelineDef, SchemaObject} from '../shared/types';
import {seedPipeline, seedSamples, seedSchema} from './seed';
import {WorkbenchStore} from './store';

type RecordRow = {id: string; name: string; revision: number; content: string; updatedAt: string};
const rows: RecordRow[] = [
  {id: 'alpha', name: 'Primary transform runs', revision: 3, content: 'transform runs: alpha\nstate: active', updatedAt: new Date(0).toISOString()},
  {id: 'beta', name: 'Secondary transform runs', revision: 5, content: 'transform runs: beta\nstate: review', updatedAt: new Date(1000).toISOString()},
];

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parsePipeline(body: unknown): PipelineDef | null {
  const obj = asObject(body);
  const steps = obj?.steps;
  if (!obj || !Array.isArray(steps)) return null;
  for (const step of steps) {
    const s = asObject(step);
    if (!s || typeof s.id !== 'string' || !s.id) return null;
    if (s.map !== undefined && (asObject(s.map) === null || Array.isArray(s.map))) return null;
    if (s.when !== undefined && typeof s.when !== 'string') return null;
  }
  return {steps: steps as PipelineDef['steps']};
}

export function createApp() {
  const app = express();
  app.use(express.json({limit: '1mb'}));
  const store = new WorkbenchStore(seedPipeline, seedSchema, seedSamples);

  /* ------------------------------- legacy API ------------------------------- */
  app.get('/api/bootstrap', (_req, res) => res.json({family: 'migration-mapping', count: rows.length}));
  app.get('/api/mappings', (_req, res) => res.json(rows.map(({content, ...row}) => row)));
  app.get('/api/mappings/:id', (req, res) => {
    const row = rows.find((value) => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    res.set('ETag', String(row.revision)).json(row);
  });
  app.put('/api/mappings/:id', (req, res) => {
    const row = rows.find((value) => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    if (req.body.revision !== row.revision) return res.status(409).json({error: 'revision_conflict', current: row});
    row.content = String(req.body.content ?? '');
    row.revision += 1;
    row.updatedAt = new Date().toISOString();
    res.json(row);
  });
  app.post('/api/mappings/:id/analyze', async (req, res) => {
    const row = rows.find((value) => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    await new Promise((resolve) => setTimeout(resolve, req.params.id === 'alpha' ? 100 : 20));
    res.json({id: row.id, revision: row.revision, lines: String(req.body.content ?? row.content).split(/\r?\n/).length, diagnostics: []});
  });

  /* ------------------------------ workbench API ----------------------------- */
  function workbenchPayload() {
    return {
      pipeline: store.pipeline,
      pipelineRevision: store.pipelineRevision,
      schema: store.schema,
      schemaRevision: store.schemaRevision,
      stepSummaries: store.summaries(),
      samples: store.samples.map(({input: _input, ...rest}) => rest),
    };
  }

  app.get('/api/workbench', (_req, res) => res.json(workbenchPayload()));

  app.get('/api/samples/:id', (req, res) => {
    const sample = store.samples.find((s) => s.id === req.params.id);
    if (!sample) return res.status(404).json({error: 'not_found'});
    res.set('ETag', String(sample.revision)).json(sample);
  });

  app.put('/api/samples/:id', (req, res) => {
    const revision = Number(req.body?.revision);
    if (!Number.isInteger(revision)) return res.status(400).json({error: 'bad_revision'});
    const input: unknown = req.body?.input;
    if (input !== undefined && asObject(input) === null && typeof input !== 'string' && typeof input !== 'number' && typeof input !== 'boolean') {
      return res.status(400).json({error: 'bad_input'});
    }
    const result = store.saveSample(
      req.params.id,
      {
        name: typeof req.body?.name === 'string' ? req.body.name : undefined,
        input: input as Json | undefined,
      },
      revision,
    );
    if (!result.ok) {
      const status = result.error === 'not_found' ? 404 : 409;
      return res.status(status).json({error: result.error});
    }
    res.json({sample: result.sample, revalidated: result.revalidated});
  });

  app.put('/api/pipeline', (req, res) => {
    const revision = Number(req.body?.revision);
    if (!Number.isInteger(revision)) return res.status(400).json({error: 'bad_revision'});
    const pipeline = parsePipeline(req.body?.pipeline);
    if (!pipeline) return res.status(400).json({error: 'bad_pipeline'});
    const changedStepIds = Array.isArray(req.body?.changedStepIds)
      ? req.body.changedStepIds.filter((id: unknown) => typeof id === 'string')
      : undefined;
    const result = store.savePipeline(pipeline, revision, changedStepIds);
    if (!result.ok) return res.status(409).json({error: result.error, currentRevision: store.pipelineRevision});
    res.json({
      ...workbenchPayload(),
      revalidated: result.revalidated,
      affectedSampleIds: result.affectedSampleIds,
    });
  });

  app.put('/api/schema', (req, res) => {
    const revision = Number(req.body?.revision);
    if (!Number.isInteger(revision)) return res.status(400).json({error: 'bad_revision'});
    const schema = asObject(req.body?.schema) as SchemaObject | null;
    if (!schema) return res.status(400).json({error: 'bad_schema'});
    const result = store.saveSchema(schema, revision);
    if (!result.ok) return res.status(409).json({error: result.error, currentRevision: store.schemaRevision});
    res.json({
      schema: store.schema,
      schemaRevision: store.schemaRevision,
      revalidated: result.revalidated,
    });
  });

  app.post('/api/validate', (req, res) => {
    const ids = req.body?.sampleIds;
    if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))) {
      return res.status(400).json({error: 'bad_sample_ids'});
    }
    const results = store.validateAll(ids as string[] | undefined);
    res.json({pipelineRevision: store.pipelineRevision, schemaRevision: store.schemaRevision, results});
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
