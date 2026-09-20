import {useCallback, useEffect, useState} from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Braces,
  CheckCircle2,
  CircleDashed,
  CircleHelp,
  FlaskConical,
  ListOrdered,
  Play,
  Save,
  Shuffle,
  XCircle,
} from 'lucide-react';

type WritePattern = {raw: string; dynamic: boolean};
type StepDto = {
  id: string;
  name: string;
  kind: string;
  path?: string;
  from?: string;
  value?: unknown;
  pathTemplate?: string;
  item?: StepDto[];
  reads: string[];
  writes: WritePattern[];
};
type PipelineDto = {
  id: string;
  name: string;
  revision: number;
  schemaRevision: number;
  steps: StepDto[];
  schema: {id: string; revision: number; node: unknown};
};
type SampleDto = {id: string; name: string; input: unknown};
type Candidate = {stepId: string; stepName: string; via: string; dynamic: boolean};
type ErrorDto = {
  path: string;
  segments: (string | number)[];
  code: string;
  message: string;
  expected?: string;
  actual?: string;
  attribution: {origin: 'pipeline' | 'source'; stepId: string | null; certain: boolean; candidates: Candidate[]};
};
type ResultDto = {sampleId: string; status: 'passed' | 'failed'; revalidated: boolean; reused: boolean; errors: ErrorDto[]; output: unknown};
type GateDto = {pipelineId: string; pipelineRevision: number; schemaRevision: number; validatedAt: string; results: ResultDto[]};
type Focus = {path: string; segments: (string | number)[]};

const PIPELINE_ID = 'payload-migration';

function getAtSegments(value: unknown, segments: (string | number)[]): unknown {
  let cur = value;
  for (const seg of segments) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg as string];
  }
  return cur;
}

/** Strip server-decorated fields so the draft round-trips as a plain step. */
function editableStep(step: StepDto): Partial<StepDto> {
  const {reads: _reads, writes: _writes, ...rest} = step;
  return rest;
}

