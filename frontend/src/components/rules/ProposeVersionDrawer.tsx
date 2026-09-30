import { useState, type FormEvent } from 'react';
import { GitCommitHorizontal } from 'lucide-react';
import { useProposeVersion } from '../../api/hooks';
import type { RuleVersionCreate, RuleVersionOut } from '../../api/types';
import { Field } from '../layout/Page';
import { Chip } from '../ui/Chip';
import { Drawer } from '../ui/Drawer';
import { ErrorState } from '../ui/ErrorState';
import { useToast } from '../ui/useToast';
import { VersionStatusChip } from './RuleVersionBadges';
import { WhatIfImpact } from './WhatIfImpact';
import { fmtDate } from '../../lib/format';
import { changeTone, PROPOSABLE_CLASSIFICATIONS } from '../../lib/vocab';
import { classificationLabel } from '../../lib/ruleVersions';
import { cn } from '../../lib/cn';

function emptyProposal(effectiveFrom: string) {
  return {
    effective_from: effectiveFrom,
    change_classification: 'TIGHTENS',
    clause_text: '',
    summary: '',
    params: '{\n  \n}',
    disputed: false,
    dispute_note: '',
    source_url: '',
  };
}

/**
 * Record a proposed rule version (POST /rules/{code}/versions). A proposal is
 * a what-if: never in force, no review tasks; once recorded, its hypothetical
 * blast radius can be opened right here.
 */
