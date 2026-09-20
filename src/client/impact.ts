import type {Json, PipelineDef, SampleGateResult} from '../shared/types';

/**
 * Client-side impact analysis. After a step edit, only samples that previously executed
 * one of the edited steps need revalidation. The server is authoritative; this lets the UI
 * immediately mark stale samples (never show an old pass) without revalidating everything.
 */
export function affectedSampleIds(
  prevResults: Record<string, SampleGateResult>,
  changedStepIds: string[],
  structural: boolean,
): Set<string> {
  const affected = new Set<string>();
  for (const [sampleId, result] of Object.entries(prevResults)) {
    if (structural || changedStepIds.length === 0) {
      affected.add(sampleId);
      continue;
    }
    if (result.executedStepIds.some((id) => changedStepIds.includes(id))) affected.add(sampleId);
  }
  return affected;
}

/** Has this result been computed against the current pipeline/schema/sample revisions? */
export function isCurrent(
  result: SampleGateResult | undefined,
  revisions: {pipelineRevision: number; schemaRevision: number; sampleRevision: number},
): boolean {
  if (!result) return false;
  return (
    result.pipelineRevision === revisions.pipelineRevision &&
    result.schemaRevision === revisions.schemaRevision &&
    result.sampleRevision === revisions.sampleRevision
  );
}

export function parseJsonInput(text: string): {ok: true; value: Json} | {ok: false; error: string} {
  try {
    const value = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return {ok: false, error: '样例输入必须是 JSON 对象'};
    }
    return {ok: true, value: value as Json};
  } catch (err) {
    return {ok: false, error: err instanceof Error ? err.message : 'JSON 解析失败'};
  }
}

export type StructuralCheck = {structural: boolean; changedStepIds: string[]};

/** Diff two pipelines: structural if step ids/order changed; otherwise return edited step ids. */
export function diffPipelines(prev: PipelineDef, next: PipelineDef): StructuralCheck {
  const prevIds = prev.steps.map((s) => s.id);
  const nextIds = next.steps.map((s) => s.id);
  if (prevIds.length !== nextIds.length || prevIds.some((id, i) => id !== nextIds[i])) {
    return {structural: true, changedStepIds: []};
  }
  const changedStepIds: string[] = [];
  prev.steps.forEach((step, i) => {
    const other = next.steps[i];
    if (
      step.when !== other.when ||
      JSON.stringify(step.map ?? {}) !== JSON.stringify(other.map ?? {}) ||
      step.title !== other.title
    ) {
      changedStepIds.push(step.id);
    }
  });
  return {structural: false, changedStepIds};
}
