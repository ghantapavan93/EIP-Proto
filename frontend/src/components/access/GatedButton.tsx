import { useId, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import type { RoleAction } from '../../lib/roles';
import { usePermission } from './usePermission';

/**
 * A control that stays visible when the role may not use it: it renders
 * `aria-disabled` (still focusable, so keyboard users can reach the reason),
 * swallows the click, and shows why after a 300 ms hover or on focus.
 * Hiding the control would hide the separation of duties from the reader.
 */
export function ReasonTip({ reason, children, align = 'right', className }: { reason: ReactNode; children: (describedBy: string) => ReactNode; align?: 'left' | 'right'; className?: string }) {
  const id = useId();
  return (
    <span className={cn('tip-host', className)}>
      {children(id)}
      <span role="tooltip" id={id} className={cn('tip', align === 'left' ? 'tip-left' : 'tip-right')}>
        {reason}
      </span>
    </span>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

/** A button refused with a reason: focusable, inert, explained. */
export function DisabledWithReason({ reason, className, children, align, ...rest }: ButtonProps & { reason: ReactNode; align?: 'left' | 'right' }) {
  return (
    <ReasonTip reason={reason} align={align}>
      {(describedBy) => (
        <button
          type="button"
          {...rest}
          className={className}
          aria-disabled="true"
          aria-describedby={describedBy}
          onClick={(e) => e.preventDefault()}
        >
          {children}
        </button>
      )}
    </ReasonTip>
  );
}

/** A button gated on a role action: the real button when allowed, else disabled with the refusal sentence. */
export function GatedButton({ action, children, align, ...rest }: ButtonProps & { action: RoleAction; align?: 'left' | 'right' }) {
  const permission = usePermission(action);
  if (!permission.known) {
    // role not known yet (first paint): hold the control inert rather than guess either way
    const { onClick: _wait, ...rest2 } = rest;
    return (
      <button type="button" {...rest2} disabled>
        {children}
      </button>
    );
  }
  if (permission.allowed) {
    return (
      <button type="button" {...rest}>
        {children}
      </button>
    );
  }
  const { onClick: _ignored, disabled: _disabled, type: _type, ...inert } = rest;
  return (
    <DisabledWithReason {...inert} reason={permission.why} align={align}>
      {children}
    </DisabledWithReason>
  );
}
