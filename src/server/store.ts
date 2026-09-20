import type {Json, PipelineDef, SampleGateResult, SampleRecord, SchemaObject, StepPathSummary} from '../shared/types';
import {pipelineSummary, runPipeline, validateSample} from './engine';
import {validate} from './validator';

export type {SampleRecord};

export class WorkbenchStore {
  pipeline: PipelineDef;
  pipelineRevision = 1;
  schema: SchemaObject;
  schemaRevision = 1;
  samples: SampleRecord[] = [];
  // Keyed by sample id; an entry is usable only while its embedded revisions match the store.
  private cache = new Map<string, SampleGateResult>();

  constructor(pipeline: PipelineDef, schema: SchemaObject, samples: SampleRecord[]) {
    this.pipeline = pipeline;
    this.schema = schema;
    this.samples = samples.map((s) => ({...s}));
  }

  summaries(): StepPathSummary[] {
    return pipelineSummary(this.pipeline);
  }

  savePipeline(
    pipeline: PipelineDef,
    expectedRevision: number,
    changedStepIds?: string[],
  ):
    | {ok: true; revision: number; revalidated: SampleGateResult[]; affectedSampleIds: string[]}
    | {ok: false; error: string} {
    if (expectedRevision !== this.pipelineRevision) return {ok: false, error: 'revision_conflict'};
    const oldPipeline = this.pipeline;
    this.pipeline = pipeline;
    this.pipelineRevision += 1;

    // Determine which samples the edit can possibly affect.
    // - structural change (step set/order) or no hint => all samples with cached results
    // - concrete edited step ids => samples whose old OR new run executed one of those steps
    const oldIds = oldPipeline.steps.map((s) => s.id);
    const newIds = pipeline.steps.map((s) => s.id);
    const structural = oldIds.length !== newIds.length || oldIds.some((id, i) => id !== newIds[i]);
    const affectedSampleIds: string[] = [];

    for (const sample of this.samples) {
      if (!this.cache.has(sample.id)) continue; // nothing stale: computed lazily later
      let affected = structural || !changedStepIds || changedStepIds.length === 0;
      if (!affected) {
        const before = runPipeline(oldPipeline, sample.input).executedStepIds;
        const after = runPipeline(pipeline, sample.input).executedStepIds;
        affected =
          before.some((id) => changedStepIds!.includes(id)) ||
          after.some((id) => changedStepIds!.includes(id));
      }
      if (affected) {
        this.cache.delete(sample.id);
        affectedSampleIds.push(sample.id);
      } else {
        // Proven unaffected: its result is semantically the same, but the cache entry must
        // carry the new revision triple or it would look like stale data.
        this.restamp(sample.id);
      }
    }

    const revalidated = this.validateAll(affectedSampleIds);
    return {ok: true, revision: this.pipelineRevision, revalidated, affectedSampleIds};
  }

  saveSchema(
    schema: SchemaObject,
    expectedRevision: number,
  ): {ok: true; revision: number; revalidated: SampleGateResult[]} | {ok: false; error: string} {
    if (expectedRevision !== this.schemaRevision) return {ok: false, error: 'revision_conflict'};
    this.schema = schema;
    this.schemaRevision += 1;
    // Schema revision is pinned together with pipeline revision: any change invalidates
    // every cached validation result.
    this.cache.clear();
    return {ok: true, revision: this.schemaRevision, revalidated: this.validateAll()};
  }

  saveSample(
    id: string,
    patch: {name?: string; input?: Json},
    expectedRevision: number,
  ): {ok: true; sample: SampleRecord; revalidated: SampleGateResult | null} | {ok: false; error: string} {
    const sample = this.samples.find((s) => s.id === id);
    if (!sample) return {ok: false, error: 'not_found'};
    if (expectedRevision !== sample.revision) return {ok: false, error: 'revision_conflict'};
    if (patch.name !== undefined) sample.name = patch.name;
    if (patch.input !== undefined) sample.input = patch.input;
    sample.revision += 1;
    sample.updatedAt = new Date().toISOString();
    this.cache.delete(id); // only this sample's result is stale
    const revalidated = this.validateSample(id);
    return {ok: true, sample, revalidated};
  }

  validateSample(sampleId: string): SampleGateResult | null {
    const sample = this.samples.find((s) => s.id === sampleId);
    if (!sample) return null;
    const hit = this.cache.get(sampleId);
    if (
      hit &&
      hit.sampleRevision === sample.revision &&
      hit.pipelineRevision === this.pipelineRevision &&
      hit.schemaRevision === this.schemaRevision
    ) {
      return {...hit, cached: true};
    }
    const result = validateSample(
      this.pipeline,
      this.schema,
      {id: sample.id, input: sample.input},
      {
        sampleRevision: sample.revision,
        pipelineRevision: this.pipelineRevision,
        schemaRevision: this.schemaRevision,
      },
      validate,
    );
    this.cache.set(sampleId, result);
    return result;
  }

  validateAll(sampleIds?: string[]): SampleGateResult[] {
    const ids = sampleIds ?? this.samples.map((s) => s.id);
    return ids.map((id) => this.validateSample(id)).filter((r): r is SampleGateResult => r !== null);
  }

  private restamp(sampleId: string): void {
    const sample = this.samples.find((s) => s.id === sampleId);
    const hit = this.cache.get(sampleId);
    if (!sample || !hit) return;
    this.cache.set(sampleId, {
      ...hit,
      sampleRevision: sample.revision,
      pipelineRevision: this.pipelineRevision,
      schemaRevision: this.schemaRevision,
    });
  }
}
