import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import type { CompareStatisticsOut, ContractComparisonOut, PairedTableOut } from '../../api/types';
import { cn } from '../../lib/cn';
import { axisMax, directionLabel, directionTone, fmtCi, fmtPct, lostToHolm, pLine, plainVerdict, rowCautions } from '../../lib/significance';
import { severityTone } from '../../lib/vocab';
import { Chip } from '../ui/Chip';
import { RatePair } from '../charts/RateRange';

/** better (green) / worse (red) / no significant difference (grey). */
export function SignificanceChip({ direction, className }: { direction: string; className?: string }) {
  return (
    <Chip tone={directionTone(direction)} className={className} title={direction === 'none' ? 'The test cannot tell B from A at α = 0.05' : `B is significantly ${direction} than A at α = 0.05`}>
      {directionLabel(direction)}
    </Chip>
  );
}

/** Amber notes: the reasons a reader should hold a result loosely. */
function Cautions({ items, className }: { items: string[]; className?: string }) {
  if (!items.length) return null;
  return (
    <ul className={cn('space-y-1', className)} aria-label="Cautions">
      {items.map((c) => (
        <li key={c} className="flex items-start gap-1.5 rounded-[6px] border border-amber/35 bg-amber/8 px-2.5 py-1.5 text-[12px] leading-snug text-ink">
          <AlertTriangle size={12} className="mt-[2px] shrink-0 text-amber-ink" aria-hidden />
          <span>{c}</span>
        </li>
      ))}
    </ul>
  );
}

function RateText({ row }: { row: ContractComparisonOut }) {
  const tone = directionTone(row.direction);
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5 font-mono text-[12px]">
      <span className="text-ink-2" title={`A: 95% CI ${fmtCi(row.a)}, ${row.a.k}/${row.a.n}`}>
        {fmtPct(row.a.rate)}
      </span>
      <ArrowRight size={11} className="self-center text-ink-3" aria-label="to" />
      <span className={cn('font-semibold', tone === 'green' ? 'text-green-ink' : tone === 'red' ? 'text-red' : 'text-ink')} title={`B: 95% CI ${fmtCi(row.b)}, ${row.b.k}/${row.b.n}`}>
        {fmtPct(row.b.rate)}
      </span>
    </span>
  );
}

function PValues({ row, alpha }: { row: ContractComparisonOut; alpha: number }) {
  const { p, holm } = pLine(row);
  return (
    <span className="inline-flex flex-col font-mono text-[12px] leading-tight">
      <span className={cn(row.p_value < alpha ? 'font-semibold text-ink' : 'text-ink-2')}>p {p}</span>
      {holm !== null && <span className={cn('text-[11px]', typeof row.p_holm === 'number' && row.p_holm < alpha ? 'text-ink' : 'text-ink-3')}>Holm {holm}</span>}
    </span>
  );
}

/** The paired 2×2: only the off-diagonal cells (calls that changed outcome) carry evidence. */
function PairedGrid({ t }: { t: PairedTableOut }) {
  const cell = 'px-2 py-1 text-right font-mono text-[12px]';
  return (
    <table className="w-full border-collapse text-[11px]" aria-label="Paired outcomes, same calls in A and B">
      <thead>
        <tr className="text-ink-2">
          <th className="px-2 py-1 text-left font-medium" scope="col">
            <span className="sr-only">Run A</span>
          </th>
          <th className="px-2 py-1 text-right font-medium" scope="col">
            B passes
          </th>
          <th className="px-2 py-1 text-right font-medium" scope="col">
            B fails
          </th>
        </tr>
      </thead>
      <tbody>
        <tr className="border-t border-hairline">
          <th scope="row" className="px-2 py-1 text-left font-medium text-ink-2">
            A passes
          </th>
          <td className={cn(cell, 'text-ink-3')}>{t.both_pass}</td>
          <td className={cn(cell, t.b_only_fail ? 'bg-red/8 font-semibold text-red' : 'text-ink-3')} title="Newly failing: passed in A, fails in B">
            {t.b_only_fail}
          </td>
        </tr>
        <tr className="border-t border-hairline">
          <th scope="row" className="px-2 py-1 text-left font-medium text-ink-2">
            A fails
          </th>
          <td className={cn(cell, t.a_only_fail ? 'bg-green/14 font-semibold text-green-ink' : 'text-ink-3')} title="Newly passing: failed in A, passes in B">
            {t.a_only_fail}
          </td>
          <td className={cn(cell, 'text-ink-3')}>{t.both_fail}</td>
        </tr>
      </tbody>
    </table>
  );
}

