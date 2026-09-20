import {Seg, covers} from './paths';
import {StepSummary} from './pipeline';

export type AttributionCandidate = {
  stepId: string;
  stepName: string;
  via: string; // the write pattern that covers the error path
  dynamic: boolean; // the match relied on a runtime-decided `{expr}` segment
};

export type Attribution = {
  origin: 'pipeline' | 'source';
  stepId: string | null; // most recent step that statically could write the path
  certain: boolean; // false when a dynamic write could be the real cause
  candidates: AttributionCandidate[]; // all covering steps, most recent first
};

/**
 * Back-reference a final schema error path to the steps that could have
 * written it. The most recent *static* writer is reported as the primary
 * step; writes that depend on runtime expressions are only ever candidates —
 * we never fabricate a single cause when the path is decided dynamically.
 */
export function attributePath(path: Seg[], summaries: StepSummary[]): Attribution {
  const hits: {summary: StepSummary; via: string; dynamic: boolean}[] = [];
  for (const summary of summaries) {
    for (const write of summary.writes) {
      const match = covers(write, path);
      if (match.match) {
        hits.push({summary, via: write.raw, dynamic: match.dynamic});
        break; // one representative pattern per step is enough
      }
    }
  }
  hits.sort((a, b) => b.summary.order - a.summary.order);
  const candidates = hits.map(hit => ({
    stepId: hit.summary.id,
    stepName: hit.summary.name,
    via: hit.via,
    dynamic: hit.dynamic,
  }));
  const primary = hits.find(hit => !hit.dynamic);
  if (!primary) {
    return {
      origin: hits.length > 0 ? 'pipeline' : 'source',
      stepId: null,
      certain: hits.length === 0,
      candidates,
    };
  }
  const certain = !hits.some(hit => hit.dynamic && hit.summary.order > primary.summary.order);
  return {origin: 'pipeline', stepId: primary.summary.id, certain, candidates};
}
