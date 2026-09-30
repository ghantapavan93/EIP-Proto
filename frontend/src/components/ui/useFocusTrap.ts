import { useEffect, type RefObject } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Active traps, innermost last: only the innermost handles Tab (a drawer opened from inside a drawer). */
const activeTraps: HTMLElement[] = [];

/**
 * Focus handling for a modal dialog. While `active`:
 * - focus moves into the dialog (`initialFocusRef`, else the container itself);
 * - Tab and Shift+Tab cycle through the dialog's focusable elements and never
 *   reach the page behind it;
 * and when it deactivates or unmounts, focus returns to the element that had
 * it when the dialog opened, so keyboard users continue where they were.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement>,
  active: boolean,
  initialFocusRef?: RefObject<HTMLElement>,
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!active || !container) return;
    const restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    activeTraps.push(container);
    // After the opening render settles, so the element exists and is not immediately blurred.
    const timer = window.setTimeout(() => (initialFocusRef?.current ?? container).focus(), 0);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || activeTraps[activeTraps.length - 1] !== container) return;
      const items = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
      const current = document.activeElement;
      if (!items.length) {
        e.preventDefault();
        container.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const inside = current instanceof Node && container.contains(current);
      if (!inside || (e.shiftKey && (current === first || current === container))) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKeyDown);
      const index = activeTraps.indexOf(container);
      if (index >= 0) activeTraps.splice(index, 1);
      if (restoreTo?.isConnected) restoreTo.focus();
    };
  }, [active, containerRef, initialFocusRef]);
}
