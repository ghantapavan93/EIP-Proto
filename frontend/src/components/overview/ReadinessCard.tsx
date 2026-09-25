import { Link } from 'react-router-dom';
import { ArrowRight, CalendarClock } from 'lucide-react';
import { useReadiness } from '../../api/hooks';
import { cn } from '../../lib/cn';
import { fmtDate } from '../../lib/format';

/**
 * The change-triggers view of /readiness in one row: days to the next rule
 * change and to AEP, the open actionable work, and what is still stale on
 * the target date. Renders nothing when the server has no readiness route.
 */
export function ReadinessCard({ asOf, className }: { asOf: string; className?: string }) {
  const { data } = useReadiness(asOf);
  if (!data) return null;
  const b = data.burn_down;
  const vote = data.proposed.filter((p) => p.vote_date).sort((x, y) => (x.vote_date ?? '').localeCompare(y.vote_date ?? ''))[0];
  const facts: Array<[string, string, boolean]> = [
    [String(Math.max(0, b.days_left)), `days to ${fmtDate(b.target)}`, false],
    [String(Math.max(0, b.aep.days_left)), 'days to AEP', false],
    // Not the status bar's number: that counts untouched (state open) items; this counts all actionable work not yet closed.
    [String(b.open_actionable_now), 'actionable, not closed', b.open_actionable_now > 0],
    [String(b.stale_encodings_on_target), `stale on ${fmtDate(b.target).slice(0, 6)}`, b.stale_encodings_on_target > 0],
  ];
  return (
    <Link
      to="/readiness"
      className={cn('card flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 transition-colors hover:border-teal hover:no-underline', className)}
      aria-label="Readiness: open the countdown, milestones and owner queues"
      data-testid="readiness-card"
    >
      <span className="inline-flex items-center gap-2">
        <CalendarClock size={15} className="text-teal-ink" aria-hidden />
        <span className="eyebrow">Readiness</span>
      </span>
      <dl className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
        {facts.map(([value, label, warn]) => (
          <div key={label} className="flex items-baseline gap-1.5">
            <dt className="order-2 text-[12px] text-ink-2">{label}</dt>
            <dd className={cn('order-1 m-0 stat text-[18px]', warn ? 'text-amber-ink' : 'text-ink')}>{value}</dd>
          </div>
        ))}
      </dl>
      <span className="text-[12px] text-ink-2">
        {data.vacated.length} vacated (not enforced){vote ? ` · vote ${fmtDate(vote.vote_date)} on ${vote.rule_code}` : ''}
      </span>
      <span className="ml-auto inline-flex items-center gap-1 text-[12.5px] font-semibold text-teal-ink">
        Open readiness <ArrowRight size={13} aria-hidden />
      </span>
    </Link>
  );
}
