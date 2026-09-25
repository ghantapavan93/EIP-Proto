import { Link } from 'react-router-dom';
import type { JsonObject, RunResultOut } from '../../api/types';
import { Chip } from '../ui/Chip';
import { KeyValue } from '../ui/KeyValue';
import { JsonView } from '../ui/JsonView';
import { StatBars } from '../charts/StatBars';
import { complianceWord, evidenceFamily, explainRuleVerdict, isObject, numList, str, strList } from '../../lib/evidence';
import { outcomeTone, severityTone } from '../../lib/vocab';
import { cn } from '../../lib/cn';

function ExpectedGot({ expected, got, outcome }: { expected: string; got: string; outcome: string }) {
  return (
    <div className="mt-2 grid grid-cols-2 gap-2 text-[12px]">
      <div className="border border-hairline px-2 py-1.5">
        <div className="eyebrow">Expected</div>
        <div className="font-mono text-ink">{expected}</div>
      </div>
      <div className={cn('border px-2 py-1.5', outcome === 'PASS' ? 'border-hairline' : outcome === 'FLAG' ? 'border-amber' : 'border-red')}>
        <div className="eyebrow">Got</div>
        <div className="font-mono text-ink">{got}</div>
      </div>
    </div>
  );
}

function figureChips(figures: string[], tone: 'red' | 'green' | 'neutral') {
  return figures.length ? (
    <span className="inline-flex flex-wrap gap-1">
      {figures.map((f, i) => (
        <Chip key={`${f}-${i}`} tone={tone} mono>
          {f}
        </Chip>
      ))}
    </span>
  ) : (
    <span className="text-ink-3">none</span>
  );
}

