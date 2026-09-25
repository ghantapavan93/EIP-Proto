import { Chip } from '../ui/Chip';
import { directionLabel, directionTone } from '../../lib/vocab';

/** Staleness direction: under-restrictive (red), over-restrictive (amber), re-verify (slate). */
export function DirectionChip({ direction, className }: { direction: string | null | undefined; className?: string }) {
  if (!direction) return <span className="text-ink-3">—</span>;
  return (
    <Chip tone={directionTone(direction)} className={className} title={direction}>
      {directionLabel(direction)}
    </Chip>
  );
}
