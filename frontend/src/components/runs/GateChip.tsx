import { Chip } from '../ui/Chip';
import { gateTone } from '../../lib/vocab';

/** GREEN / AMBER / RED / GREY gate — the one chip family that gets a solid fill. */
export function GateChip({ gate, className }: { gate: string | null | undefined; className?: string }) {
  const value = gate ?? 'GREY';
  return (
    <Chip tone={gateTone(value)} filled title={`Gate: ${value}`} className={className}>
      {value}
    </Chip>
  );
}
