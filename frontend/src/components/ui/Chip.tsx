import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import type { Tone } from '../../lib/vocab';

export interface ChipProps {
  tone?: Tone;
  /** Solid fill — reserved for gate states. */
  filled?: boolean;
  mono?: boolean;
  /** Let a long label wrap onto a second line (narrow table columns) instead of forcing the column wider. */
  wrap?: boolean;
  /** xs: 16px, for inline use in dense strips (status rail, table cells) */
  size?: 'sm' | 'xs';
  title?: string;
  className?: string;
  children: ReactNode;
}

/* Soft chips: a light tint of the tone with its -ink text (all ≥4.5:1 — see index.css). */
const SOFT: Record<Tone, string> = {
  neutral: 'border-hairline bg-band text-ink-2',
  teal: 'border-teal/30 bg-teal/10 text-teal-ink',
  green: 'border-green/40 bg-green/14 text-green-ink',
  amber: 'border-amber/30 bg-amber/12 text-amber-ink',
  red: 'border-red/25 bg-red/8 text-red',
  slate: 'border-slate/15 bg-slate/8 text-slate',
};

const FILLED: Record<Tone, string> = {
  neutral: 'border-ink-3 bg-ink-3 text-on-navy',
  teal: 'border-teal-ink bg-teal-ink text-on-navy',
  green: 'border-green-ink bg-green-ink text-on-navy',
  amber: 'border-amber-ink bg-amber-ink text-on-navy',
  red: 'border-red bg-red text-on-navy',
  slate: 'border-slate bg-slate text-on-navy',
};

/**
 * 20px status chip: 11px uppercase on a soft tint of its tone with darker
 * text; solid only when `filled` (gate states). 4px radius; never a pill.
 */
export function Chip({ tone = 'neutral', filled = false, mono = false, wrap = false, size = 'sm', title, className, children }: ChipProps) {
  return (
    <span
      title={title}
      data-tone={tone}
      data-filled={filled ? 'true' : 'false'}
      className={cn(
        'inline-flex items-center gap-1 rounded-[4px] border align-middle font-semibold uppercase tracking-[0.04em]',
        size === 'xs' ? 'px-1 text-[10px]' : 'px-1.5 text-[11px]',
        wrap ? 'min-h-5 whitespace-normal py-[3px] leading-tight' : size === 'xs' ? 'h-4 whitespace-nowrap leading-none' : 'h-5 whitespace-nowrap leading-none',
        mono && 'font-mono normal-case tracking-normal',
        filled ? FILLED[tone] : SOFT[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
