import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface EyebrowProps {
  children: ReactNode;
  className?: string;
  /** optional right-aligned helper text */
  right?: ReactNode;
  /** element for the label itself (h2 for section titles, span inline) */
  as?: 'span' | 'h2' | 'h3' | 'div';
}

/** 11px uppercase tracked section label. */
export function Eyebrow({ children, className, right, as: Tag = 'span' }: EyebrowProps) {
  return (
    <div className={cn('flex items-center justify-between gap-3', className)}>
      <Tag className={cn('eyebrow', Tag === 'h2' && 'text-slate')}>{children}</Tag>
      {right && <span className="text-xs text-ink-2">{right}</span>}
    </div>
  );
}
