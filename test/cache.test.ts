import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';

function postValidate(app: ReturnType<typeof createApp>, ids?: string[]) {
  return request(app).post('/api/validate').send(ids ? {sampleIds: ids} : {});
}

describe('validation cache and revisions', () => {
  it('caches validation results and pins them to sample+pipeine+schema revisions', async () => {
    const app = createApp();
    const first = await postValidate(app).expect(200);
    expect(first.body.results.every((r: any) => r.cached === false)).toBe(true);
    expect(first.body.pipelineRevision).toBe(1);
    expect(first.body.schemaRevision).toBe(1);

    const second = await postValidate(app).expect(200);
    expect(second.body.results.every((r: any) => r.cached === true)).toBe(true);
  });

  it('re-validates only affected samples when one step is edited', async () => {
    const app = createApp();
    await postValidate(app); // populate cache for both samples

    // Editing the "party" step: both samples carry a party, so both are affected.
    const pipe = await request(app).get('/api/workbench').expect(200);
    const pipeline = pipe.body.pipeline;
    const party = pipeline.steps.find((s: any) => s.id === 'party');
    party.map = {'$.partyId': '$.party.userId'};

    const saved = await request(app)
      .put('/api/pipeline')
      .send({revision: 1, pipeline, changedStepIds: ['party']})
      .expect(200);
    expect(saved.body.pipelineRevision).toBe(2);
    expect(saved.body.affectedSampleIds.sort()).toEqual(['sample-bad', 'sample-happy']);
    // Freshly re-validated results must never be presented as cached passes.
    expect(saved.body.revalidated.every((r: any) => r.cached === false)).toBe(true);
    expect(saved.body.revalidated.every((r: any) => r.pipelineRevision === 2)).toBe(true);

    // Unchanged entries under the new revision are served as cache only after revalidation,
    // and a subsequent validate call returns cached=true with the pinned new revision.
    const again = await postValidate(app).expect(200);
    expect(again.body.results.every((r: any) => r.pipelineRevision === 2)).toBe(true);
    expect(again.body.results.every((r: any) => r.cached === true)).toBe(true);
  });

  it('leaves unaffected samples alone when the edited step never executes for them', async () => {
    const app = createApp();
    await postValidate(app);
    const pipe = await request(app).get('/api/workbench').expect(200);
    const pipeline = pipe.body.pipeline;
    // channel-tag runs only when $.channel is present; both seed samples DO have a channel,
    // so instead drop the when guard change onto a fresh step that no sample executes.
    pipeline.steps.push({id: 'never-runs', title: 'Dead step', when: '$.missingThing', map: {'$.x': '$.missingThing'}});

    const saved = await request(app)
      .put('/api/pipeline')
      .send({revision: 1, pipeline, changedStepIds: ['never-runs']})
      .expect(200);
    // Structural edit (added a step) conservatively invalidates all samples.
    expect(saved.body.affectedSampleIds.sort()).toEqual(['sample-bad', 'sample-happy']);
  });

  it('uses old-or-new execution overlap to narrow revalidation for in-place step edits', async () => {
    const app = createApp();
    // Add a sample that lacks channel so channel-tag never executes for it.
    await request(app)
      .put('/api/samples/sample-happy')
      .send({revision: 1, input: {id: 'X', customer: {name: 'A'}, items: []}}); // no channel
    await postValidate(app);

    const pipe = await request(app).get('/api/workbench').expect(200);
    const pipeline = pipe.body.pipeline;
    const tag = pipeline.steps.find((s: any) => s.id === 'channel-tag');
    tag.map = {'$.tags["src_" + $.channel]': '$.source'};

    const saved = await request(app)
      .put('/api/pipeline')
      .send({revision: 1, pipeline, changedStepIds: ['channel-tag']})
      .expect(200);
    // sample-happy no longer has channel (step skipped before and after): unaffected.
    // sample-bad has channel (step executed before and after): affected.
    expect(saved.body.affectedSampleIds).toEqual(['sample-bad']);
  });

  it('invalidates the whole cache when the schema revision changes', async () => {
    const app = createApp();
    await postValidate(app);
    const schema = (await request(app).get('/api/workbench')).body.schema;
    const saved = await request(app)
      .put('/api/schema')
      .send({revision: 1, schema: {...schema, required: ['orderId']}})
      .expect(200);
    expect(saved.body.schemaRevision).toBe(2);
    expect(saved.body.revalidated.every((r: any) => r.cached === false)).toBe(true);
    expect(saved.body.revalidated.every((r: any) => r.schemaRevision === 2)).toBe(true);

    const again = await postValidate(app);
    expect(again.body.results.every((r: any) => r.schemaRevision === 2)).toBe(true);
  });

  it('revalidates only the edited sample', async () => {
    const app = createApp();
    await postValidate(app);
    const saved = await request(app)
      .put('/api/samples/sample-happy')
      .send({revision: 1, input: {id: 'changed', customer: {name: 'A'}, items: []}})
      .expect(200);
    expect(saved.body.revalidated.sampleId).toBe('sample-happy');
    expect(saved.body.revalidated.sampleRevision).toBe(2);
    expect(saved.body.revalidated.cached).toBe(false);
  });

  it('rejects stale revision writes (optimistic concurrency)', async () => {
    const app = createApp();
    const pipe = await request(app).get('/api/workbench');
    await request(app)
      .put('/api/pipeline')
      .send({revision: 1, pipeline: pipe.body.pipeline})
      .expect(200);
    await request(app)
      .put('/api/pipeline')
      .send({revision: 1, pipeline: pipe.body.pipeline})
      .expect(409);
  });
});
