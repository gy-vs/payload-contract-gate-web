import {describe, expect, it} from 'vitest';
import {affectedSampleIds, diffPipelines, isCurrent, parseJsonInput} from './impact';
import type {PipelineDef, SampleGateResult} from '../shared/types';

function result(sampleId: string, executedStepIds: string[], revisions = {pipelineRevision: 1, schemaRevision: 1, sampleRevision: 1}): SampleGateResult {
  return {
    sampleId,
    ...revisions,
    cached: false,
    valid: true,
    executedStepIds,
    errors: [],
    output: {},
  };
}

const pipeline = (ids: string[]): PipelineDef => ({steps: ids.map((id) => ({id, map: {'$.a': '$.b'}}))});

describe('affectedSampleIds', () => {
  const prev = {
    s1: result('s1', ['a', 'b']),
    s2: result('s2', ['a']),
    s3: result('s3', ['c']),
  };

  it('selects only samples whose executed set intersects the edited steps', () => {
    expect([...affectedSampleIds(prev, ['b'], false)].sort()).toEqual(['s1']);
  });

  it('includes samples on both old and new execution overlap (union semantics live on server)', () => {
    expect([...affectedSampleIds(prev, ['a'], false)].sort()).toEqual(['s1', 's2']);
  });

  it('treats a structural change as affecting every cached sample', () => {
    expect([...affectedSampleIds(prev, [], true)].sort()).toEqual(['s1', 's2', 's3']);
  });

  it('treats an empty step hint conservatively', () => {
    expect([...affectedSampleIds(prev, [], false)].sort()).toEqual(['s1', 's2', 's3']);
  });
});

describe('isCurrent', () => {
  it('is false without a result', () => {
    expect(isCurrent(undefined, {pipelineRevision: 1, schemaRevision: 1, sampleRevision: 1})).toBe(false);
  });
  it('is false when any pinned revision differs (no stale pass shown)', () => {
    const r = result('s1', ['a'], {pipelineRevision: 1, schemaRevision: 1, sampleRevision: 1});
    expect(isCurrent(r, {pipelineRevision: 2, schemaRevision: 1, sampleRevision: 1})).toBe(false);
    expect(isCurrent(r, {pipelineRevision: 1, schemaRevision: 2, sampleRevision: 1})).toBe(false);
    expect(isCurrent(r, {pipelineRevision: 1, schemaRevision: 1, sampleRevision: 2})).toBe(false);
  });
  it('is true only when all three revisions match', () => {
    const r = result('s1', ['a']);
    expect(isCurrent(r, {pipelineRevision: 1, schemaRevision: 1, sampleRevision: 1})).toBe(true);
  });
});

describe('diffPipelines', () => {
  it('detects added/removed/reordered steps as structural', () => {
    expect(diffPipelines(pipeline(['a', 'b']), pipeline(['a', 'b', 'c'])).structural).toBe(true);
    expect(diffPipelines(pipeline(['a', 'b']), pipeline(['b', 'a'])).structural).toBe(true);
  });
  it('reports edited step ids for in-place edits', () => {
    const prev = pipeline(['a', 'b']);
    const next = pipeline(['a', 'b']);
    next.steps[1].map = {'$.x': '$.y'};
    const diff = diffPipelines(prev, next);
    expect(diff.structural).toBe(false);
    expect(diff.changedStepIds).toEqual(['b']);
  });
});

describe('parseJsonInput', () => {
  it('parses an object', () => {
    expect(parseJsonInput('{"a":1}').ok).toBe(true);
  });
  it('rejects arrays, scalars and invalid JSON', () => {
    expect(parseJsonInput('[]').ok).toBe(false);
    expect(parseJsonInput('42').ok).toBe(false);
    expect(parseJsonInput('{').ok).toBe(false);
  });
});
