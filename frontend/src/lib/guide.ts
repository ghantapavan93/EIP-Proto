/**
 * The "Where we are" guide on Change triggers: dismissible, remembered per
 * browser. Storage can be missing or throw (private windows, blocked site
 * data), so every access is guarded and the guide simply shows.
 */

export const GUIDE_KEY = 'backstop.guide.hidden';

export function readGuideHidden(): boolean {
  try {
    return window.localStorage.getItem(GUIDE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeGuideHidden(hidden: boolean): void {
  try {
    if (hidden) window.localStorage.setItem(GUIDE_KEY, '1');
    else window.localStorage.removeItem(GUIDE_KEY);
  } catch {
    /* storage unavailable — the choice lasts for this page only */
  }
}
