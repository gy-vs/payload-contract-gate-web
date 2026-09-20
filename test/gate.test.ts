import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';

const PID = 'payload-migration';

async function validateAll(app: ReturnType<typeof createApp>) {
  const res = await request(app).post(`/api/pipelines/${PID}/validate`).send({}).expect(200);
  return res.body;
}

function resultFor(gate: any, sampleId: string) {
  const result = gate.results.find((r: any) => r.sampleId === sampleId);
  expect(result, `result for ${sampleId}`).toBeTruthy();
  return result;
}

describe('target schema gate', () => {
  it('exposes static read/write summaries per step, keeping dynamic segments dynamic', async () => {
    const app = createApp();
    const res = await request(app).get(`/api/pipelines/${PID}`).expect(200);
    const byId = Object.fromEntries(res.body.steps.map((s: any) => [s.id, s]));
    expect(byId.s4.writes.map((w: any) => w.raw)).toContain('items[].id');
    expect(byId.s5.writes[0]).toEqual({raw: 'attrs.{legacy.attrKey}', dynamic: true});
    expect(byId.s6.writes.map((w: any) => w.raw)).toContain('profile.age');
  });

  it('attributes a required error with no writing step to the source sample', async () => {
    const app = createApp();
    const gate = await validateAll(app);
    const result = resultFor(gate, 'missing-id');
    expect(result.status).toBe('failed');
    const error = result.errors.find((e: any) => e.code === 'required');
    expect(error.path).toBe('id');
    expect(error.attribution).toMatchObject({origin: 'source', stepId: null, candidates: []});
  });

  it('attributes union errors to the most recent of several writers of the same path', async () => {
    const app = createApp();
    const gate = await validateAll(app);
    const result = resultFor(gate, 'bad-age');
    const error = result.errors.find((e: any) => e.path === 'profile.age');
    expect(error.code).toBe('union');
    expect(error.expected).toBe('number | null');
    // s3 and s6 both write profile.age; the later step (s6) is primary.
    // s1 also appears as a candidate because it replaced the parent `profile`.
    expect(error.attribution.stepId).toBe('s6');
    expect(error.attribution.certain).toBe(true);
    expect(error.attribution.candidates.map((c: any) => c.stepId)).toEqual(['s6', 's3', 's1']);
  });

  it('attributes array element errors to the mapping step via items[] patterns', async () => {
    const app = createApp();
    const gate = await validateAll(app);
    const result = resultFor(gate, 'bad-item');
    const idError = result.errors.find((e: any) => e.path === 'items[1].id');
    const nameError = result.errors.find((e: any) => e.path === 'items[1].name');
    expect(idError.code).toBe('type');
    expect(nameError.code).toBe('required');
    expect(idError.attribution).toMatchObject({stepId: 's4', certain: true});
    expect(idError.attribution.candidates[0].via).toBe('items[].id');
    expect(nameError.attribution.candidates[0].via).toBe('items[].name');
  });

  it('attributes child errors to a step that replaced the parent path', async () => {
    const app = createApp();
    const gate = await validateAll(app);
    // s1 writes the whole `profile` subtree, so errors below it point back to s1
    const emailError = resultFor(gate, 'bad-email').errors.find((e: any) => e.path === 'profile.email');
    expect(emailError.code).toBe('type');
    expect(emailError.expected).toBe('string | null');
    expect(emailError.attribution).toMatchObject({stepId: 's1', certain: true});
    expect(emailError.attribution.candidates[0].via).toBe('profile');
    const profileError = resultFor(gate, 'bad-profile').errors.find((e: any) => e.path === 'profile');
    expect(profileError.code).toBe('type');
    expect(profileError.attribution.stepId).toBe('s1');
  });

  it('marks dynamically written paths as candidates instead of a fabricated cause', async () => {
    const app = createApp();
    const gate = await validateAll(app);
    const result = resultFor(gate, 'bad-attr');
    const error = result.errors.find((e: any) => e.path === 'attrs.level');
    expect(error.code).toBe('type');
    expect(error.attribution.origin).toBe('pipeline');
    expect(error.attribution.stepId).toBeNull();
    expect(error.attribution.certain).toBe(false);
    expect(error.attribution.candidates).toEqual([
      {stepId: 's5', stepName: 'Spread legacy attr', via: 'attrs.{legacy.attrKey}', dynamic: true},
    ]);
  });

  it('pins schema and pipeline revisions to the gate run and only revalidates affected samples', async () => {
    const app = createApp();
    const first = await validateAll(app);
    expect(first.pipelineRevision).toBe(1);
    expect(first.schemaRevision).toBe(1);
    expect(first.results.every((r: any) => r.revalidated)).toBe(true);

    // same revisions: served from the pinned cache, nothing revalidated
    const second = await validateAll(app);
    expect(second.results.every((r: any) => !r.revalidated)).toBe(true);

    // change the dynamic step to read a different source field; only samples
    // whose output actually changes are revalidated
    const pipeline = (await request(app).get(`/api/pipelines/${PID}`).expect(200)).body;
    const s5 = pipeline.steps.find((s: any) => s.id === 's5');
    const edit = await request(app)
      .put(`/api/pipelines/${PID}/steps/s5`)
      .send({step: {...s5, from: 'legacy.attrValue2'}, revision: pipeline.revision})
      .expect(200);
    expect(edit.body.pipeline.revision).toBe(2);
    expect(edit.body.invalidated).toBeGreaterThan(0);

    const third = await validateAll(app);
    expect(third.pipelineRevision).toBe(2);
    expect(resultFor(third, 'ok-basic').revalidated).toBe(true); // had legacy.attrValue
    expect(resultFor(third, 'bad-attr').revalidated).toBe(true); // had legacy.attrValue
    expect(resultFor(third, 'missing-id').revalidated).toBe(false); // output unchanged
    expect(resultFor(third, 'bad-age').revalidated).toBe(false);

    // stale writers are rejected
    await request(app)
      .put(`/api/pipelines/${PID}/steps/s5`)
      .send({step: {...s5, from: 'legacy.attrValue3'}, revision: pipeline.revision})
      .expect(409);
  });

  it('never reports a pre-edit verdict after the pipeline changes', async () => {
    const app = createApp();
    const before = await validateAll(app);
    expect(resultFor(before, 'ok-basic').status).toBe('passed');

    // break the pipeline: fullName no longer lands on profile.name
    const pipeline = (await request(app).get(`/api/pipelines/${PID}`).expect(200)).body;
    const s2 = pipeline.steps.find((s: any) => s.id === 's2');
    await request(app)
      .put(`/api/pipelines/${PID}/steps/s2`)
      .send({step: {...s2, path: 'profile.fullName'}, revision: pipeline.revision})
      .expect(200);

    const after = await validateAll(app);
    const result = resultFor(after, 'ok-basic');
    expect(result.revalidated).toBe(true);
    expect(result.status).toBe('failed');
    const error = result.errors.find((e: any) => e.path === 'profile.name');
    expect(error.code).toBe('required');
    // profile.fullName is still covered by s1's parent write of `profile`
    expect(error.attribution.stepId).toBe('s1');
  });

  it('revalidates every sample when the schema revision changes', async () => {
    const app = createApp();
    await validateAll(app);
    const pipeline = (await request(app).get(`/api/pipelines/${PID}`).expect(200)).body;
    const tightened = {
      ...pipeline.schema.node,
      required: ['id', 'profile', 'attrs'],
    };
    const edit = await request(app)
      .put(`/api/pipelines/${PID}/schema`)
      .send({schema: tightened, revision: pipeline.schemaRevision})
      .expect(200);
    expect(edit.body.pipeline.schemaRevision).toBe(2);

    const gate = await validateAll(app);
    expect(gate.schemaRevision).toBe(2);
    // outputs are identical, but the schema revision bump invalidates reuse
    expect(gate.results.every((r: any) => r.revalidated)).toBe(true);
    expect(resultFor(gate, 'ok-basic').status).toBe('passed'); // has attrs
    expect(resultFor(gate, 'missing-id').status).toBe('failed'); // no attrs
  });
});
