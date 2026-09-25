import { CalendarClock, Gavel, PauseCircle } from 'lucide-react';
import type { RuleOut, RuleVersionOut } from '../../api/types';
import { cn } from '../../lib/cn';
import { fmtDate } from '../../lib/format';
import { deferralLine, statusPresentation } from '../../lib/ruleVersions';
import { Chip } from '../ui/Chip';

/**
 * A version's status as a chip, drawn so it cannot be mistaken for law:
 * vacated is slate with the version struck through, stayed is amber,
 * proposed has a dashed outline. Everything else is the plain status chip.
 */
export function VersionStatusChip({
  version,
  withNumber = true,
  showVote = true,
  className,
}: {
  version: Pick<RuleVersionOut, 'version' | 'status' | 'vote_date' | 'effective_from'>;
  withNumber?: boolean;
  /** proposals: append the vote date (off where the date is printed beside the chip) */
  showVote?: boolean;
  className?: string;
}) {
  const p = statusPresentation(version);
  const number = withNumber ? <span className={cn('font-mono normal-case', p.strike && 'line-through')}>v{version.version}</span> : null;
  if (version.status === 'vacated') {
    return (
      <Chip tone="slate" className={className} title={p.note}>
        <Gavel size={10} aria-hidden />
        {number} {p.label}
      </Chip>
    );
  }
  if (version.status === 'stayed') {
    return (
      <Chip tone="amber" className={className} title={p.note}>
        <PauseCircle size={10} aria-hidden />
        {number} {p.label}
      </Chip>
    );
  }
  if (version.status === 'proposed') {
    return (
      <Chip tone="teal" className={cn('border-dashed border-teal-ink/60 bg-surface', className)} title={p.note}>
        {number} {p.label}
        {showVote && version.vote_date ? <span className="font-normal normal-case tracking-normal">· vote {fmtDate(version.vote_date)}</span> : null}
      </Chip>
    );
  }
  return (
    <Chip tone={p.tone} className={className}>
      {number} {p.label}
    </Chip>
  );
}

/** "revoke-all deferred to Jan 31, 2027" as a chip, with the source in its title. */
export function DeferralChip({ provision, deferred_to, source }: { provision: string; deferred_to: string; source: string }) {
  return (
    <Chip tone="neutral" wrap title={`${provision}${source ? ` — source: ${source}` : ''}`}>
      <CalendarClock size={10} aria-hidden />
      <span className="normal-case tracking-normal">{deferralLine({ provision, deferred_to, source })}</span>
    </Chip>
  );
}

/**
 * The versions of a rule that are not simply "in force or superseded" —
 * vacated, stayed, proposed — plus any deferred provision. Empty for a rule
 * with an ordinary history.
 */
export function RuleStatusNotes({ rule, className }: { rule: Pick<RuleOut, 'versions'>; className?: string }) {
  const unusual = [...rule.versions].filter((v) => ['vacated', 'stayed', 'proposed'].includes(v.status)).sort((a, b) => a.version - b.version);
  const deferrals = rule.versions.flatMap((v) => v.deferrals ?? []);
  if (!unusual.length && !deferrals.length) return null;
  return (
    <span className={cn('flex flex-wrap items-center gap-1', className)}>
      {unusual.map((v) => (
        <VersionStatusChip key={v.id} version={v} />
      ))}
      {deferrals.map((d) => (
        <DeferralChip key={`${d.provision}-${d.deferred_to}`} {...d} />
      ))}
    </span>
  );
}
