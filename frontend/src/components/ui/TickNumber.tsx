import { useTickingNumber } from '../../lib/motion';

/** A count that ticks from its previous value after `delayMs` (instant under reduced motion). */
export function TickNumber({ value, delayMs = 0, from, className }: { value: number; delayMs?: number; from?: number; className?: string }) {
  const shown = useTickingNumber(value, { delayMs, from });
  return (
    <span className={className} data-value={value}>
      {shown}
    </span>
  );
}
