import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Ban, CalendarClock, Gavel, Vote } from 'lucide-react';
import { useMeta, useReadiness } from '../api/hooks';
import type { ReadinessHorizonItem, ReadinessMilestone, ReadinessOut } from '../api/types';
import { useTopBar } from '../components/layout/useShell';
import { PageHeader, Section } from '../components/layout/Page';
import { Chip } from '../components/ui/Chip';
import { DateAsOfControl } from '../components/rules/DateAsOfControl';
import { LoadingState } from '../components/ui/LoadingState';
import { ErrorState } from '../components/ui/ErrorState';
import { EmptyState } from '../components/ui/EmptyState';
import { cn } from '../lib/cn';
import { fmtDate, hostname, todayIso } from '../lib/format';
import { countdownLabel, daysLabel, HORIZON_BANDS, isCalendarKind, milestoneKindLabel, milestoneTone, requiredPace, sortOwners, upcoming } from '../lib/readiness';
import { classificationLabel } from '../lib/ruleVersions';
import { changeTone, kindLabel, roleLabel } from '../lib/vocab';

const HORIZONS = HORIZON_BANDS.map(([key]) => key);

function ruleLink(code: string) {
  return `/rules/${encodeURIComponent(code)}`;
}

function Countdown({ days, label, date, tone }: { days: number; label: string; date: string; tone: 'teal' | 'ink' }) {
  return (
    <div className="bg-surface px-4 py-3">
      <div className="eyebrow">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className={cn('stat text-[34px]', tone === 'teal' ? 'text-teal-ink' : 'text-ink')}>{Math.max(0, days)}</span>
        <span className="text-[13px] text-ink-2">{days === 1 ? 'day' : 'days'}</span>
      </div>
      <div className="font-mono text-[11.5px] text-ink-2">
        {fmtDate(date)} · {countdownLabel(days)}
      </div>
    </div>
  );
}

interface Stop {
  date: string;
  days: number;
  items: ReadinessMilestone[];
}