export default function App() {
  const [pipeline, setPipeline] = useState<PipelineDto | null>(null);
  const [samples, setSamples] = useState<SampleDto[]>([]);
  const [gate, setGate] = useState<GateDto | null>(null);
  const [selectedSampleId, setSelectedSampleId] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [stepDraft, setStepDraft] = useState('');
  const [schemaDraft, setSchemaDraft] = useState('');
  const [notice, setNotice] = useState('Ready');

  const loadPipeline = useCallback(async (): Promise<PipelineDto> => {
    const res = await fetch(`/api/pipelines/${PIPELINE_ID}`);
    const body = (await res.json()) as PipelineDto;
    setPipeline(body);
    return body;
  }, []);

  const runGate = useCallback(async () => {
    setNotice('Running gate…');
    const res = await fetch(`/api/pipelines/${PIPELINE_ID}/validate`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: '{}',
    });
    const body = (await res.json()) as GateDto;
    setGate(body);
    setNotice(`Gate finished · ${body.results.filter(r => r.revalidated).length} revalidated, ${body.results.filter(r => !r.revalidated).length} unchanged`);
  }, []);

  useEffect(() => {
    void (async () => {
      const loaded = await loadPipeline();
      const sampleList = (await (await fetch(`/api/pipelines/${PIPELINE_ID}/samples`)).json()) as SampleDto[];
      setSamples(sampleList);
      setSelectedSampleId(sampleList[0]?.id ?? null);
      setSelectedStepId(loaded.steps[0]?.id ?? null);
      await runGate();
    })();
  }, [loadPipeline, runGate]);

  const selectedStep = pipeline?.steps.find(step => step.id === selectedStepId) ?? null;
  const selectedSample = samples.find(sample => sample.id === selectedSampleId) ?? null;
  const selectedResult = gate?.results.find(result => result.sampleId === selectedSampleId) ?? null;
  // Old verdicts must never be shown as current: as soon as either revision
  // moves, everything from the previous run renders as stale, not as passed.
  const stale = Boolean(pipeline && gate && (gate.pipelineRevision !== pipeline.revision || gate.schemaRevision !== pipeline.schemaRevision));

  useEffect(() => {
    if (selectedStep) setStepDraft(JSON.stringify(editableStep(selectedStep), null, 2));
  }, [selectedStepId, pipeline?.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (pipeline) setSchemaDraft(JSON.stringify(pipeline.schema.node, null, 2));
  }, [pipeline?.schemaRevision]); // eslint-disable-line react-hooks/exhaustive-deps

  async function applyStep() {
    if (!pipeline || !selectedStep) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stepDraft);
    } catch {
      setNotice('Step JSON is invalid');
      return;
    }
    delete parsed.reads;
    delete parsed.writes;
    parsed.id = selectedStep.id;
    const res = await fetch(`/api/pipelines/${PIPELINE_ID}/steps/${selectedStep.id}`, {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({step: parsed, revision: pipeline.revision}),
    });
    if (res.status === 409) {
      setNotice('Revision conflict — pipeline reloaded');
      await loadPipeline();
      return;
    }
    if (!res.ok) {
      const body = await res.json();
      setNotice(`Step rejected: ${body.message ?? body.error}`);
      return;
    }
    const body = await res.json();
    setPipeline(body.pipeline); // revision bump makes current results stale immediately
    setNotice(`Step saved · ${body.invalidated} cached verdicts invalidated`);
    await runGate(); // only affected samples are actually revalidated
  }

  async function applySchema() {
    if (!pipeline) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(schemaDraft);
    } catch {
      setNotice('Schema JSON is invalid');
      return;
    }
    const res = await fetch(`/api/pipelines/${PIPELINE_ID}/schema`, {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({schema: parsed, revision: pipeline.schemaRevision}),
    });
    if (res.status === 409) {
      setNotice('Schema revision conflict — pipeline reloaded');
      await loadPipeline();
      return;
    }
    if (!res.ok) {
      setNotice('Schema rejected');
      return;
    }
    const body = await res.json();
    setPipeline(body.pipeline);
    setNotice(`Schema saved · ${body.invalidated} cached verdicts invalidated`);
    await runGate();
  }

  /** Jump from an error to the responsible step while keeping the sample context. */
  function jumpToError(error: ErrorDto) {
    const target = error.attribution.stepId ?? error.attribution.candidates[0]?.stepId ?? null;
    if (target) setSelectedStepId(target);
    setFocus({path: error.path, segments: error.segments});
  }

  function badge(result: ResultDto | null) {
    if (!gate || stale || !result) {
      return (
        <span className="badge stale">
          <CircleDashed size={13} /> stale
        </span>
      );
    }
    const unchanged = result.revalidated ? null : <em>· unchanged</em>;
    return result.status === 'passed' ? (
      <span className="badge pass">
        <CheckCircle2 size={13} /> pass {unchanged}
      </span>
    ) : (
      <span className="badge fail">
        <XCircle size={13} /> fail ({result.errors.length}) {unchanged}
      </span>
    );
  }

  function attributionLine(error: ErrorDto) {
    const attribution = error.attribution;
    if (attribution.origin === 'source') {
      return (
        <div className="attrib">
          <CircleHelp size={13} /> No step writes this path — check the source sample.
        </div>
      );
    }
    const primary = attribution.stepId ? pipeline?.steps.find(step => step.id === attribution.stepId) : null;
    const others = attribution.candidates.filter(candidate => candidate.stepId !== attribution.stepId);
    return (
      <div className="attrib">
        {attribution.certain ? <ArrowRight size={13} /> : <Shuffle size={13} />}
        {primary ? (
          <>
            step <strong>{primary.name}</strong>
          </>
        ) : (
          ' no definite step'
        )}
        {!attribution.certain && <span className="uncertain">uncertain — dynamic path</span>}
        {others.length > 0 && (
          <span className="also">
            also:
            {others.map(candidate => (
              <button
                key={candidate.stepId}
                className="chip"
                title={`writes ${candidate.via}`}
                onClick={() => setSelectedStepId(candidate.stepId)}
              >
                {candidate.stepName}
                {candidate.dynamic ? ' ⚡' : ''}
              </button>
            ))}
          </span>
        )}
      </div>
    );
  }

  const focusValue = focus && selectedResult && !stale ? getAtSegments(selectedResult.output, focus.segments) : undefined;

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>Payload Migration Workbench</strong>
        <small>target schema gate</small>
        <span className="spacer" />
        {pipeline && (
          <span className="pill">
            pipeline r{pipeline.revision} · schema r{pipeline.schemaRevision}
          </span>
        )}
        <button className="primary" onClick={runGate}>
          <Play size={15} /> Run gate
        </button>
      </header>
      {stale && (
        <div className="banner">
          <AlertTriangle size={14} /> Pipeline or schema changed — displayed verdicts are stale until the gate re-runs.
        </div>
      )}
      <section className="workspace">
        <aside className="pane">
          <h2>
            <ListOrdered size={15} /> Transform steps
          </h2>
          <div className="list">
            {pipeline?.steps.map(step => (
              <button key={step.id} className={step.id === selectedStepId ? 'active' : ''} onClick={() => setSelectedStepId(step.id)}>
                <strong>{step.name}</strong> <small>{step.kind}</small>
                <span className="writes">
                  {step.writes.map(write => (
                    <code key={write.raw} className={write.dynamic ? 'dyn' : ''} title={write.dynamic ? 'runtime-decided path' : 'static write'}>
                      {write.raw}
                      {write.dynamic ? ' ⚡' : ''}
                    </code>
                  ))}
                </span>
              </button>
            ))}
          </div>
          {selectedStep && (
            <div className="editor">
              <h3>Edit step</h3>
              {selectedStep.reads.length > 0 && <p className="reads">reads: {selectedStep.reads.join(', ')}</p>}
              <textarea aria-label="Step JSON" value={stepDraft} onChange={event => setStepDraft(event.target.value)} />
              <div className="toolbar">
                <button className="primary" onClick={applyStep}>
                  <Save size={14} /> Apply step
                </button>
                <span>{notice}</span>
              </div>
              {focus && (
                <div className="focus">
                  <strong>Sample context</strong> · {selectedSampleId} · <code>{focus.path}</code>
                  <pre>{focusValue === undefined ? '(absent)' : JSON.stringify(focusValue, null, 2)}</pre>
                </div>
              )}
            </div>
          )}
        </aside>
        <section className="pane">
          <h2>Samples</h2>
          <div className="list">
            {samples.map(sample => {
              const result = gate?.results.find(entry => entry.sampleId === sample.id) ?? null;
              return (
                <button
                  key={sample.id}
                  className={sample.id === selectedSampleId ? 'active' : ''}
                  onClick={() => {
                    setSelectedSampleId(sample.id);
                    setFocus(null);
                  }}
                >
                  {sample.name} {badge(result)}
                </button>
              );
            })}
          </div>
          {selectedSample && (
            <div className="detail">
              <h3>Input</h3>
              <pre>{JSON.stringify(selectedSample.input, null, 2)}</pre>
              <h3>Output {stale ? '(stale)' : ''}</h3>
              <pre>{!stale && selectedResult ? JSON.stringify(selectedResult.output, null, 2) : '— run the gate —'}</pre>
              {!stale && selectedResult && selectedResult.errors.length > 0 && (
                <>
                  <h3>Gate errors</h3>
                  <ul className="errors">
                    {selectedResult.errors.map(error => (
                      <li key={`${error.path}:${error.code}`} className={error.path === focus?.path ? 'focused' : ''}>
                        <button className="link" onClick={() => jumpToError(error)}>
                          <code>{error.path}</code> — {error.message}
                        </button>
                        {attributionLine(error)}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </section>
        <aside className="pane">
          <h2>
            <Braces size={15} /> Target schema
          </h2>
          <textarea aria-label="Schema JSON" value={schemaDraft} onChange={event => setSchemaDraft(event.target.value)} />
          <div className="toolbar">
            <button className="primary" onClick={applySchema}>
              <Save size={14} /> Save schema
            </button>
          </div>
          {gate && (
            <div className="summary">
              <p>
                Gate run @ pipeline r{gate.pipelineRevision} · schema r{gate.schemaRevision} · {new Date(gate.validatedAt).toLocaleTimeString()}
              </p>
              <p>
                {gate.results.filter(result => result.revalidated).length} revalidated · {gate.results.filter(result => !result.revalidated).length} unchanged
              </p>
            </div>
          )}
        </aside>
      </section>
    </main>
  );
}
