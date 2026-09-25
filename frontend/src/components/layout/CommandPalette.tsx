import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { canEdit, useAssets, useExportEvidence, useRole, useRules, useRuns } from '../../api/hooks';
import { useToast } from '../ui/useToast';
import { bundleHashLabel, fmtTs } from '../../lib/format';
import { evidenceForLocation, filterPalette, OPEN_PALETTE_EVENT, type PaletteItem } from '../../lib/palette';
import { cn } from '../../lib/cn';

const LIST_ID = 'command-palette-list';

/**
 * Ctrl+K / ⌘K: go to a rule, artifact or run by code or id, open the review
 * queue, start a new run, or export evidence for the page you are on. Plain
 * navigation. Focus is trapped in the dialog; Esc closes and returns focus.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const role = useRole();
  const { toast } = useToast();
  const exportEvidence = useExportEvidence();
  // Lists load only while the palette is open (usually already cached from the pages).
  const rules = useRules({ enabled: open });
  const assets = useAssets({ enabled: open });
  const runs = useRuns({ enabled: open });

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => {
          if (!o) restoreRef.current = document.activeElement as HTMLElement | null;
          return !o;
        });
      }
    };
    // the top bar's search button opens the palette without a synthetic key event
    const onOpen = () => {
      restoreRef.current = document.activeElement as HTMLElement | null;
      setOpen(true);
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpen);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    } else {
      restoreRef.current?.focus?.();
    }
  }, [open]);

  const evidence = useMemo(() => evidenceForLocation(location.pathname, location.search), [location.pathname, location.search]);
  const items = useMemo<PaletteItem[]>(() => {
    const actions: PaletteItem[] = [
      { id: 'review', group: 'Actions', label: 'Open review queue', hint: '/review', keywords: 'tasks actionable', to: '/review' },
      { id: 'try', group: 'Actions', label: 'Try it with your own text', hint: '/try', keywords: 'sandbox paste check artifact transcript', to: '/try' },
      ...(canEdit(role) ? [{ id: 'new-run', group: 'Actions' as const, label: 'New run', hint: '/runs', keywords: 'start replay', to: '/runs?new=1' }] : []),
      ...(evidence
        ? [{ id: 'evidence', group: 'Actions' as const, label: `Export evidence for this ${evidence.scope === 'tasks' ? 'task' : evidence.scope === 'runs' ? 'run' : 'rule'}`, hint: 'json bundle', keywords: 'export bundle sha256', evidence }]
        : []),
      { id: 'audit', group: 'Actions', label: 'Open audit log', hint: '/audit', keywords: 'chain verify', to: '/audit' },
      { id: 'governance', group: 'Actions', label: 'Open governance', hint: '/governance', keywords: 'admin access roles permissions checkpoint rbac separation duties', to: '/governance' },
      { id: 'readiness', group: 'Actions', label: 'Open readiness', hint: '/readiness', keywords: 'deadlines aep october milestones owners vacated proposed', to: '/readiness' },
    ];
    const ruleItems: PaletteItem[] = (rules.data ?? []).map((r) => ({ id: `rule-${r.code}`, group: 'Rules', label: r.title, hint: r.code, keywords: r.citation, to: `/rules/${encodeURIComponent(r.code)}` }));
    const assetItems: PaletteItem[] = (assets.data ?? []).map((a) => ({ id: `asset-${a.code}`, group: 'Artifacts', label: a.name, hint: a.code, keywords: a.type, to: `/artifacts/${encodeURIComponent(a.code)}` }));
    const runItems: PaletteItem[] = [...(runs.data ?? [])]
      .sort((a, b) => (a.started_at < b.started_at ? 1 : -1))
      .map((r) => ({
        id: `run-${r.id}`,
        group: 'Runs',
        label: `${r.workflow_code} v${r.prompt_version} · ${r.model_id} · ${r.gate}`,
        hint: `${r.id.slice(0, 8)} · ${fmtTs(r.started_at)}`,
        keywords: `${r.id} ${r.trigger} ${r.rule_date}`,
        to: `/runs/${r.id}`,
      }));
    return [...actions, ...ruleItems, ...assetItems, ...runItems];
  }, [rules.data, assets.data, runs.data, role, evidence]);

  const results = useMemo(() => filterPalette(items, query), [items, query]);
  const activeIndex = Math.min(active, Math.max(0, results.length - 1));

  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    setOpen(false);
    if (item.to) navigate(item.to);
    else if (item.evidence) {
      exportEvidence.mutate(
        { ...item.evidence, format: 'json' },
        {
          onSuccess: ({ filename, sha256 }) => toast({ title: `Evidence bundle exported · sha256 ${bundleHashLabel(sha256)}`, detail: filename, tone: 'green' }),
          onError: (err) => toast({ title: 'Evidence export failed', detail: err.message, tone: 'red' }),
        },
      );
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(results[activeIndex]);
    } else if (e.key === 'Tab') {
      // focus trap: the input is the only tab stop; options are reached with the arrows
      e.preventDefault();
      inputRef.current?.focus();
    }
  };

  if (!open) return null;
  let lastGroup = '';
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-slate/40 px-4 pt-[12vh]" onMouseDown={() => setOpen(false)} role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-[560px] border border-hairline bg-surface"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-hairline px-3">
          <Search size={14} className="text-ink-3" aria-hidden />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={LIST_ID}
            aria-activedescendant={results[activeIndex] ? `cmd-${results[activeIndex].id}` : undefined}
            aria-autocomplete="list"
            className="h-11 w-full bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3"
            placeholder="Go to a rule, artifact or run by code or id…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
          />
          <kbd className="shrink-0 border border-input px-1 text-[10px] text-ink-3">Esc</kbd>
        </div>
        <ul id={LIST_ID} role="listbox" aria-label="Results" className="max-h-[52vh] overflow-y-auto py-1">
          {results.length === 0 && <li className="px-3 py-3 text-[13px] text-ink-2">{rules.isLoading || runs.isLoading ? 'Loading…' : 'No match.'}</li>}
          {results.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <li key={item.id} role="presentation">
                {header && <div className="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-[1px] text-ink-3">{header}</div>}
                <div
                  id={`cmd-${item.id}`}
                  role="option"
                  aria-selected={i === activeIndex}
                  className={cn('flex cursor-pointer items-center gap-3 px-3 py-1.5 text-[13px]', i === activeIndex ? 'bg-teal/10 text-navy' : 'text-ink')}
                  onMouseMove={() => setActive(i)}
                  onClick={() => run(item)}
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint && <span className="shrink-0 font-mono text-[11px] text-ink-3">{item.hint}</span>}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="border-t border-hairline px-3 py-1.5 text-[11px] text-ink-3">↑↓ to move · Enter to open · Ctrl+K / ⌘K to toggle</div>
      </div>
    </div>
  );
}
