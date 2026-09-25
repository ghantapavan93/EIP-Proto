import type { RunOut } from '../../api/types';
import { AdapterChip } from './AdapterChip';
import { Chip } from '../ui/Chip';
import { costLabel, runStats } from '../../lib/runStats';
import { fmtDuration } from '../../lib/format';
import { cn } from '../../lib/cn';

/**
 * Canary check from run.stats.judge_stability: six fixed notes re-judged N times against
 * bands the author set. A calibration check at one point in time, not longitudinal drift.
 */
export function JudgeChip({ run, compact = false }: { run: RunOut; compact?: boolean }) {
  const js = runStats(run).judge_stability;
  if (!js) return <span className="text-ink-3">—</span>;
  const label = compact ? (js.stable ? 'in band' : 'off band') : js.stable ? 'canary in band' : 'canary off band';
  return (
    <Chip tone={js.stable ? 'green' : 'amber'} title={`Judge canary: ${js.out_of_band}/${js.notes.length} fixed notes outside author-set bands · mean variance ${js.mean_variance}. A calibration check, not drift over time.`}>
      {label}
    </Chip>
  );
}

/**
 * Everywhere a run is shown: adapter badge, cost, latency per transcript and
 * judge stability. Inline, dense, no chart.
 */
export function RunFacts({ run, className, showAdapter = true }: { run: RunOut; className?: string; showAdapter?: boolean }) {
  const s = runStats(run);
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-2', className)}>
      {showAdapter && <AdapterChip adapter={run.adapter} />}
      <span className="font-mono" title={s.cost?.basis ?? 'cost basis unknown'}>
        {costLabel(s.cost)}
      </span>
      {s.latency_ms_per_transcript !== undefined && (
        <span className="font-mono" title="latency per transcript">
          {fmtDuration(s.latency_ms_per_transcript)}/transcript
        </span>
      )}
      <JudgeChip run={run} />
    </span>
  );
}