export function ProposeVersionDrawer({
  code,
  open,
  onClose,
  nextVersion,
  defaultEffectiveFrom,
}: {
  code: string;
  open: boolean;
  onClose: () => void;
  nextVersion: number;
  /** YYYY-MM-DD the "would apply from" field starts on */
  defaultEffectiveFrom: string;
}) {
  const propose = useProposeVersion(code);
  const { toast } = useToast();
  const [form, setForm] = useState(() => emptyProposal(defaultEffectiveFrom));
  const [paramsError, setParamsError] = useState<string | null>(null);
  const [created, setCreated] = useState<RuleVersionOut | null>(null);
  const [showWhatIf, setShowWhatIf] = useState(false);

  const close = () => {
    setCreated(null);
    setShowWhatIf(false);
    propose.reset();
    onClose();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    let params: Record<string, unknown> = {};
    try {
      const parsed: unknown = form.params.trim() ? JSON.parse(form.params) : {};
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        throw new Error('params must be a JSON object');
      params = parsed as Record<string, unknown>;
      setParamsError(null);
    } catch (err) {
      setParamsError(err instanceof Error ? err.message : 'invalid JSON');
      return;
    }
    const body: RuleVersionCreate = {
      status: 'proposed',
      effective_from: form.effective_from,
      change_classification: form.change_classification,
      clause_text: form.clause_text,
      summary: form.summary,
      params,
      disputed: form.disputed,
      dispute_note: form.dispute_note,
      source_url: form.source_url,
    };
    propose.mutate(body, {
      onSuccess: (v) => {
        toast({
          title: `Proposed ${code} v${v.version}`,
          detail: 'Not law: the enacted history is unchanged. Open the what-if to see what it would break.',
          tone: 'green',
        });
        setCreated(v);
        setForm(emptyProposal(defaultEffectiveFrom));
      },
    });
  };

  return (
    <Drawer
      open={open}
      onClose={close}
      title={created ? `Proposed v${created.version}` : `Propose version v${nextVersion}`}
      subtitle={`${code} · a proposal is a what-if; nothing is updated in place`}
    >
      <div
        className="mb-3 rounded-[8px] border border-hairline bg-band px-3 py-2.5 text-[12.5px] leading-snug text-ink"
        role="note"
      >
        <div className="mb-0.5 flex items-center gap-1.5 font-semibold text-slate">
          <GitCommitHorizontal size={13} aria-hidden /> Proposals never take effect from the UI
        </div>
        Enacted history comes from reviewed YAML in git (
        <span className="font-mono text-[11.5px]">rules/{code}.yaml</span>, merged by a second person, then reloaded). A
        proposal is recorded as <span className="font-semibold">proposed</span>, is never in force and opens no review
        tasks. Use it to see what an enacted change would break.
      </div>
      {created ? (
        <div className="space-y-3">
          <div className="card p-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <VersionStatusChip version={created} />
              <Chip tone={changeTone(created.change_classification)}>
                {classificationLabel(created.change_classification)}
              </Chip>
              <span className="font-mono text-[12px] text-ink-2">
                would apply from {created.effective_from ? fmtDate(created.effective_from) : '—'}
              </span>
            </div>
            {created.summary && <div className="mt-1 text-[13px] text-slate">{created.summary}</div>}
          </div>
          <button
            type="button"
            className={cn('btn btn-sm', showWhatIf ? '' : 'btn-outline')}
            aria-pressed={showWhatIf}
            onClick={() => setShowWhatIf((v) => !v)}
          >
            What-if impact
          </button>
          {showWhatIf && created.effective_from && (
            <WhatIfImpact code={code} version={created.version} asOf={created.effective_from} />
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="btn btn-ghost" onClick={() => setCreated(null)}>
              Propose another
            </button>
            <button type="button" className="btn" onClick={close}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3" id="propose-form">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className="label">Status</span>
              <div className="flex h-[34px] items-center" title="The API records proposals only">
                <Chip tone="teal" className="border-dashed border-teal-ink/60 bg-surface">
                  proposed
                </Chip>
              </div>
            </div>
            <Field label="Would apply from" htmlFor="pv-eff">
              <input
                id="pv-eff"
                type="date"
                className="input font-mono"
                value={form.effective_from}
                onChange={(e) => setForm({ ...form, effective_from: e.target.value })}
                required
              />
            </Field>
          </div>
          <Field label="Change classification" htmlFor="pv-class">
            <select
              id="pv-class"
              className="input"
              value={form.change_classification}
              onChange={(e) => setForm({ ...form, change_classification: e.target.value })}
            >
              {PROPOSABLE_CLASSIFICATIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Summary" htmlFor="pv-summary">
            <input
              id="pv-summary"
              className="input"
              value={form.summary}
              onChange={(e) => setForm({ ...form, summary: e.target.value })}
              placeholder="One line a reviewer can read"
            />
          </Field>
          <Field
            label="Clause text"
            htmlFor="pv-clause"
            hint="Quoted regulatory text or a faithful paraphrase — mark which."
          >
            <textarea
              id="pv-clause"
              className="input"
              rows={5}
              value={form.clause_text}
              onChange={(e) => setForm({ ...form, clause_text: e.target.value })}
              required
            />
          </Field>
          <Field
            label="Params (JSON)"
            htmlFor="pv-params"
            error={paramsError}
            hint='Machine-readable knobs contracts read, e.g. {"window_seconds": 60}'
          >
            <textarea
              id="pv-params"
              className="input font-mono"
              rows={4}
              value={form.params}
              onChange={(e) => setForm({ ...form, params: e.target.value })}
              spellCheck={false}
            />
          </Field>
          <Field label="Source URL" htmlFor="pv-src">
            <input
              id="pv-src"
              className="input font-mono"
              value={form.source_url}
              onChange={(e) => setForm({ ...form, source_url: e.target.value })}
              placeholder="https://"
            />
          </Field>
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={form.disputed}
              onChange={(e) => setForm({ ...form, disputed: e.target.checked })}
            />
            Disputed reading — carry both, flag for counsel
          </label>
          {form.disputed && (
            <Field label="Dispute note" htmlFor="pv-dispute">
              <textarea
                id="pv-dispute"
                className="input"
                rows={3}
                value={form.dispute_note}
                onChange={(e) => setForm({ ...form, dispute_note: e.target.value })}
              />
            </Field>
          )}
          {propose.error ? <ErrorState error={propose.error} title="Proposal refused" /> : null}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="btn btn-ghost" onClick={close}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={propose.isPending}>
              {propose.isPending ? 'Recording…' : 'Record proposal'}
            </button>
          </div>
        </form>
      )}
    </Drawer>
  );
}
