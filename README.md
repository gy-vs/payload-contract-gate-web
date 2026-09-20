# Payload Migration Workbench

Local workbench for transform runs with a **target schema gate**: after each
sample is transformed, the server validates the output against the target
schema and attributes every failure back to the pipeline steps that could
have written the failing path — not just a flat list of schema errors.

Run `npm install`, then `npm run dev`. Tests: `npm test`.

## How the gate works

- The server keeps a static read/write path summary per step
  (`GET /api/pipelines/:id`). Writes may contain `[]` (every array element)
  or `{expr}` (runtime-decided) segments.
- Each validation error is back-referenced to the most recent step whose
  write pattern covers the error path — including writes to a parent path,
  which replace the whole subtree. All covering steps are listed as
  candidates, most recent first.
- Dynamic (`{expr}`) writes are only ever reported as *candidates*
  (`certain: false`, `stepId: null` when no static writer exists); the gate
  never fabricates a single cause for a path it cannot statically resolve.
- The schema revision is pinned together with the pipeline revision: every
  gate run is stamped with both, and any change to either invalidates the
  cached verdicts (`invalidated` count on `PUT` responses).
- After a step edit, only affected samples are revalidated: a sample whose
  transformed output is byte-identical under the new revision (with an
  unchanged schema revision) provably keeps its verdict and is reported as
  `revalidated: false` / `reused: true` instead of being re-stamped.
- The UI marks all displayed verdicts stale as soon as the pipeline or
  schema revision moves, so old results are never shown as current passes.
  Clicking an error jumps to the responsible step while keeping the sample
  context (the sample stays selected and its value at the error path is
  shown next to the step editor).

## API

- `GET  /api/pipelines` / `GET /api/pipelines/:id` — pipeline with per-step read/write summaries
- `GET  /api/pipelines/:id/samples` — sample inputs
- `PUT  /api/pipelines/:id/steps/:stepId` — replace a step (`{step, revision}`, 409 on conflict)
- `PUT  /api/pipelines/:id/schema` — replace the target schema (`{schema, revision}`, 409 on conflict)
- `POST /api/pipelines/:id/validate` — run the gate (`{sampleIds?}`), returns per-sample
  status, attributed errors, transformed output, and revalidation flags