/** Purpose-built evidence rendering per contract family; JSON only as the fallback. */
export function EvidenceBody({ contractCode, outcome, evidence, transcriptLink }: { contractCode: string; outcome: string; evidence: JsonObject; transcriptLink?: string }) {
  const ev = evidence;
  switch (evidenceFamily(contractCode, ev)) {
    case 'rule': {
      const rows = [
        { key: 'Truth basis (rule in force)', value: str(ev.truth_basis) },
        { key: 'Model basis (what the prompt applied)', value: str(ev.model_basis) },
        { key: 'Rule logic', value: isObject(ev.rule_logic) ? Object.entries(ev.rule_logic).map(([k, v]) => `${k}=${str(v)}`).join(' · ') : str(ev.rule_logic) },
        { key: 'Direction', value: str(ev.direction) },
        { key: 'Disclaimer at', value: ev.disclaimer_seconds !== undefined ? `${str(ev.disclaimer_seconds)}s (model read ${str(ev.model_disclaimer_seconds)}s)` : undefined },
        { key: 'Benefits started at', value: ev.benefits_started_seconds !== undefined ? `${str(ev.benefits_started_seconds)}s` : undefined },
        { key: 'Appointment after SOA', value: ev.appointment_hours_after_soa !== undefined ? `${str(ev.appointment_hours_after_soa)}h` : undefined },
        { key: 'SOA exception', value: ev.soa_exception !== undefined ? str(ev.soa_exception) : undefined },
        { key: 'Not applicable', value: ev.not_applicable !== undefined ? str(ev.not_applicable) : undefined },
      ].filter((r) => r.value !== undefined && r.value !== '—');
      const why = explainRuleVerdict(ev, outcome);
      return (
        <>
          <ExpectedGot expected={complianceWord(ev.expected)} got={complianceWord(ev.got)} outcome={outcome} />
          {why && (
            <div className={cn('mt-2 border px-2.5 py-2 text-[12px]', why.finding ? 'border-red/40 bg-red/5' : 'border-hairline')} aria-label="Why this verdict">
              <div className="eyebrow">Deterministic check</div>
              <div className="font-mono text-ink">{why.check}</div>
              {why.finding && <p className="mt-1.5 leading-snug text-ink">{why.finding}</p>}
              <Link to={`/contracts/${encodeURIComponent(contractCode)}`} className="mt-1 inline-block text-[11.5px]">
                Contract, rule and citation
              </Link>
            </div>
          )}
          {rows.length > 0 && <KeyValue className="mt-2" rows={rows.map((r) => ({ key: r.key, value: r.value, mono: true }))} />}
        </>
      );
    }
    case 'span': {
      const missing = isObject(ev.not_in_transcript) ? Object.entries(ev.not_in_transcript) : [];
      return (
        <div className="mt-2 text-[12px]">
          <div className="text-ink-2">
            {str(ev.checked)} span(s) checked · {missing.length} not found verbatim
          </div>
          {missing.map(([label, text]) => (
            <div key={label} className="mt-1.5">
              <div className="mb-0.5 flex items-center gap-1.5">
                <Chip tone="red" mono>
                  {label}
                </Chip>
                <span className="inline-flex h-4 items-center border border-red px-1 text-[10px] font-semibold uppercase tracking-[0.5px] text-red">not found in transcript</span>
              </div>
              <blockquote className="quote">
                <mark className="mark-span-unverified bg-transparent">{str(text)}</mark>
              </blockquote>
            </div>
          ))}
        </div>
      );
    }
    case 'fact': {
      const invented = strList(ev.invented_figures);
      return (
        <KeyValue
          className="mt-2"
          rows={[
            { key: 'Invented figures', value: invented.length ? figureChips(invented, 'red') : <span className="text-green-ink">none</span>, mono: false },
            { key: 'Figures in summary', value: figureChips(strList(ev.summary_figures), 'neutral'), mono: false },
            ...(ev.transcript_figures !== undefined ? [{ key: 'Figures in transcript', value: figureChips(strList(ev.transcript_figures), 'green'), mono: false }] : []),
          ]}
        />
      );
    }
    case 'pii': {
      if (isObject(ev.pii_in_output)) {
        const entries = Object.entries(ev.pii_in_output);
        return (
          <div className="mt-2 text-[12px]">
            {entries.length === 0 && <span className="text-green-ink">no PII pattern in the output</span>}
            {entries.map(([type, values]) => (
              <div key={type} className="flex flex-wrap items-center gap-1.5 py-0.5">
                <Chip tone="red">{type.replace(/_/g, ' ')}</Chip>
                {strList(values).map((v, i) => (
                  <span key={i} className="font-mono text-ink">
                    {v}
                  </span>
                ))}
              </div>
            ))}
          </div>
        );
      }
      const reported = strList(ev.pii_types_reported);
      return (
        <div className="mt-2 text-[12px] text-ink-2">
          PII types reported by the model: {reported.length ? reported.map((r) => <Chip key={r} tone="neutral" className="ml-1">{r}</Chip>) : <span className="text-green-ink">none</span>}
        </div>
      );
    }
    case 'schema':
      return typeof ev.error === 'string' ? (
        <KeyValue className="mt-2" rows={[{ key: 'Error', value: <span className="text-red">{ev.error}</span> }, { key: 'Raw keys', value: strList(ev.raw_keys).join(', ') || '—' }]} />
      ) : (
        <div className="mt-2 text-[12px] text-ink-2">
          <span className="font-mono text-ink">{str(ev.fields)}</span> fields validated against the qa-handoff schema.
        </div>
      );
    case 'superlative':
      return (
        <KeyValue
          className="mt-2"
          rows={[
            { key: 'Expected flags', value: figureChips(strList(ev.expected_flags), 'neutral'), mono: false },
            { key: 'Got flags', value: figureChips(strList(ev.got_flags), outcome === 'PASS' ? 'neutral' : 'red'), mono: false },
            { key: 'Substantiation required', value: ev.substantiation_required === true ? 'yes (CY2024 clause)' : 'no (CY2027 clause)' },
          ]}
        />
      );
    case 'judge': {
      const judge = isObject(ev.judge) ? ev.judge : {};
      const scores = numList(ev.scores);
      const threshold = typeof ev.threshold === 'number' ? ev.threshold : 3;
      return (
        <>
          <StatBars scores={scores} minMean={threshold} className="mt-3" />
          <KeyValue
            className="mt-2"
            rows={[
              { key: 'Threshold (mean)', value: str(ev.threshold) },
              { key: 'Judge model', value: `${str(judge.judge_model)}${judge.simulated === true ? ' · simulated' : ''}` },
              { key: 'Temperature', value: str(judge.temperature) },
              { key: 'N', value: str(ev.n ?? scores.length) },
            ]}
          />
          <div className="mt-2 border border-amber bg-amber/5 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.5px] text-amber-ink">
            advisory — a judge cannot block; only deterministic BLOCK contracts gate a release
          </div>
        </>
      );
    }
    case 'no-truth':
      return (
        <div className="mt-2 text-[12px]">
          <div className="text-ink-2">
            No ground truth for this transcript{typeof ev.error === 'string' ? ` — ${ev.error}` : ''}. The contract cannot be judged; the model said:
          </div>
          <blockquote className="quote mt-1 font-mono">{str(ev.model_says)}</blockquote>
          {transcriptLink && (
            <Link to={transcriptLink} className="text-[12px]">
              Open transcript →
            </Link>
          )}
        </div>
      );
    default:
      return <JsonView value={ev} className="mt-2" collapsedBelow={2} />;
  }
}

/** A full contract-result card: header chips, purpose-built body, JSON fallback in a disclosure. */
export function EvidenceBlock({ result, transcriptLink }: { result: Pick<RunResultOut, 'contract_code' | 'severity' | 'outcome' | 'evidence' | 'latency_ms'>; transcriptLink?: string }) {
  return (
    <div className="card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px] font-semibold text-navy">{result.contract_code}</span>
        <Chip tone={severityTone(result.severity)}>{result.severity}</Chip>
        <Chip tone={outcomeTone(result.outcome)}>{result.outcome}</Chip>
        <span className="ml-auto font-mono text-[11px] text-ink-3">{result.latency_ms} ms</span>
      </div>
      <EvidenceBody contractCode={result.contract_code} outcome={result.outcome} evidence={result.evidence} transcriptLink={transcriptLink} />
      <details className="mt-2">
        <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-[0.5px] text-ink-2">Full evidence (JSON)</summary>
        <JsonView value={result.evidence} className="mt-1" collapsedBelow={2} />
      </details>
    </div>
  );
}
