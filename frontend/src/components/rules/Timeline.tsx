import { AlertTriangle, ExternalLink, Scale } from 'lucide-react';
import type { RuleDeferral, RuleSourceRef, RuleVersionOut } from '../../api/types';
import { Chip } from '../ui/Chip';
import { KeyValue } from '../ui/KeyValue';
import { DeferralChip, VersionStatusChip } from './RuleVersionBadges';
import { paramsToRows } from '../../lib/keyvalue';
import { fmtDate } from '../../lib/format';
import { changeTone } from '../../lib/vocab';
import { appliesLabel, authorityLabel, classificationLabel, deferralLine, governs, provisionName, rankSources, statusPresentation, versionStatusAsOf } from '../../lib/ruleVersions';
import { cn } from '../../lib/cn';

export interface TimelineProps {
  versions: RuleVersionOut[];
  /** version number in force as of the evaluation date */
  inForceVersion: number | null;
  /** the evaluation date; versions whose window ended before it read SUPERSEDED */
  asOf?: string;
  /** offered on proposed versions: open the hypothetical blast radius */
  onWhatIf?: (version: RuleVersionOut) => void;
  className?: string;
}

/** Ranked provenance: what the text rests on, strongest first. */
export function ProvenanceList({ sources }: { sources: RuleSourceRef[] }) {
  const ranked = rankSources(sources);
  if (!ranked.length) return null;
  return (
    <div className="mt-2">
      <div className="eyebrow mb-1">Provenance</div>
      <ol className="space-y-1.5">
        {ranked.map((src, i) => (
          <li key={`${src.cite}-${i}`} className={cn('border-l-2 pl-2', src.authority === 'primary' ? 'border-navy' : src.authority === 'preamble' ? 'border-slate' : 'border-input')}>
            <div className="text-[10px] font-semibold uppercase tracking-[1px] text-ink-2">{authorityLabel(src.authority)}</div>
            {src.url ? (
              <a href={src.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-start gap-1 font-mono text-[11.5px] leading-snug">
                <span>{src.cite}</span>
                <ExternalLink size={10} className="mt-[3px] shrink-0" aria-hidden />
              </a>
            ) : (
              <div className="font-mono text-[11.5px] text-ink">{src.cite}</div>
            )}
            {src.reading && <div className="mt-0.5 text-[12px] leading-snug text-ink">{src.reading}</div>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Dot({ status }: { status: ReturnType<typeof versionStatusAsOf> }) {
  return (
    <span
      aria-hidden
      className={cn(
        'absolute -left-[5px] top-1.5 h-[9px] w-[9px] rounded-full border bg-surface',
        status === 'in_force_as_of' && 'border-teal bg-teal',
        status === 'superseded' && 'border-hairline bg-band',
        status === 'vacated' && 'border-slate bg-surface',
        status === 'stayed' && 'border-amber bg-surface',
        status === 'proposed' && 'border-dashed border-teal-ink bg-surface',
        (status === 'future' || status === 'raw') && 'border-ink-3',
      )}
    />
  );
}

/**
 * Vertical rule-version timeline: effective window, status, classification,
 * clause, params, dispute. Vacated versions are struck through and say a
 * court set them aside; stayed ones read amber; proposals sit in a dashed box
 * with their vote date; deferred provisions are listed with their new date.
 */
export function Timeline({ versions, inForceVersion, asOf, onWhatIf, className }: TimelineProps) {
  const sorted = [...versions].sort((a, b) => a.version - b.version);
  return (
    <ol className={cn('relative ml-2 border-l border-hairline', className)}>
      {sorted.map((v) => {
        const status = versionStatusAsOf(v, asOf, inForceVersion);
        const inForce = status === 'in_force_as_of';
        const presentation = statusPresentation(v);
        const paramRows = paramsToRows(v.params);
        const special = status === 'vacated' || status === 'stayed' || status === 'proposed';
        return (
          <li key={v.id} className="relative pb-5 pl-5 last:pb-0" data-status={v.status}>
            <Dot status={status} />
            <div className={cn(status === 'proposed' && '-ml-2 rounded-[6px] border border-dashed border-teal-ink/50 px-2 py-1.5', status === 'vacated' && 'opacity-90')}>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={cn('font-mono text-[12px] font-semibold', status === 'superseded' || status === 'vacated' ? 'text-ink-3' : 'text-navy', presentation.strike && 'line-through')}>v{v.version}</span>
                {status === 'superseded' ? (
                  <Chip tone="neutral" title={`${v.status.replace(/_/g, ' ')} until ${fmtDate(v.effective_to)}`}>
                    superseded
                  </Chip>
                ) : (
                  <VersionStatusChip version={v} withNumber={false} />
                )}
                <Chip tone={changeTone(v.change_classification)}>{classificationLabel(v.change_classification)}</Chip>
                {inForce && (
                  <Chip tone="green" filled>
                    in force as of date
                  </Chip>
                )}
                {status === 'future' && v.effective_from && <Chip tone="teal">takes effect {fmtDate(v.effective_from)}</Chip>}
                {v.disputed && (
                  <Chip tone="amber" title="Reading flagged for counsel review">
                    <AlertTriangle size={11} aria-hidden /> open question
                  </Chip>
                )}
              </div>
              {special && presentation.note && <div className={cn('mt-1 text-[12px] font-medium', status === 'stayed' ? 'text-amber-ink' : 'text-slate')}>{presentation.note}</div>}
              {status === 'proposed' && onWhatIf && (
                <button type="button" className="btn btn-outline btn-sm mt-1.5" onClick={() => onWhatIf(v)}>
                  What-if impact
                </button>
              )}
              <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 text-[12px]">
                <dt className="text-ink-2">Applies from</dt>
                <dd className="font-mono text-ink">
                  {v.effective_from ? (
                    <>
                      {fmtDate(v.effective_from)} → {v.effective_to ? fmtDate(v.effective_to) : 'open'}
                    </>
                  ) : (
                    appliesLabel(v)
                  )}
                </dd>
                {v.vote_date && (
                  <>
                    <dt className="text-ink-2">Vote</dt>
                    <dd className="font-mono text-ink">{fmtDate(v.vote_date)}</dd>
                  </>
                )}
                {v.regulation_effective && (
                  <>
                    <dt className="text-ink-2">Regulation effective</dt>
                    <dd className="font-mono text-ink">{fmtDate(v.regulation_effective)}</dd>
                  </>
                )}
                {v.git_commit && (
                  <>
                    <dt className="text-ink-3">Commit</dt>
                    <dd className="font-mono text-ink-3">{v.git_commit}</dd>
                  </>
                )}
              </dl>
              {v.deferrals && v.deferrals.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1" aria-label="Deferred provisions">
                  {v.deferrals.map((d) => (
                    <DeferralChip key={`${d.provision}-${d.deferred_to}`} {...d} />
                  ))}
                </div>
              )}
              {v.summary && <div className="mt-1 text-[13px] font-medium text-slate">{v.summary}</div>}
              <blockquote className={cn('quote mt-2', status === 'vacated' && 'text-ink-2')}>{v.clause_text}</blockquote>
              {paramRows.length > 0 && (
                <div className="mt-2">
                  <KeyValue rows={paramRows} />
                </div>
              )}
              {v.sources && v.sources.length > 0 && <ProvenanceList sources={v.sources} />}
              {v.disputed && (
                <div className="mt-2 border border-amber bg-amber/5 px-3 py-2 text-[13px]" role="note">
                  <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[1px] text-amber-ink">
                    <Scale size={13} aria-hidden /> Open question · counsel review
                  </div>
                  <div className="text-ink">{v.dispute_note || 'The reading of this version is flagged for counsel; both readings are carried until it is resolved.'}</div>
                </div>
              )}
              {v.source_url && !(v.sources && v.sources.length) && (
                <a href={v.source_url} target="_blank" rel="noreferrer noopener" className="mt-2 inline-flex items-center gap-1 text-xs">
                  Source <ExternalLink size={11} aria-hidden />
                </a>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ------------------------------------------------------------- horizontal track

type StopKind = 'applies' | 'regulation' | 'deferral';

interface TrackStop {
  date: string;
  kind: StopKind;
  version: number;
  /** vacated / stayed / proposed / in_force … (applies stops only) */
  status: string;
  deferral?: RuleDeferral;
}

function dayNumber(iso: string): number {
  return Math.floor(new Date(`${iso.slice(0, 10)}T00:00:00Z`).getTime() / 86_400_000);
}

/** Stop positions (% of width): evenly spaced, leaving room on the right for the open-ended window. */
function stopPositions(n: number): number[] {
  if (n <= 1) return [4];
  return Array.from({ length: n }, (_, i) => 4 + (i * 78) / (n - 1));
}

/** Where the as-of date falls between the (ordinal) stops, interpolated by days. */
function asOfPosition(stops: TrackStop[], pos: number[], asOf: string): number {
  const d = dayNumber(asOf);
  const days = stops.map((s) => dayNumber(s.date));
  if (!stops.length) return 50;
  if (d < days[0]) return Math.max(1, pos[0] - 3);
  for (let i = 0; i < stops.length - 1; i += 1) {
    if (d >= days[i] && d < days[i + 1]) {
      const frac = days[i + 1] === days[i] ? 0 : (d - days[i]) / (days[i + 1] - days[i]);
      return pos[i] + frac * (pos[i + 1] - pos[i]);
    }
  }
  const last = pos[pos.length - 1];
  return d === days[days.length - 1] ? last : Math.min(96, last + 8);
}

/** Center a label on its point, except near the edges, where it is anchored inward. */
function anchor(p: number): { left: string; transform: string; textAlign: 'left' | 'center' | 'right' } {
  if (p < 12) return { left: `${Math.max(0, p - 1)}%`, transform: 'none', textAlign: 'left' };
  if (p > 90) return { left: `${p}%`, transform: 'translateX(-100%)', textAlign: 'right' };
  return { left: `${p}%`, transform: 'translateX(-50%)', textAlign: 'center' };
}

function stopTitle(s: TrackStop): string {
  if (s.kind === 'regulation') return 'Regulation effective';
  if (s.kind === 'deferral' && s.deferral) return `${provisionName(s.deferral.provision)} lands`;
  if (s.status === 'vacated') return `v${s.version} vacated`;
  if (s.status === 'stayed') return `v${s.version} stayed`;
  if (s.status === 'proposed') return `v${s.version} proposed`;
  return `v${s.version} applies from`;
}

/**
 * Horizontal rule-version track: each governing version's window as a bar
 * (the one in force on the evaluation date filled teal), "Regulation
 * effective" and "Applies from" stops beneath, and the as-of marker above.
 * A vacated or stayed version is a struck stop with no bar (it never
 * governed); a dated proposal is a dashed stop; a proposal still awaiting its
 * vote has no date to sit on, so it is listed under the track instead.
 * Deferred provisions get their own stop on the date they land. Stops are
 * spaced evenly (ordinal); the as-of marker is interpolated by days. Below
 * `sm` it becomes a list.
 */
export function VersionTrack({
  versions,
  inForceVersion,
  asOf,
  seq = 0,
  className,
}: {
  versions: RuleVersionOut[];
  inForceVersion: number | null;
  asOf: string;
  /** causality replay counter: the in-force bar gets the version-flip marker */
  seq?: number;
  className?: string;
}) {
  const dated = versions.filter((v): v is RuleVersionOut & { effective_from: string } => Boolean(v.effective_from));
  const undated = versions.filter((v) => !v.effective_from).sort((a, b) => a.version - b.version);
  const sorted = [...dated].sort((a, b) => a.effective_from.localeCompare(b.effective_from) || a.version - b.version);
  const stops: TrackStop[] = [];
  for (const v of sorted) {
    if (v.regulation_effective && v.regulation_effective !== v.effective_from) stops.push({ date: v.regulation_effective, kind: 'regulation', version: v.version, status: v.status });
    stops.push({ date: v.effective_from, kind: 'applies', version: v.version, status: v.status });
    for (const d of v.deferrals ?? []) stops.push({ date: d.deferred_to, kind: 'deferral', version: v.version, status: v.status, deferral: d });
  }
  const kindRank: Record<StopKind, number> = { regulation: 0, applies: 1, deferral: 2 };
  stops.sort((a, b) => a.date.localeCompare(b.date) || kindRank[a.kind] - kindRank[b.kind] || a.version - b.version);
  const pos = stopPositions(stops.length);
  const asOfP = asOfPosition(stops, pos, asOf);

  // One bar per governing version: from its "applies" stop to the next governing version's (or open-ended).
  const governingIdx = stops.map((s, i) => (s.kind === 'applies' && governs({ status: s.status, effective_from: s.date }) ? i : -1)).filter((i) => i >= 0);
  const bars = governingIdx.map((idx, k) => {
    const next = governingIdx[k + 1];
    const v = sorted.find((x) => x.version === stops[idx].version);
    const end = next !== undefined ? pos[next] : v?.effective_to ? Math.min(100, pos[idx] + 12) : 100;
    return { version: stops[idx].version, start: pos[idx], end, open: next === undefined && !v?.effective_to };
  });

  const describe = stops.map((s) => `${stopTitle(s)} ${fmtDate(s.date)}`).join('; ');
  const pendingText = undated.map((v) => `v${v.version} ${statusPresentation(v).label} — ${appliesLabel(v)}`);

  return (
    <div className={className}>
      {/* sm and up: the track */}
      <div
        className="relative hidden h-[104px] sm:block"
        role="img"
        aria-label={`Rule versions: ${describe}. Evaluated as of ${fmtDate(asOf)}${inForceVersion !== null ? `, v${inForceVersion} in force` : ', no version in force'}.${pendingText.length ? ` Not yet dated: ${pendingText.join('; ')}.` : ''}`}
      >
        <div className="absolute top-0 whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.06em] text-teal-ink" style={anchor(asOfP)}>
          As of {fmtDate(asOf)}
        </div>
        {bars.map((b) => {
          const live = b.version === inForceVersion;
          return (
            <div
              key={`bar-${b.version}-${live ? seq : 'x'}`}
              className={cn(
                'absolute top-[30px] flex h-[22px] items-center overflow-hidden rounded-[4px] border px-2 font-mono text-[11px] font-semibold',
                live ? 'border-teal bg-teal/15 text-teal-ink' : 'border-hairline bg-band text-ink-2',
                live && seq > 0 && 'cz-version',
                b.open && 'rounded-r-none border-r-0',
              )}
              style={{ left: `${b.start}%`, width: `${Math.max(2, b.end - b.start)}%` }}
            >
              <span className="truncate">
                v{b.version}
                {live ? ' · in force' : ''}
              </span>
            </div>
          );
        })}
        {stops.map((s, i) => {
          const off = s.kind === 'applies' && !governs({ status: s.status, effective_from: s.date });
          return (
            <div key={`${s.kind}-${s.version}-${s.date}`} data-stop={s.kind} data-status={s.status}>
              <span
                aria-hidden
                className={cn(
                  'absolute top-[26px] h-[30px] w-0 border-l',
                  s.kind === 'regulation' && 'border-slate/40',
                  s.kind === 'deferral' && 'border-dashed border-amber',
                  s.kind === 'applies' && !off && 'border-slate',
                  off && s.status === 'proposed' && 'border-dashed border-teal-ink',
                  off && s.status !== 'proposed' && 'border-dashed border-slate/60',
                )}
                style={{ left: `${pos[i]}%` }}
              />
              <div className="absolute top-[62px] leading-tight" style={anchor(pos[i])}>
                <div
                  className={cn(
                    'whitespace-nowrap text-[11px] font-semibold',
                    off ? (s.status === 'proposed' ? 'text-teal-ink' : s.status === 'stayed' ? 'text-amber-ink' : 'text-slate') : s.kind === 'deferral' ? 'text-amber-ink' : 'text-ink',
                  )}
                >
                  {s.status === 'vacated' && s.kind === 'applies' ? (
                    <>
                      <span className="line-through">v{s.version}</span> vacated
                    </>
                  ) : (
                    stopTitle(s)
                  )}
                </div>
                <div className="whitespace-nowrap font-mono text-[11px] text-ink-2">{fmtDate(s.date)}</div>
              </div>
            </div>
          );
        })}
        <span aria-hidden className="absolute top-[16px] h-[44px] w-[2px] -translate-x-1/2 rounded-full bg-teal-ink" style={{ left: `${asOfP}%` }} />
      </div>
      {undated.length > 0 && (
        <div className="mt-1 hidden flex-wrap items-center gap-2 text-[12px] text-ink-2 sm:flex" data-testid="track-undated">
          <span>Not on the track yet:</span>
          {undated.map((v) => (
            <span key={v.id} className="inline-flex items-center gap-1.5">
              <VersionStatusChip version={v} showVote={false} />
              <span className="font-mono text-[11.5px] text-ink">{appliesLabel(v)}</span>
            </span>
          ))}
        </div>
      )}

      {/* phone: the same facts as a list */}
      <ol className="space-y-1.5 text-[12px] sm:hidden">
        <li className="font-semibold uppercase tracking-[0.06em] text-teal-ink">
          As of {fmtDate(asOf)} · {inForceVersion === null ? 'no version in force' : `v${inForceVersion} in force`}
        </li>
        {stops.map((s) => (
          <li key={`${s.kind}-${s.version}-${s.date}-m`} className="flex items-baseline justify-between gap-3 border-t border-hairline pt-1.5">
            <span className={cn('font-medium', s.version === inForceVersion && s.kind === 'applies' ? 'text-teal-ink' : 'text-ink', s.status === 'vacated' && s.kind === 'applies' && 'text-slate')}>
              {s.kind === 'regulation' ? `Regulation effective (v${s.version})` : s.kind === 'deferral' && s.deferral ? deferralLine(s.deferral) : stopTitle(s)}
            </span>
            <span className="font-mono text-ink-2">{fmtDate(s.date)}</span>
          </li>
        ))}
        {undated.map((v) => (
          <li key={`${v.id}-m`} className="flex items-baseline justify-between gap-3 border-t border-dashed border-teal-ink/40 pt-1.5">
            <span className="font-medium text-teal-ink">
              v{v.version} {statusPresentation(v).label}
            </span>
            <span className="font-mono text-ink-2">{appliesLabel(v)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
