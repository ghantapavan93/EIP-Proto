import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Eyebrow } from '../ui/Eyebrow';

/** Page header: small uppercase eyebrow, h1, one-sentence description, right-side actions. */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-x-6 gap-y-3 px-4 pb-4 pt-6 sm:px-6', className)}>
      <div className="min-w-0 max-w-3xl">
        {eyebrow && <div className="eyebrow mb-1.5">{eyebrow}</div>}
        <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.01em] text-ink sm:text-[24px]">{title}</h1>
        {description && <div className="mt-1.5 text-[14px] leading-relaxed text-ink-2">{description}</div>}
      </div>
      {actions && <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Content section with an eyebrow label; `band` gives the light band treatment. */
export function Section({
  title,
  right,
  children,
  band = false,
  className,
  id,
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  band?: boolean;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cn(band ? 'band px-4 py-4 sm:px-6' : 'px-4 py-4 sm:px-6', className)}>
      {(title || right) && (
        <Eyebrow as="h2" className="mb-2.5" right={right}>
          {title}
        </Eyebrow>
      )}
      {children}
    </section>
  );
}

/** Form field wrapper with a label and optional hint/error. */
export function Field({
  label,
  children,
  hint,
  error,
  className,
  htmlFor,
}: {
  label: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={className}>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && !error && <div className="mt-1 text-[11px] text-ink-3">{hint}</div>}
      {error && <div className="mt-1 text-[11px] text-red">{error}</div>}
    </div>
  );
}
