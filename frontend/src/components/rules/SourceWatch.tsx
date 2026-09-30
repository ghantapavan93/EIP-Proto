import { useMemo, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { useCheckSources, useRuleSources } from '../../api/hooks';
import type { RuleSourceOut } from '../../api/types';
import { GatedButton } from '../access/GatedButton';
import { Chip } from '../ui/Chip';
import { ErrorState } from '../ui/ErrorState';
import { useToast } from '../ui/useToast';
import { fmtTs, shortHash } from '../../lib/format';

/** Source watch strip: GET /rules/{code}/sources, newest first, plus "Check sources". */
export function SourceWatch({ code }: { code: string }) {
  const sources = useRuleSources(code);
  const check = useCheckSources();
  const { toast } = useToast();
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(() => sources.data ?? [], [sources.data]);
  const latestByUrl = useMemo(() => {
    const seen = new Map<string, RuleSourceOut>();
    for (const s of rows) if (!seen.has(s.source_url)) seen.set(s.source_url, s);
    return [...seen.values()];
  }, [rows]);
  const visible = showAll ? rows : latestByUrl;

  return (
    <div className="px-4 py-4 sm:px-6">
      <div className="card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="eyebrow">Source watch</span>
          <span className="text-xs text-ink-2">
            {rows.length
              ? `${latestByUrl.length} source${latestByUrl.length === 1 ? '' : 's'} · last checked ${fmtTs(rows[0]?.checked_at)}`
              : sources.isLoading
                ? 'loading…'
                : 'no source checks recorded'}
          </span>
          {rows.length > latestByUrl.length && (
            <button type="button" className="text-xs text-teal-ink" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'latest only' : `history (${rows.length})`}
            </button>
          )}
          <span className="ml-auto">
            <GatedButton
              action="check_rule_sources"
              className="btn btn-outline btn-sm"
              disabled={check.isPending}
              onClick={() =>
                check.mutate(
                  { live: false },
                  {
                    onSuccess: (r) => {
                      toast({
                        title: `Checked ${r.checked} sources · ${r.changed} changed · ${r.first_seen} first seen · ${r.errors} errors`,
                        detail:
                          r.mode === 'snapshot'
                            ? 'Replayed the frozen copies: this confirms the stored copy, not the live page.'
                            : `mode ${r.mode}`,
                        // an error means UNKNOWN, never "unchanged"
                        tone: r.errors ? 'red' : r.changed ? 'amber' : r.mode === 'snapshot' ? 'teal' : 'green',
                      });
                      void sources.refetch();
                    },
                    onError: (err) => toast({ title: 'Source check refused', detail: err.message, tone: 'red' }),
                  },
                )
              }
            >
              <RefreshCw size={12} aria-hidden /> {check.isPending ? 'Checking…' : 'Check sources'}
            </GatedButton>
          </span>
        </div>
        {sources.error ? <ErrorState error={sources.error} className="mt-2" /> : null}
        {visible.length > 0 && (
          <ul className="mt-2 space-y-2">
            {visible.map((s) => (
              <li
                key={s.id}
                className="grid grid-cols-1 gap-x-4 gap-y-1 text-[12px] lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {s.error ? (
                      <Chip tone="red" title={s.error}>
                        error
                      </Chip>
                    ) : s.changed ? (
                      <Chip tone="amber">changed</Chip>
                    ) : rows.filter((r) => r.source_url === s.source_url).length === 1 ? (
                      <Chip tone="teal">first seen</Chip>
                    ) : s.fetch_mode === 'snapshot' ? (
                      <Chip tone="neutral" title="The frozen copy was replayed; the live page was not fetched">
                        replayed · not fetched
                      </Chip>
                    ) : (
                      <Chip tone="green">unchanged</Chip>
                    )}
                    <span className="font-mono text-ink-2" title={s.content_hash}>
                      {shortHash(s.content_hash, 12)}
                    </span>
                    <span className="font-mono text-ink-3">{fmtTs(s.checked_at)}</span>
                    <Chip tone="neutral">{s.fetch_mode}</Chip>
                  </div>
                  <a
                    href={s.source_url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mt-0.5 block truncate font-mono text-[11px]"
                    title={s.source_url}
                  >
                    {s.source_url} <ExternalLink size={10} className="inline" aria-hidden />
                  </a>
                  {s.error && <div className="text-red">{s.error}</div>}
                </div>
                <blockquote className="quote text-[12px] leading-snug">{s.excerpt}</blockquote>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
