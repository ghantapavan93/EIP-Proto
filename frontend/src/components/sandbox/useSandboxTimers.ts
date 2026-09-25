import { useEffect, useState } from 'react';

/**
 * While `busy`, marks <html data-live-busy> so the sandbox pulse is the only
 * one on screen (the health ring in the top bar stands down).
 */
export function useLiveBusy(busy: boolean): void {
  useEffect(() => {
    if (!busy) return;
    const root = document.documentElement;
    root.setAttribute('data-live-busy', '');
    return () => root.removeAttribute('data-live-busy');
  }, [busy]);
}

/** Whole seconds since `active` became true; 0 when inactive. */
export function useElapsedSeconds(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }
    const started = Date.now();
    setSeconds(0);
    const t = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 250);
    return () => window.clearInterval(t);
  }, [active]);
  return seconds;
}