function groupByDate(milestones: ReadinessMilestone[]): Stop[] {
  const stops = new Map<string, Stop>();
  for (const m of milestones) {
    const s = stops.get(m.date) ?? { date: m.date, days: m.days_from_as_of, items: [] };
    s.items.push(m);
    stops.set(m.date, s);
  }
  return [...stops.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function stopKinds(stop: Stop): string[] {
  return [...new Set(stop.items.map((m) => m.kind))];
}

/** Filled teal: a Medicare calendar date; filled slate: a rule applies; slate ring: a vote (not law); amber ring: a deferral lands. */
function StopMarker({ kinds }: { kinds: string[] }) {
  const calendar = kinds.some(isCalendarKind);
  const applies = kinds.includes('rule_applies');
  const vote = kinds.every((k) => k === 'vote');
  return (
    <span
      aria-hidden
      className={cn(
        'block h-3 w-3 rounded-full border-2',
        calendar ? 'border-teal-ink bg-teal-ink' : applies ? 'border-slate bg-slate' : vote ? 'border-slate bg-surface' : 'border-amber bg-surface',
      )}
    />
  );
}

/**
 * One stop's milestones. Calendar dates read first; when several rule
 * versions apply on the same day they collapse into one line of links
 * ("9 rule versions apply: …") so a busy date does not tower over the rest.
 */
function StopText({ stop }: { stop: Stop }) {
  const applies = stop.items.filter((m) => m.kind === 'rule_applies');
  const others = stop.items.filter((m) => m.kind !== 'rule_applies').sort((a, b) => Number(isCalendarKind(b.kind)) - Number(isCalendarKind(a.kind)));
  const grouped = applies.length > 2;
  const rows = grouped ? others : [...others, ...applies];
  return (
    <ul className="space-y-1">
      {rows.map((m) => (
        <li key={m.label} className="text-[12px] leading-snug text-ink [overflow-wrap:anywhere]" title={m.label}>
          <Chip tone={milestoneTone(m.kind)} size="xs" className={cn('mr-1', m.kind === 'vote' && 'border-dashed')}>
            {milestoneKindLabel(m.kind)}
          </Chip>
          {m.rule_code ? (
            <Link to={ruleLink(m.rule_code)} className="text-ink hover:text-teal-ink">
              {m.kind === 'deferral_ends' ? m.label.split(' — ')[0] : m.label}
            </Link>
          ) : (
            m.label
          )}
        </li>
      ))}
      {grouped && (
        <li className="text-[12px] leading-snug text-ink">
          <Chip tone="slate" size="xs" className="mr-1">
            {milestoneKindLabel('rule_applies')}
          </Chip>
          {applies.length} rule versions apply:
          <span className="mt-0.5 block font-mono text-[11px] leading-relaxed [overflow-wrap:anywhere]">
            {applies.map((m, i) => (
              <span key={m.label} title={m.label}>
                {i > 0 && <span className="text-ink-3"> · </span>}
                <Link to={`${ruleLink(m.rule_code ?? '')}?as_of=${m.date}`}>
                  {m.rule_code} v{m.version}
                </Link>
              </span>
            ))}
          </span>
        </li>
      )}
    </ul>
  );
}

/**
 * Milestones on one line from the as-of date: stops evenly spaced (a week
 * and three months apart both stay readable), one stop per date with every
 * milestone on it. Below `md` the same facts as a list.
 */
function MilestoneTimeline({ milestones, asOf }: { milestones: ReadinessMilestone[]; asOf: string }) {
  const stops = groupByDate(upcoming(milestones));
  if (!stops.length) return <EmptyState title="No upcoming milestones" hint="Nothing applies, is voted on or lands in the window." className="py-5" />;
  // A busy date (several rule versions applying) gets a wider column; each marker sits over its own column.
  const columns = stops.map((s) => `minmax(0, ${s.items.length > 3 ? 1.8 : 1}fr)`).join(' ');
  return (
    <>
      <div className="relative hidden md:block" role="list" aria-label="Milestones">
        <span aria-hidden className="absolute left-0 right-0 top-[29px] h-px bg-hairline" />
        <div className="relative h-[18px]">
          <span className="absolute left-0 top-0 whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.06em] text-teal-ink">As of {fmtDate(asOf)}</span>
        </div>
        <span aria-hidden className="absolute left-0 top-[18px] h-[22px] w-[2px] rounded-full bg-teal-ink" />
        <div className="grid gap-3 pl-6" style={{ gridTemplateColumns: columns }}>
          {stops.map((s) => (
            <div key={s.date} role="listitem" className="min-w-0">
              <div className="relative h-[28px]">
                <span className="absolute left-0 top-[5px]">
                  <StopMarker kinds={stopKinds(s)} />
                </span>
              </div>
              <div className="font-mono text-[12px] font-semibold text-ink">{fmtDate(s.date)}</div>
              <div className={cn('mb-1 text-[11px]', s.days <= 7 ? 'font-semibold text-amber-ink' : 'text-ink-2')}>{countdownLabel(s.days)}</div>
              <StopText stop={s} />
            </div>
          ))}
        </div>
      </div>
      <ol className="space-y-2 md:hidden" aria-label="Milestones">
        {stops.map((s) => (
          <li key={s.date} className="grid grid-cols-[14px_minmax(0,1fr)] gap-x-2.5 border-t border-hairline pt-2 first:border-t-0 first:pt-0">
            <span className="mt-1">
              <StopMarker kinds={stopKinds(s)} />
            </span>
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[12px] font-semibold text-ink">{fmtDate(s.date)}</span>
                <span className={cn('text-[11px]', s.days <= 7 ? 'font-semibold text-amber-ink' : 'text-ink-2')}>{countdownLabel(s.days)}</span>
              </div>
              <StopText stop={s} />
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

function HorizonTable({ items, asOf }: { items: ReadinessHorizonItem[]; asOf: string }) {
  if (!items.length) return <EmptyState title="Nothing flips in this window" hint={`No enacted rule version starts to apply in this band, counted from ${fmtDate(asOf)}.`} className="py-5" />;
  return (
    <div className="overflow-x-auto">
      <table className="dt" aria-label="Rule versions that start to apply">
        <thead>
          <tr>
            <th>Rule · version</th>
            <th>Applies from</th>
            <th>Change</th>
            <th className="text-right">Stale encodings that day</th>
            <th className="text-right">Artifacts</th>
            <th className="text-right">Open tasks</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={`${it.rule_code}-${it.version}`}>
              <td className="wrap">
                <span className="cell-primary">
                  <Link to={`${ruleLink(it.rule_code)}?as_of=${it.applies_from}`} className="font-mono text-[12px] font-semibold">
                    {it.rule_code} v{it.version}
                  </Link>
                  <span className="cell-sub max-w-[440px]">{it.rule_title}</span>
                </span>
              </td>
              <td className="font-mono text-[12px]">{fmtDate(it.applies_from)}</td>
              <td>
                <Chip tone={changeTone(it.change_classification)}>{classificationLabel(it.change_classification)}</Chip>
              </td>
              <td className={cn('text-right font-mono', it.stale_encodings_on_that_date ? 'font-semibold text-amber-ink' : 'text-ink-3')}>{it.stale_encodings_on_that_date}</td>
              <td className={cn('text-right font-mono', it.artifacts_on_that_date ? 'text-ink' : 'text-ink-3')}>{it.artifacts_on_that_date}</td>
              <td className={cn('text-right font-mono', it.open_tasks ? 'text-ink' : 'text-ink-3')}>{it.open_tasks}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OwnersTable({ owners }: { owners: ReadinessOut['owners'] }) {
  const rows = sortOwners(owners);
  if (!rows.length) return <EmptyState title="No open work" hint="Every review queue is empty." className="py-5" />;
  return (
    <div className="overflow-x-auto">
      <table className="dt" aria-label="Owner queues, oldest first">
        <thead>
          <tr>
            <th>Owner</th>
            <th className="text-right">Open</th>
            <th className="text-right">Actionable</th>
            <th className="text-right">Oldest</th>
            <th className="text-right">Median age</th>
            <th>By kind</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.role}>
              <td>
                <span className="font-medium text-ink" title={o.role}>
                  {roleLabel(o.role)}
                </span>
              </td>
              <td className="text-right font-mono">{o.open}</td>
              <td className="text-right font-mono">{o.actionable}</td>
              <td className={cn('text-right font-mono', (o.oldest_days ?? 0) >= 7 ? 'font-semibold text-amber-ink' : 'text-ink')}>{daysLabel(o.oldest_days)}</td>
              <td className="text-right font-mono text-ink-2">{daysLabel(o.median_age_days)}</td>
              <td className="wrap">
                <span className="flex flex-wrap gap-1 py-1">
                  {Object.entries(o.by_kind).map(([kind, n]) => (
                    <Link key={kind} to={`/review?kind=${encodeURIComponent(kind)}&state=open`} className="hover:no-underline">
                      <Chip tone="neutral" size="xs">
                        {kindLabel(kind)} {n}
                      </Chip>
                    </Link>
                  ))}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BurnDown({ b }: { b: ReadinessOut['burn_down'] }) {
  const pace = requiredPace(b.open_actionable_now, b.days_left);
  return (
    <div className="card p-4" data-testid="burn-down">
      <div className="eyebrow mb-2">
        Burn-down to {fmtDate(b.target)} · {b.label}
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <div className={cn('stat text-[26px]', b.open_actionable_now ? 'text-ink' : 'text-green-ink')}>{b.open_actionable_now}</div>
          <div className="text-[12px] leading-tight text-ink-2" title="Every actionable task not yet closed: open, in review, or verified and waiting to be republished. The status bar counts only untouched (open) tasks.">
            actionable, not closed
          </div>
        </div>
        <div>
          <div className={cn('stat text-[26px]', b.stale_encodings_on_target ? 'text-amber-ink' : 'text-green-ink')}>{b.stale_encodings_on_target}</div>
          <div className="text-[12px] leading-tight text-ink-2">stale encodings on {fmtDate(b.target)}</div>
        </div>
        <div>
          <div className="stat text-[26px] text-ink">{Math.max(0, b.days_left)}</div>
          <div className="text-[12px] leading-tight text-ink-2">days left</div>
        </div>
      </div>
      <p className="mt-3 border-t border-hairline pt-2 text-[12.5px] leading-snug text-ink-2">
        {pace !== null
          ? `Clearing the queue by ${fmtDate(b.target)} takes about ${pace} decisions a day. AEP opens ${fmtDate(b.aep.date)} (${countdownLabel(b.aep.days_left)}).`
          : b.days_left <= 0
            ? `The date has passed; anything still open is late. AEP opens ${fmtDate(b.aep.date)} (${countdownLabel(b.aep.days_left)}).`
            : `Nothing actionable is open. AEP opens ${fmtDate(b.aep.date)} (${countdownLabel(b.aep.days_left)}).`}
      </p>
      {b.note && <p className="mt-1.5 text-[11.5px] leading-snug text-ink-3">{b.note}</p>}
    </div>
  );
}

function HonestPanels({ data }: { data: ReadinessOut }) {
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <div className="card p-4" data-testid="vacated-panel">
        <div className="mb-1 flex items-center gap-2">
          <Ban size={14} className="text-slate" aria-hidden />
          <h3 className="text-[14px] font-semibold text-slate">Vacated — Backstop will not enforce</h3>
        </div>
        <p className="mb-2 text-[12px] leading-snug text-ink-2">A court set these versions aside (or stayed them). They are kept for the record, never checked against, and never raise a task.</p>
        {data.vacated.length ? (
          <ul className="divide-y divide-hairline">
            {data.vacated.map((v) => (
              <li key={`${v.rule_code}-${v.version}`} className="py-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Link to={ruleLink(v.rule_code)} className="font-mono text-[12.5px] font-semibold">
                    {v.rule_code}
                  </Link>
                  <span className="font-mono text-[12px] text-ink-3 line-through">v{v.version}</span>
                  {v.status === 'stayed' ? (
                    <Chip tone="amber" size="xs">
                      <Gavel size={10} aria-hidden /> stayed
                    </Chip>
                  ) : (
                    <Chip tone="slate" size="xs">
                      <Gavel size={10} aria-hidden /> court vacated
                    </Chip>
                  )}
                </div>
                <div className="mt-0.5 text-[12.5px] leading-snug text-ink">{v.why}</div>
                {v.source &&
                  (v.source_url ? (
                    <a href={v.source_url} target="_blank" rel="noreferrer noopener" className="mt-0.5 block font-mono text-[11px] [overflow-wrap:anywhere]" title={v.source_url}>
                      {v.source} · {hostname(v.source_url)}
                    </a>
                  ) : (
                    <div className="mt-0.5 font-mono text-[11px] text-ink-2 [overflow-wrap:anywhere]">{v.source}</div>
                  ))}
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-[12.5px] text-ink-3">No vacated versions.</div>
        )}
      </div>
      <div className="card border-dashed p-4" data-testid="proposed-panel">
        <div className="mb-1 flex items-center gap-2">
          <Vote size={14} className="text-slate" aria-hidden />
          <h3 className="text-[14px] font-semibold text-slate">Proposed — not law yet</h3>
        </div>
        <p className="mb-2 text-[12px] leading-snug text-ink-2">Backstop treats a proposal as a what-if only. Nothing is re-scored until the text is enacted in reviewed YAML.</p>
        {data.proposed.length ? (
          <ul className="divide-y divide-hairline">
            {data.proposed.map((p) => (
              <li key={`${p.rule_code}-${p.version}`} className="py-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Link to={ruleLink(p.rule_code)} className="font-mono text-[12.5px] font-semibold">
                    {p.rule_code}
                  </Link>
                  <span className="rounded-[4px] border border-dashed border-teal-ink/60 px-1 font-mono text-[11.5px] text-teal-ink">v{p.version} proposed</span>
                  <span className="text-[12px] font-semibold text-ink">{p.vote_date ? `vote on ${fmtDate(p.vote_date)}` : 'no vote scheduled'}</span>
                  <span className="text-[11.5px] text-ink-2">
                    · {p.effective_from ? `would apply from ${fmtDate(p.effective_from)}` : 'no date to apply from yet'}
                    {p.origin === 'api' ? ' · recorded from the UI' : ''}
                  </span>
                </div>
                <div className="mt-0.5 text-[12.5px] leading-snug text-ink">{p.why}</div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-[12.5px] text-ink-3">No open proposals.</div>
        )}
      </div>
    </div>
  );
}

export function ReadinessPage() {
  const meta = useMeta();
  const [params, setParams] = useSearchParams();
  const asOf = params.get('as_of') || meta.data?.today || todayIso();
  const horizon = (HORIZONS as readonly string[]).includes(params.get('h') ?? '') ? (params.get('h') as string) : '30';
  const readiness = useReadiness(asOf);
  useTopBar([{ label: 'Readiness' }], asOf);

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: true });
  };
  const d = readiness.data;
  const milestones = useMemo(() => (d ? upcoming(d.milestones) : []), [d]);

  return (
    <div>
      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-1.5">
            <CalendarClock size={12} aria-hidden /> Monitor · Readiness
          </span>
        }
        title="What changes next, and who is not ready"
        description="Dates that move the rules, what flips on each, the open work by owner, and what Backstop deliberately does not enforce."
        actions={<DateAsOfControl value={asOf} onChange={(v) => set('as_of', v)} label="As of" />}
      />
      {readiness.isLoading && <LoadingState className="p-6" rows={6} />}
      {readiness.error && !d && (
        <div className="px-4 sm:px-6">
          <ErrorState error={readiness.error} title="Readiness unavailable" retry={() => void readiness.refetch()} />
        </div>
      )}
      {d && (
        <>
          <Section className="pt-0">
            <div className="card grid grid-cols-1 gap-px overflow-hidden bg-hairline sm:grid-cols-3">
              <Countdown days={d.burn_down.days_left} label={`To ${fmtDate(d.burn_down.target)} — ${d.burn_down.label}`} date={d.burn_down.target} tone="ink" />
              <Countdown days={d.burn_down.aep.days_left} label="To AEP — Annual Enrollment opens" date={d.burn_down.aep.date} tone="teal" />
              <div className="bg-surface px-4 py-3">
                <div className="eyebrow">Next vote</div>
                {d.proposed.find((p) => p.vote_date) ? (
                  (() => {
                    const p = d.proposed.filter((x) => x.vote_date).sort((a, b) => (a.vote_date ?? '').localeCompare(b.vote_date ?? ''))[0];
                    return (
                      <>
                        <div className="mt-1 font-mono text-[13px] font-semibold text-ink">{fmtDate(p.vote_date)}</div>
                        <div className="text-[12px] leading-snug text-ink-2">
                          <Link to={ruleLink(p.rule_code)} className="font-mono">
                            {p.rule_code} v{p.version}
                          </Link>{' '}
                          · not law until enacted
                        </div>
                      </>
                    );
                  })()
                ) : (
                  <div className="mt-1 text-[13px] text-ink-3">none scheduled</div>
                )}
              </div>
            </div>
          </Section>

          <Section title="Milestones">
            <div className="card p-4">
              <MilestoneTimeline milestones={milestones} asOf={asOf} />
            </div>
          </Section>

          <Section title="What flips, and what is not ready for it" right={<span>bands do not overlap: 0–30, 31–60, 61–90 days</span>}>
            <div className="card overflow-hidden">
              <div role="tablist" aria-label="Horizon" className="flex border-b border-hairline px-2">
                {HORIZONS.map((h) => (
                  <button key={h} type="button" role="tab" className="tab" aria-selected={horizon === h} onClick={() => set('h', h)}>
                    {HORIZON_BANDS.find(([key]) => key === h)?.[1]} <span className="ml-1 font-mono text-[11px] text-ink-3">{d.horizon[h]?.length ?? 0}</span>
                  </button>
                ))}
              </div>
              <div role="tabpanel" aria-label={HORIZON_BANDS.find(([key]) => key === horizon)?.[1]}>
                <HorizonTable items={d.horizon[horizon] ?? []} asOf={asOf} />
              </div>
            </div>
          </Section>

          <div className="grid grid-cols-1 gap-0 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <Section title="Owner queues — oldest first" right={<Link to="/review">Review queue →</Link>}>
              <div className="card overflow-hidden">
                <OwnersTable owners={d.owners} />
              </div>
            </Section>
            <Section title="Burn-down">
              <BurnDown b={d.burn_down} />
            </Section>
          </div>

          <Section title="What Backstop does not enforce">
            <HonestPanels data={d} />
          </Section>
        </>
      )}
    </div>
  );
}
