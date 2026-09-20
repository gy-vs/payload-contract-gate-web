import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  FlaskConical,
  Save,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import type {
  Attribution,
  GateError,
  Json,
  PipelineDef,
  SampleGateResult,
  SampleRecord,
  SchemaObject,
  StepDef,
  StepPathSummary,
} from '../shared/types';
import {diffPipelines, isCurrent, parseJsonInput} from './impact';

type Workbench = {
  pipeline: PipelineDef;
  pipelineRevision: number;
  schema: SchemaObject;
  schemaRevision: number;
  stepSummaries: StepPathSummary[];
  samples: Omit<SampleRecord, 'input'>[];
};

type SampleDetail = SampleRecord;
type Revisions = {pipelineRevision: number; schemaRevision: number};

const reasonLabel: Record<Attribution['reason'], string> = {
  'concrete-write': '直接写入该路径',
  'parent-replace': '写入了父路径（整棵替换）',
  'wildcard-write': '通配映射写入该元素',
  'dynamic-write': '动态表达式可能写入',
  'required-missing': '本应创建该路径',
  unattributed: '无步骤触达',
};

export default function App() {
  const [bench, setBench] = useState<Workbench | null>(null);
  const [pipelineDraft, setPipelineDraft] = useState<PipelineDef | null>(null);
  const [selectedSample, setSelectedSample] = useState('sample-happy');
  const [sample, setSample] = useState<SampleDetail | null>(null);
  const [sampleText, setSampleText] = useState('');
  const [results, setResults] = useState<Record<string, SampleGateResult>>({});
  const [stale, setStale] = useState<Set<string>>(new Set());
  const [activeStep, setActiveStep] = useState<string | null>(null);
  const [activeErrorPath, setActiveErrorPath] = useState<string | null>(null);
  const [status, setStatus] = useState('就绪');
  const [validating, setValidating] = useState(false);
  const [savingStep, setSavingStep] = useState(false);

  const loadWorkbench = useCallback(async () => {
    const value = (await (await fetch('/api/workbench')).json()) as Workbench;
    setBench(value);
    setPipelineDraft(value.pipeline);
  }, []);

  useEffect(() => {
    loadWorkbench();
  }, [loadWorkbench]);

  const loadSample = useCallback(async () => {
    const value = (await (await fetch('/api/samples/' + selectedSample)).json()) as SampleDetail;
    setSample(value);
    setSampleText(JSON.stringify(value.input, null, 2));
  }, [selectedSample]);

  useEffect(() => {
    loadSample();
  }, [loadSample]);

  const runValidation = useCallback(
    async (sampleIds?: string[]) => {
      setValidating(true);
      setStatus('正在校验…');
      const response = await fetch('/api/validate', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(sampleIds ? {sampleIds} : {}),
      });
      const data = (await response.json()) as Revisions & {results: SampleGateResult[]};
      setResults((prev) => {
        const next = {...prev};
        for (const result of data.results) {
          next[result.sampleId] = result;
        }
        return next;
      });
      setStale((prev) => {
        const next = new Set(prev);
        for (const result of data.results) next.delete(result.sampleId);
        return next;
      });
      setValidating(false);
      setStatus(data.results.every((r) => r.valid) ? '全部通过' : '存在门禁错误');
    },
    [],
  );

  // Initial full validation once the workbench is loaded.
  const bootstrappedRef = useRef(false);
  useEffect(() => {
    if (bench && !bootstrappedRef.current) {
      bootstrappedRef.current = true;
      void runValidation();
    }
  }, [bench, runValidation]);

  const stepById = useMemo(() => {
    const map = new Map<string, StepDef>();
    pipelineDraft?.steps.forEach((step) => map.set(step.id, step));
    return map;
  }, [pipelineDraft]);

  const summaryByStep = useMemo(() => {
    const map = new Map<string, StepPathSummary>();
    bench?.stepSummaries.forEach((summary) => map.set(summary.stepId, summary));
    return map;
  }, [bench]);

  const currentResult = results[selectedSample];
  const sampleMeta = bench?.samples.find((s) => s.id === selectedSample);
  const resultCurrent =
    bench &&
    sampleMeta &&
    isCurrent(currentResult, {
      pipelineRevision: bench.pipelineRevision,
      schemaRevision: bench.schemaRevision,
      sampleRevision: sampleMeta.revision,
    });
  const isStale = stale.has(selectedSample);

  async function saveStep(stepId: string) {
    if (!bench || !pipelineDraft) return;
    const prev = bench.pipeline;
    const diff = diffPipelines(prev, pipelineDraft);
    const onlyChanged = !diff.structural && diff.changedStepIds.length === 1 && diff.changedStepIds[0] === stepId;
    setSavingStep(true);
    setStatus('正在保存步骤…');
    const response = await fetch('/api/pipeline', {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        revision: bench.pipelineRevision,
        pipeline: pipelineDraft,
        changedStepIds: onlyChanged ? [stepId] : undefined,
      }),
    });
    if (response.status === 409) {
      setStatus('Revision 冲突，请刷新');
      setSavingStep(false);
      return;
    }
    const data = (await response.json()) as Workbench & {
      revalidated: SampleGateResult[];
      affectedSampleIds: string[];
    };
    setBench({
      pipeline: data.pipeline,
      pipelineRevision: data.pipelineRevision,
      schema: data.schema,
      schemaRevision: data.schemaRevision,
      stepSummaries: data.stepSummaries,
      samples: data.samples,
    });
    setPipelineDraft(data.pipeline);

    // Merge revalidated results; mark every other cached sample stale so old passes can't show.
    setResults((prevResults) => {
      const next = {...prevResults};
      for (const result of data.revalidated) next[result.sampleId] = result;
      return next;
    });
    // The server revalidates every affected sample immediately; unaffected samples are
    // re-stamped to the new revision because their output is proven identical, so nothing
    // remains stale after a successful save.
    setStale(new Set());
    setStatus(
      data.affectedSampleIds.length
        ? `已保存：重验 ${data.affectedSampleIds.length} 个受影响样例`
        : '已保存：无样例受影响',
    );
    setSavingStep(false);
  }

  async function saveSample() {
    if (!sample || !bench) return;
    const parsed = parseJsonInput(sampleText);
    if (!parsed.ok) {
      setStatus('样例 JSON 无效：' + parsed.error);
      return;
    }
    const response = await fetch('/api/samples/' + sample.id, {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({revision: sample.revision, input: parsed.value}),
    });
    if (response.status === 409) {
      setStatus('样例 Revision 冲突');
      return;
    }
    const data = (await response.json()) as {sample: SampleDetail; revalidated: SampleGateResult};
    setSample(data.sample);
    setBench((b) =>
      b
        ? {...b, samples: b.samples.map((s) => (s.id === data.sample.id ? data.sample : s))}
        : b,
    );
    setResults((prev) => ({...prev, [data.sample.id]: data.revalidated}));
    setStale((prev) => {
      const next = new Set(prev);
      next.delete(data.sample.id);
      return next;
    });
    setStatus('样例已保存并重验');
  }

  function focusError(error: GateError) {
    // Jump from error to the most likely step; sample context is preserved (we never leave it).
    const target = error.primary ?? error.candidates[0];
    if (target) {
      setActiveStep(target.stepId);
      setActiveErrorPath(error.path);
      requestAnimationFrame(() => {
        document.getElementById('step-' + target.stepId)?.scrollIntoView({behavior: 'smooth', block: 'center'});
      });
    }
  }

  const draftDirty = bench && pipelineDraft && JSON.stringify(bench.pipeline) !== JSON.stringify(pipelineDraft);

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>Payload 迁移工作台</strong>
        <small>目标 Schema 门禁</small>
        <span className="rev-pill">
          pipeline r{bench?.pipelineRevision ?? '–'} · schema r{bench?.schemaRevision ?? '–'}
        </span>
        <span className={`status ${validating ? 'working' : ''}`}>{status}</span>
      </header>

      <section className="workspace">
        {/* ----------------------------- pipeline pane ----------------------------- */}
        <aside className="pane pipeline-pane">
          <div className="pane-head">
            <h2>转换流水线</h2>
            <button className="ghost" onClick={() => runValidation()} disabled={validating}>
              <Sparkles size={14} /> 全部校验
            </button>
          </div>
          <div className="steps">
            {pipelineDraft?.steps.map((step, index) => (
              <StepCard
                key={step.id}
                step={step}
                index={index}
                summary={summaryByStep.get(step.id)}
                active={activeStep === step.id}
                errorPath={activeStep === step.id ? activeErrorPath : null}
                dirty={
                  bench ? JSON.stringify(step) !== JSON.stringify(bench.pipeline.steps[index]) : false
                }
                onChange={(next) =>
                  setPipelineDraft((draft) =>
                    draft
                      ? {...draft, steps: draft.steps.map((s) => (s.id === step.id ? next : s))}
                      : draft,
                  )
                }
                onSave={() => saveStep(step.id)}
                saving={savingStep}
              />
            ))}
          </div>
          {draftDirty ? (
            <p className="hint warn">有未保存的步骤修改；保存后仅重验受影响样例。</p>
          ) : (
            <p className="hint">读写路径摘要随步骤静态推导，[*] 为通配，[] 中为表达式的为动态候选。</p>
          )}
        </aside>

        {/* ------------------------------ sample pane ------------------------------ */}
        <section className="pane sample-pane">
          <div className="tabs">
            {bench?.samples.map((meta) => {
              const result = results[meta.id];
              const current = isCurrent(result, {
                pipelineRevision: bench.pipelineRevision,
                schemaRevision: bench.schemaRevision,
                sampleRevision: meta.revision,
              });
              return (
                <button
                  key={meta.id}
                  className={`tab ${meta.id === selectedSample ? 'active' : ''}`}
                  onClick={() => setSelectedSample(meta.id)}
                >
                  {!current || stale.has(meta.id) ? (
                    <CircleDashed size={14} className="ic stale" />
                  ) : result?.valid ? (
                    <CheckCircle2 size={14} className="ic pass" />
                  ) : (
                    <AlertTriangle size={14} className="ic fail" />
                  )}
                  {meta.name}
                  {(!current || stale.has(meta.id)) && <em className="stale-tag">待重验</em>}
                </button>
              );
            })}
          </div>
          <div className="sample-toolbar">
            <span className="sample-meta">
              {sample?.name} · r{sample?.revision}
            </span>
            <button onClick={saveSample}>
              <Save size={14} /> 保存并重验此样例
            </button>
          </div>
          <textarea
            aria-label="样例输入"
            value={sampleText}
            onChange={(event) => setSampleText(event.target.value)}
            spellCheck={false}
          />
          {currentResult && (resultCurrent || isStale) && (
            <div className="output">
              <h3>转换输出</h3>
              {isStale && !resultCurrent && (
                <div className="banner warn">
                  <CircleDashed size={15} /> 结果基于旧 revision，不会显示为已通过；请重新校验。
                </div>
              )}
              <pre>{JSON.stringify(currentResult.output, null, 2)}</pre>
            </div>
          )}
        </section>

        {/* ------------------------------- gate pane ------------------------------- */}
        <aside className="pane gate-pane">
          <div className="pane-head">
            <h2>
              <ShieldCheck size={16} /> 目标 Schema 门禁
            </h2>
          </div>
          {!currentResult ? (
            <p className="hint">尚无校验结果。</p>
          ) : !resultCurrent || isStale ? (
            <div className="banner warn">
              <CircleDashed size={16} />
              该样例结果已过期（pipeline/schema/sample 任一 revision 变化）。旧结果不会显示为通过，请重验。
              <button className="revalidate" onClick={() => runValidation([selectedSample])}>
                重新校验此样例
              </button>
            </div>
          ) : currentResult.valid ? (
            <div className="banner pass">
              <CheckCircle2 size={16} /> 校验通过
              <small>
                cached: {currentResult.cached ? '命中缓存' : '新计算'} · 执行步骤{' '}
                {currentResult.executedStepIds.length}
              </small>
            </div>
          ) : (
            <div className="errors">
              {currentResult.errors.map((error) => (
                <ErrorCard
                  key={error.path + error.keyword}
                  error={error}
                  onJump={() => focusError(error)}
                  activePath={activeErrorPath}
                />
              ))}
            </div>
          )}
        </aside>
      </section>
    </main>
  );
}

