/**
 * Causality motion for the rule blast radius: one ~700 ms sequence that reads
 * left to right — the in-force version changes, the dependent counts tick,
 * the affected artifact rows tint amber and fade, the review-task count
 * updates, then the gate. No motion at all under prefers-reduced-motion.
 *
 * Staging is done with CSS animation delays (see index.css `.cz-*`), so the
 * sequence replays by bumping a React key; the only JS animation is the
 * number tick.
 */

import { useEffect, useRef, useState } from 'react';

/** Delays (ms) for each step of the sequence; the whole run ends by ~700 ms. */
export const CAUSALITY_STEPS = {
  version: 0,
  counts: 120,
  rows: 260,
  tasks: 440,
  gate: 560,
} as const;

export const TICK_MS = 220;

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(REDUCED_QUERY).matches;
}

/** Live prefers-reduced-motion flag. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(REDUCED_QUERY);
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

/**
 * Whether a new blast-radius result should replay the sequence: on the first
 * computed radius, and whenever the in-force version flips (the as-of date
 * crossed an effective date). Moving the date within one version's window
 * does not replay — nothing causal happened.
 */
export function shouldReplayCausality(prev: { inForce: number | null } | null, next: { inForce: number | null }): boolean {
  if (prev === null) return true;
  return prev.inForce !== next.inForce;
}

/**
 * A replay counter for the causality sequence. Returns 0 until the first
 * radius is computed, then increments each time `shouldReplayCausality` says
 * so. Use it as a React key on the animated elements.
 */
export function useCausalitySequence(result: { inForce: number | null; asOf: string } | null): number {
  const prev = useRef<{ inForce: number | null } | null>(null);
  const [seq, setSeq] = useState(0);
  const inForce = result?.inForce ?? null;
  const hasResult = result !== null;
  const asOf = result?.asOf;
  useEffect(() => {
    if (!hasResult) return;
    const next = { inForce };
    if (shouldReplayCausality(prev.current, next)) setSeq((n) => n + 1);
    prev.current = next;
  }, [hasResult, inForce, asOf]);
  return seq;
}

/**
 * Tween a number from its previous value to `value` after `delayMs`. Under
 * reduced motion (or when `animate` is false) it shows the new value at once.
 */
export function useTickingNumber(value: number, { delayMs = 0, animate = true, from: initial }: { delayMs?: number; animate?: boolean; from?: number } = {}): number {
  const reduced = usePrefersReducedMotion();
  // `from` makes the first render count up once (a hero number on mount); otherwise the first value shows as-is
  const [shown, setShown] = useState(initial ?? value);
  const from = useRef(initial ?? value);
  useEffect(() => {
    const start = from.current;
    from.current = value;
    if (!animate || reduced || start === value || typeof window.requestAnimationFrame !== 'function') {
      setShown(value);
      return;
    }
    let raf = 0;
    const timer = window.setTimeout(() => {
      const t0 = performance.now();
      // read the clock here rather than trusting the rAF timestamp's origin; clamp so it never overshoots
      const step = () => {
        const k = Math.min(1, Math.max(0, (performance.now() - t0) / TICK_MS));
        setShown(Math.round(start + (value - start) * k));
        if (k < 1) raf = window.requestAnimationFrame(step);
      };
      raf = window.requestAnimationFrame(step);
    }, delayMs);
    // rAF never fires in a background tab (or a non-visual DOM): land on the true value regardless
    const settle = window.setTimeout(() => setShown(value), delayMs + TICK_MS + 80);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(settle);
      window.cancelAnimationFrame(raf);
      setShown(value);
    };
  }, [value, delayMs, animate, reduced]);
  return shown;
}
