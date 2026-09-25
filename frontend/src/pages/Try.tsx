import { useRef, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMeta } from '../api/hooks';
import { useTopBar } from '../components/layout/useShell';
import { PageHeader, Section } from '../components/layout/Page';
import { ArtifactCheck } from '../components/sandbox/ArtifactCheck';
import { TranscriptCheck } from '../components/sandbox/TranscriptCheck';
import { todayIso } from '../lib/format';
import { cn } from '../lib/cn';

type Tab = 'artifact' | 'transcript';

const TABS: Array<{ id: Tab; label: string; hint: string }> = [
  { id: 'artifact', label: 'Artifact check', hint: 'no model needed' },
  { id: 'transcript', label: 'Call transcript', hint: 'runs on a local model' },
];

/**
 * /try — the sandbox. Tab one checks any pasted script, page or prompt
 * against the versioned rules with the deterministic matchers; tab two runs
 * one pasted call through the real workflow on a local model. Nothing is
 * persisted by either.
 */
export function TryPage() {
  useTopBar([{ label: 'Try your data' }]);
  const meta = useMeta();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'transcript' ? 'transcript' : 'artifact';
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ artifact: null, transcript: null });

  const select = (next: Tab, focus = false) => {
    const p = new URLSearchParams(params);
    if (next === 'artifact') p.delete('tab');
    else p.set('tab', next);
    setParams(p, { replace: true });
    if (focus) tabRefs.current[next]?.focus();
  };
  const onTabKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    select(tab === 'artifact' ? 'transcript' : 'artifact', true);
  };

  return (
    <div>
      <PageHeader
        eyebrow="Sandbox · nothing stored"
        title="Try it with your own text"
        description="Paste a script, scorecard item, email or web page. Backstop marks every sentence that encodes one of its versioned rules and says whether it is still right on the date you pick — and if not, in which direction."
      />
      <div className="px-4 sm:px-6">
        <div role="tablist" aria-label="Sandbox" className="flex gap-1 border-b border-hairline" onKeyDown={onTabKey}>
          {TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              id={`try-tab-${t.id}`}
              role="tab"
              type="button"
              aria-selected={tab === t.id}
              aria-controls={`try-panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className={cn('tab inline-flex h-10 items-baseline gap-2 px-3')}
              onClick={() => select(t.id)}
            >
              {t.label}
              <span className="hidden text-[11px] font-medium text-ink-3 sm:inline">{t.hint}</span>
            </button>
          ))}
        </div>
      </div>
      <Section className="pt-4">
        <div role="tabpanel" id={`try-panel-${tab}`} aria-labelledby={`try-tab-${tab}`}>
          {tab === 'artifact' ? <ArtifactCheck today={meta.data?.today ?? todayIso()} /> : <TranscriptCheck onUseArtifact={() => select('artifact', true)} />}
        </div>
      </Section>
    </div>
  );
}
