import type { RunOut } from '../../api/types';
import { runCorpus } from '../../lib/runStats';
import { Chip } from '../ui/Chip';

export const HOLDOUT_TOOLTIP =
  '60 calls recorded after the prompts were written; measures overfitting to the development calls';
export const INGESTED_TOOLTIP = 'Redacted real transcripts with no ground truth; rule contracts report ERROR for them';

interface CorpusChipProps {
  run: Pick<RunOut, 'stats'> & { corpus?: string | null };
  size?: 'sm' | 'xs';
  className?: string;
}

/**
 * Which call set a run replayed. Nothing for the development corpus (the
 * default); "HELD-OUT · H001–H060" or "INGESTED" otherwise, so a held-out
 * number is never read as a development number.
 */
export function CorpusChip({ run, size = 'sm', className }: CorpusChipProps) {
  const corpus = runCorpus(run);
  if (corpus === 'holdout') {
    return (
      <Chip tone="slate" size={size} title={HOLDOUT_TOOLTIP} className={className}>
        HELD-OUT · H001–H060
      </Chip>
    );
  }
  if (corpus === 'ingested') {
    return (
      <Chip tone="neutral" size={size} title={INGESTED_TOOLTIP} className={className}>
        INGESTED
      </Chip>
    );
  }
  if (corpus === 'all') {
    return (
      <Chip tone="neutral" size={size} title="Every call: development, held-out and ingested" className={className}>
        ALL CALLS
      </Chip>
    );
  }
  return null;
}
