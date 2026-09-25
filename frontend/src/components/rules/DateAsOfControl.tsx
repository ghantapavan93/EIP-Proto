import { CalendarDays } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface DateAsOfControlProps {
  value: string;
  onChange: (value: string) => void;
  /** quick-pick dates, e.g. the day before and the day of a rule flip */
  quick?: string[];
  label?: string;
  className?: string;
}

/** "Evaluate as of" date input with quick buttons. */
export function DateAsOfControl({ value, onChange, quick = [], label = 'Evaluate as of', className }: DateAsOfControlProps) {
  return (
    <div className={cn('flex flex-wrap items-end gap-2', className)}>
      <label className="block">
        <span className="label">{label}</span>
        <span className="relative block">
          <CalendarDays size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />
          <input
            type="date"
            className="input w-[170px] pl-7 font-mono text-[12px]"
            value={value}
            onChange={(e) => e.target.value && onChange(e.target.value)}
          />
        </span>
      </label>
      {quick.map((d) => (
        <button
          key={d}
          type="button"
          className={cn('btn btn-sm font-mono normal-case tracking-normal', value === d ? '' : 'btn-outline')}
          onClick={() => onChange(d)}
          aria-pressed={value === d}
        >
          {d}
        </button>
      ))}
    </div>
  );
}