/** The release question first: a call fails if any BLOCK contract fails on it. */
function OverallCard({ row, alpha, max }: { row: ContractComparisonOut; alpha: number; max: number }) {
  const tone = directionTone(row.direction);
  return (
    <div
      className={cn(
        'card card-hero grid grid-cols-1 gap-x-6 gap-y-4 border-l-[3px] p-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,0.9fr)]',
        tone === 'green' ? 'border-l-green' : tone === 'red' ? 'border-l-red' : 'border-l-input',
      )}
      data-testid="significance-overall"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[12px] font-semibold text-slate">ALL-BLOCK</span>
          <SignificanceChip direction={row.direction} />
        </div>
        <div className="mt-1.5 text-[16px] font-semibold leading-snug text-ink">{plainVerdict(row, alpha)}</div>
        <div className="mt-1 text-[12px] leading-snug text-ink-2">
          The release question: a call fails if <em>any</em> release-blocking contract fails on it.
        </div>
        <div className="mt-1.5 font-mono text-[11.5px] text-ink-3">{row.verdict}</div>
      </div>
      <div className="min-w-0">
        <div className="eyebrow mb-1.5">Calls failing, A → B</div>
        <div className="flex items-baseline gap-2">
          <span className="stat text-[22px] text-ink-2">{fmtPct(row.a.rate)}</span>
          <ArrowRight size={14} className="self-center text-ink-3" aria-label="to" />
          <span className={cn('stat text-[22px]', tone === 'green' ? 'text-green-ink' : tone === 'red' ? 'text-red' : 'text-ink')}>{fmtPct(row.b.rate)}</span>
        </div>
        <div className="mb-2 mt-0.5 font-mono text-[11px] text-ink-2">
          95% CI {fmtCi(row.a)} → {fmtCi(row.b)} · n={row.n_shared}
        </div>
        <RatePair a={row.a} b={row.b} max={max} bTone={tone} />
        <div className="mt-1 flex justify-between font-mono text-[10px] text-ink-3" aria-hidden>
          <span>0%</span>
          <span>{fmtPct(max)}</span>
        </div>
      </div>
      <div className="min-w-0">
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <span className="eyebrow">{row.paired ? 'Same calls, paired' : 'Different calls'}</span>
          <PValues row={row} alpha={alpha} />
        </div>
        {row.paired ? (
          <>
            <PairedGrid t={row.paired} />
            <div className="mt-1 text-[11px] leading-snug text-ink-2">
              Only the {row.discordant ?? 0} calls that changed outcome carry evidence ({row.test.split(' (')[0]}).
            </div>
          </>
        ) : (
          <div className="text-[12px] leading-snug text-ink-2">
            {row.test}: {row.a.k}/{row.a.n} in A vs {row.b.k}/{row.b.n} in B. The pairing is gone, so the test is weaker and cannot isolate the change.
          </div>
        )}
      </div>
      {row.cautions.length > 0 && <Cautions items={row.cautions} className="lg:col-span-3" />}
    </div>
  );
}

