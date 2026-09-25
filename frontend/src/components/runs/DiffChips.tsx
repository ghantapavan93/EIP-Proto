import { Chip } from '../ui/Chip';
import type { WhatChanged } from '../../api/types';

const ORDER: Array<{ key: keyof WhatChanged; label: string }> = [
  { key: 'prompt', label: 'PROMPT' },
  { key: 'model', label: 'MODEL' },
  { key: 'rule_date', label: 'RULE DATE' },
  { key: 'adapter', label: 'ADAPTER' },
  { key: 'corpus', label: 'CORPUS' },
  { key: 'contract_set', label: 'CONTRACT SET' },
];

/** The six run keys — PROMPT / MODEL / RULE DATE / ADAPTER / CORPUS / CONTRACT SET — teal when they differ, grey when the same. */
export function DiffChips({ whatChanged, className }: { whatChanged: WhatChanged; className?: string }) {
  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-1.5">
        {ORDER.map(({ key, label }) => {
          const changed = whatChanged[key] === true;
          return (
            <Chip key={key} tone={changed ? 'teal' : 'neutral'} title={changed ? `${label} differs` : `${label} unchanged`}>
              {changed && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-teal-ink" />}
              {label}
              {changed ? ' · changed' : ' · same'}
            </Chip>
          );
        })}
      </div>
    </div>
  );
}