/* --------------------------------- pieces --------------------------------- */

function StepCard({
  step,
  index,
  summary,
  active,
  errorPath,
  dirty,
  onChange,
  onSave,
  saving,
}: {
  step: StepDef;
  index: number;
  summary?: StepPathSummary;
  active: boolean;
  errorPath: string | null;
  dirty: boolean;
  onChange: (step: StepDef) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const mapText = Object.entries(step.map ?? {})
    .map(([dest, source]) => `${dest} <= ${source}`)
    .join('\n');
  const [text, setText] = useState(mapText);
  useEffect(() => setText(mapText), [mapText]);

  function commit(nextText: string) {
    setText(nextText);
    const map: Record<string, string> = {};
    for (const line of nextText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf('<=');
      if (idx > 0) map[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 2).trim();
    }
    onChange({...step, map});
  }

  return (
    <article id={'step-' + step.id} className={`step-card ${active ? 'active' : ''} ${dirty ? 'dirty' : ''}`}>
      <header>
        <span className="step-index">{index + 1}</span>
        <input
          className="step-title"
          value={step.title ?? step.id}
          onChange={(event) => onChange({...step, title: event.target.value})}
        />
        {dirty && <em className="dirty-dot">未保存</em>}
      </header>
      <input
        className="step-when"
        placeholder="when 条件（可空），例如 $.channel"
        value={step.when ?? ''}
        onChange={(event) => onChange({...step, when: event.target.value || undefined})}
      />
      <textarea
        className="step-map"
        rows={Math.max(2, Object.keys(step.map ?? {}).length)}
        value={text}
        onChange={(event) => commit(event.target.value)}
        spellCheck={false}
      />
      {summary && (
        <div className="summary">
          <div className="summary-row">
            <span className="tag write">写</span>
            <div className="paths">
              {summary.writes.map((w) => (
                <span
                  key={w.expr}
                  className={`path-chip ${w.kind} ${errorPath && w.expr.startsWith(w.prefix) ? 'hit' : ''}`}
                  title={
                    w.kind === 'dynamic'
                      ? `动态表达式，静态前缀 ${w.prefix}；只能作为候选原因`
                      : w.kind === 'wild'
                        ? '通配映射，结构确定'
                        : '静态路径'
                  }
                >
                  {w.expr}
                  {w.kind === 'dynamic' && <b className="cand">候选</b>}
                </span>
              ))}
            </div>
          </div>
          <div className="summary-row">
            <span className="tag read">读</span>
            <div className="paths">
              {summary.reads.length === 0 && <span className="muted">—</span>}
              {summary.reads.map((r) => (
                <span key={r.expr} className={`path-chip ${r.kind}`}>
                  {r.expr}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="step-actions">
        <button disabled={!dirty || saving} onClick={onSave} className={dirty ? 'primary' : ''}>
          <Save size={13} /> 保存步骤
        </button>
      </div>
    </article>
  );
}

function ErrorCard({error, onJump, activePath}: {error: GateError; onJump: () => void; activePath: string | null}) {
  const primary = error.primary;
  return (
    <article className={`error-card ${activePath === error.path ? 'active' : ''}`}>
      <div className="error-head">
        <AlertTriangle size={15} className="ic fail" />
        <code className="error-path">{error.path}</code>
        <span className={`kw kw-${error.keyword}`}>{error.keyword}</span>
      </div>
      <p className="error-msg">{error.message}</p>
      {error.branchMessages && (
        <ul className="branches">
          {error.branchMessages.map((message, i) => (
            <li key={i}>{message}</li>
          ))}
        </ul>
      )}
      <div className="attribution">
        {primary ? (
          <button className="jump definite" onClick={onJump}>
            <ChevronRight size={14} />
            <span>
              最近可能写入步骤：<b>{primary.title}</b>
              <em>{reasonLabel[primary.reason]}</em>
            </span>
            <ArrowRight size={14} />
          </button>
        ) : (
          <div className="jump-none muted">
            {error.unattributed
              ? '没有步骤的写路径覆盖此处，请补充转换步骤。'
              : '没有结构确定的唯一原因，仅列出可能相关的候选步骤。'}
          </div>
        )}
        {error.candidates.length > 0 && (
          <div className="candidates">
            <span className="cand-label">其他可能步骤：</span>
            {error.candidates.map((candidate) => (
              <button key={candidate.stepId} className="candidate-chip" onClick={onJump}>
                {candidate.title}
                <em>{reasonLabel[candidate.reason]}</em>
                {candidate.certainty === 'candidate' && <b className="cand">候选</b>}
              </button>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}
