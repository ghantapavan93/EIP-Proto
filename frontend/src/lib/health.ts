/** Readiness components from /status and /health/deep: labels and semantic tones. */

import type { HealthComponent } from '../api/types';

const COMPONENT_LABELS: Record<string, string> = {
  api: 'API',
  database: 'Database',
  rules: 'Rules',
  artifacts: 'Artifacts',
  runner: 'Runner',
  ollama: 'Ollama',
};

/** "database" + "PostgreSQL" → "Postgres"; everything else keeps its label. */
export function componentLabel(c: Pick<HealthComponent, 'name' | 'detail'>): string {
  if (c.name === 'database' && /postgres/i.test(c.detail)) return 'Postgres';
  return COMPONENT_LABELS[c.name] ?? c.name.charAt(0).toUpperCase() + c.name.slice(1);
}

/** healthy → green; an optional component that is offline → grey (not evaluated); anything else → red. */
export function componentTone(c: Pick<HealthComponent, 'state' | 'required'>): 'green' | 'neutral' | 'red' | 'amber' {
  if (c.state === 'healthy') return 'green';
  if (!c.required) return 'neutral';
  return c.state === 'degraded' ? 'amber' : 'red';
}

/** Word shown for a component's state: "ready" for the runner / optional providers, else the state. */
export function stateWord(c: HealthComponent): string {
  if (c.state === 'healthy') return c.name === 'runner' || c.name === 'ollama' ? 'ready' : 'healthy';
  return c.state;
}

export function statusTextClass(status: string | null | undefined): string {
  return status === 'healthy' ? 'text-green-ink' : status === 'degraded' ? 'text-amber-ink' : status === 'down' ? 'text-red' : 'text-ink-3';
}

