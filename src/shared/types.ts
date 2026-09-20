// Types shared between server validation engine and client UI.

export type Json = null | boolean | number | string | Json[] | {[key: string]: Json};

/** One transform step. `map` keys are destination paths, values are source path expressions. */
export type StepDef = {
  id: string;
  title?: string;
  when?: string;
  map?: Record<string, string>;
};

export type PipelineDef = {
  id?: string;
  steps: StepDef[];
};

export type SampleRecord = {id: string; name: string; revision: number; input: Json; updatedAt: string};

export type SchemaObject = {
  type?: string;
  required?: string[];
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  anyOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  additionalProperties?: SchemaObject | boolean;
};

export type Certainty = 'definite' | 'candidate';

export type AttributionReason =
  | 'concrete-write'
  | 'parent-replace'
  | 'wildcard-write'
  | 'dynamic-write'
  | 'required-missing'
  | 'unattributed';

export type Attribution = {
  stepId: string;
  index: number;
  title: string;
  certainty: Certainty;
  reason: AttributionReason;
};

export type PathKind = 'static' | 'wild' | 'dynamic';

export type PathSummaryEntry = {
  expr: string;
  kind: PathKind;
  /** Static prefix rendered as a path; empty string when the expression is dynamic from the root. */
  prefix: string;
};

export type StepPathSummary = {
  stepId: string;
  index: number;
  title: string;
  reads: PathSummaryEntry[];
  writes: PathSummaryEntry[];
};

export type GateErrorKeyword = 'required' | 'type' | 'union';

export type GateError = {
  path: string;
  keyword: GateErrorKeyword;
  message: string;
  missingProperty?: string;
  branchMessages?: string[];
  /** Nearest step that may have written the path. Absent together with `unattributed` when no step touches it. */
  primary?: Attribution;
  /** Other covering steps (earlier writers, or dynamic candidates), latest first. */
  candidates: Attribution[];
  unattributed: boolean;
};

export type SampleGateResult = {
  sampleId: string;
  sampleRevision: number;
  pipelineRevision: number;
  schemaRevision: number;
  cached: boolean;
  valid: boolean;
  executedStepIds: string[];
  errors: GateError[];
  output: Json;
};

export type ValidateResponse = {
  pipelineRevision: number;
  schemaRevision: number;
  results: SampleGateResult[];
};
