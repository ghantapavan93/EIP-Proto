import { Radio } from 'lucide-react';
import { Chip } from '../ui/Chip';
import { adapterLabel, adapterTone } from '../../lib/vocab';

/** simulated | cassette | LIVE. `compact` is accepted for call-site compatibility; the label is already short. */
export function AdapterChip({ adapter, className }: { adapter: string | null | undefined; className?: string; compact?: boolean }) {
  const live = adapter === 'live' || adapter === 'anthropic';
  return (
    <Chip tone={adapterTone(adapter)} className={className} title={`Adapter: ${adapter ?? '—'}`}>
      {live && <Radio size={11} aria-hidden />}
      {adapterLabel(adapter)}
    </Chip>
  );
}