function ContractRow({ row, alpha, max, family }: { row: ContractComparisonOut; alpha: number; max: number; family: number }) {
  const tone = directionTone(row.direction);
  const holmLost = lostToHolm(row, alpha);
  const cautions = rowCautions(row);
  return (
    <li className="border-b border-hairline px-3 py-2.5 last:border-b-0 sm:px-4" data-testid={`significance-${row.contract_code}`}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 md:grid-cols-[150px_minmax(0,1.4fr)_minmax(150px,1fr)_92px_150px]">
        <div className="min-w-0">
          <Link to={`/contracts/${encodeURIComponent(row.contract_code)}`} className="font-mono text-[12.5px] font-semibold">
            {row.contract_code}
          </Link>
          {row.severity && (
            <Chip tone={severityTone(row.severity)} size="xs" className="ml-1.5">
              {row.severity}
            </Chip>
          )}
        </div>
        <div className="col-span-2 min-w-0 md:col-span-1">
          <div className={cn('text-[13px] leading-snug', row.direction === 'none' ? 'text-ink' : 'font-semibold text-ink')}>{plainVerdict(row, alpha, family)}</div>
          <div className="mt-0.5 font-mono text-[11px] text-ink-3">
            {row.paired ? `${row.discordant ?? 0} changed: +${row.paired.b_only_fail} failing / −${row.paired.a_only_fail} failing` : `${row.a.k}/${row.a.n} vs ${row.b.k}/${row.b.n}`}
            {row.excluded_not_evaluated ? ` · ${row.excluded_not_evaluated} unlabelled excluded` : ''}
          </div>
        </div>
        <div className="min-w-0">
          <RateText row={row} />
          <RatePair a={row.a} b={row.b} max={max} bTone={tone} className="mt-1" />
        </div>
        <div>
          <PValues row={row} alpha={alpha} />
        </div>
        <div className="justify-self-start md:justify-self-end">
          <SignificanceChip direction={row.direction} />
          {holmLost && <div className="mt-0.5 text-[10.5px] text-amber-ink">not after Holm</div>}
        </div>
      </div>
      {cautions.length > 0 && <Cautions items={cautions} className="mt-2 md:ml-[166px]" />}
    </li>
  );
}

/**
 * "Is this difference real?" — exact tests over the two runs' stored
 * verdicts. Leads with the release question (ALL-BLOCK), then each contract:
 * the verdict in words, A → B failure rates with 95% Wilson intervals on one
 * shared axis, the p-value and its Holm adjustment, and the cautions that
 * should temper the reading.
 */
export function SignificancePanel({ stats }: { stats: CompareStatisticsOut }) {
  const rows = stats.per_contract;
  const max = axisMax([stats.overall.a, stats.overall.b, ...rows.flatMap((r) => [r.a, r.b])]);
  const moved = rows.filter((r) => r.direction !== 'none');
  const test = stats.mode === 'paired' ? 'McNemar exact · paired' : "Fisher's exact · unpaired";
  return (
    <section aria-labelledby="significance-title" className="mb-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="significance-title" className="text-[15px] font-semibold text-ink">
          Is this difference real?
        </h2>
        <span className="font-mono text-[11.5px] text-ink-2">
          {test} · α = {stats.alpha} · Holm across {rows.length} contracts · 95% Wilson intervals
        </span>
      </div>
      <OverallCard row={stats.overall} alpha={stats.alpha} max={max} />
      <Cautions items={stats.cautions} className="mt-2" />
      <div className="card mt-3 overflow-hidden">
        <div className="hidden grid-cols-[150px_minmax(0,1.4fr)_minmax(150px,1fr)_92px_150px] gap-x-4 border-b border-hairline bg-band px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-2 md:grid">
          <span>Contract</span>
          <span>What the test says</span>
          <span>
            Failure rate A → B <span className="font-mono normal-case tracking-normal text-ink-3">(0–{fmtPct(max)})</span>
          </span>
          <span>p · Holm</span>
          <span className="text-right">Verdict</span>
        </div>
        <ul aria-label="Per-contract significance">
          {rows.map((r) => (
            <ContractRow key={r.contract_code} row={r} alpha={stats.alpha} max={max} family={rows.length} />
          ))}
        </ul>
        <div className="border-t border-hairline bg-band px-4 py-1.5 text-[11.5px] text-ink-2">
          {moved.length ? `${moved.length} of ${rows.length} contracts moved significantly.` : `No contract moved significantly at α = ${stats.alpha}.`} Bars: 95% interval; tick: observed rate; A grey, B coloured by verdict.
        </div>
      </div>
      <p className="mt-2 text-[11.5px] leading-snug text-ink-3">
        <span className="font-semibold text-ink-2">How failure is counted here.</span> {stats.failure_definition}
      </p>
    </section>
  );
}
