import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { ExternalLink, ScanSearch } from 'lucide-react';
import { canEdit, useAsset, useRole } from '../api/hooks';
import type { AssetVersionOut, EdgeOut, ScanOut } from '../api/types';
import { useTopBar } from '../components/layout/useShell';
import { PageHeader, Section } from '../components/layout/Page';
import { GatedButton } from '../components/access/GatedButton';
import { Chip } from '../components/ui/Chip';
import { SourceBadge } from '../components/artifacts/SourceBadge';
import { HighlightedText, type HighlightSpan } from '../components/ui/HighlightedText';
import { DataTable } from '../components/ui/DataTable';
import { KeyValue } from '../components/ui/KeyValue';
import { LoadingState } from '../components/ui/LoadingState';
import { ErrorState } from '../components/ui/ErrorState';
import { fmtNumber, fmtTs, shortHash } from '../lib/format';
import { artifactTypeLabel, edgeStatusTone, polarityTone, roleLabel } from '../lib/vocab';
import { ScanStats } from '../components/artifacts/ScanStats';
import { RunScanControl } from '../components/artifacts/RunScanControl';

export function ArtifactDetailPage() {
  const { code = '' } = useParams();
  const role = useRole();
  const asset = useAsset(code);
  const [lastScan, setLastScan] = useState<ScanOut | null>(null);

  useTopBar([{ label: 'Artifacts', to: '/artifacts' }, { label: code }]);

  const spans = useMemo<HighlightSpan[]>(
    () =>
      (asset.data?.edges ?? []).map((e) => ({
        offset: e.span_offset,
        length: e.evidence_span.length,
        label: `${e.rule_code}@v${e.rule_version}`,
        verified: true,
        title: `${e.rule_code} v${e.rule_version} · ${e.polarity} · ${e.status}`,
      })),
    [asset.data],
  );

  const edgeColumns = useMemo<ColumnDef<EdgeOut, unknown>[]>(
    () => [
      {
        header: 'Rule',
        accessorKey: 'rule_code',
        cell: (c) => (
          <Link to={`/rules/${encodeURIComponent(c.row.original.rule_code)}`} className="font-mono font-semibold">
            {c.row.original.rule_code}@v{c.row.original.rule_version}
          </Link>
        ),
      },
      { header: 'Polarity', accessorKey: 'polarity', cell: (c) => <Chip tone={polarityTone(c.row.original.polarity)}>{c.row.original.polarity}</Chip> },
      { header: 'Evidence span', accessorKey: 'evidence_span', meta: { wrap: true }, cell: (c) => <span className="mark-span block max-w-[460px] text-[12px] leading-snug">{c.row.original.evidence_span}</span> },
      { header: 'Offset', accessorKey: 'span_offset', meta: { align: 'right', mono: true }, size: 70 },
      { header: 'Detection', accessorKey: 'detection', cell: (c) => <span className="font-mono text-[12px]">{c.row.original.detection}{c.row.original.confidence !== null ? ` · ${c.row.original.confidence.toFixed(2)}` : ''}</span> },
      { header: 'Matcher', accessorKey: 'matcher', meta: { mono: true } },
      {
        header: 'Status',
        accessorKey: 'status',
        cell: (c) => (
          <Chip tone={edgeStatusTone(c.row.original.status)} title={c.row.original.status === 'superseded' ? 'The artifact changed and the quoted span is gone' : undefined}>
            {c.row.original.status}
          </Chip>
        ),
      },
      { header: 'Confirmed by', accessorKey: 'confirmed_by', cell: (c) => c.row.original.confirmed_by ?? <span className="text-ink-3">—</span> },
    ],
    [],
  );

  const versionColumns = useMemo<ColumnDef<AssetVersionOut, unknown>[]>(
    () => [
      { header: 'Content hash', accessorKey: 'content_hash', meta: { mono: true }, cell: (c) => <span title={c.row.original.content_hash}>{shortHash(c.row.original.content_hash, 20)}</span> },
      { header: 'Fetched at', accessorKey: 'fetched_at', meta: { mono: true }, cell: (c) => fmtTs(c.row.original.fetched_at) },
      { header: 'Mode', accessorKey: 'fetch_mode', cell: (c) => <Chip tone="neutral">{c.row.original.fetch_mode}</Chip> },
      { header: 'Length', accessorKey: 'length', meta: { align: 'right', mono: true }, cell: (c) => fmtNumber(c.row.original.length) },
    ],
    [],
  );

  if (asset.isLoading) return <LoadingState className="p-6" rows={5} />;
  if (asset.error && !asset.data) {
    return (
      <div className="p-6">
        <ErrorState error={asset.error} title={`Could not load artifact ${code}`} retry={() => void asset.refetch()} />
      </div>
    );
  }
  if (!asset.data) return null;
  const a = asset.data;

  return (
    <div>
      <PageHeader
        eyebrow={artifactTypeLabel(a.type)}
        title={a.name}
        description={
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-mono text-[12px] text-slate">{a.code}</span>
            <SourceBadge isSynthetic={a.is_synthetic} type={a.type} url={a.url} />
            <span>source system <span className="font-mono">{a.source_system}</span></span>
            <span title={a.owner_role}>owner {roleLabel(a.owner_role)}</span>
            {a.url && (
              <a href={a.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-mono text-[12px]">
                {a.url} <ExternalLink size={11} aria-hidden />
              </a>
            )}
          </div>
        }
        actions={
          canEdit(role) ? (
            <RunScanControl onScanned={setLastScan} />
          ) : (
            <GatedButton action="start_scans" className="btn btn-outline">
              <ScanSearch size={13} aria-hidden /> Run scan
            </GatedButton>
          )
        }
      />

      {lastScan && (
        <Section>
          <ScanStats scan={lastScan} />
        </Section>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Section title="Artifact text" right={`${a.edges.length} edge${a.edges.length === 1 ? '' : 's'} highlighted · hover a span for rule, version and polarity`}>
          <div className="card p-4 text-[13.5px] leading-[1.7]">
            {a.content_text ? (
              <HighlightedText text={a.content_text} spans={spans} tagUnverified={false} />
            ) : (
              <span className="text-ink-3">No text captured for this artifact.</span>
            )}
          </div>
        </Section>
        <Section band title="Latest version" className="xl:border-l xl:border-hairline">
          <KeyValue
            rows={[
              { key: 'Latest hash', value: a.latest_hash ?? '—' },
              { key: 'Fetched at', value: fmtTs(a.latest_fetched_at) },
              { key: 'Length', value: fmtNumber(a.content_text.length) },
              { key: 'Versions', value: String(a.versions.length) },
              { key: 'Edges', value: String(a.edge_count) },
              { key: 'Provenance', value: a.is_synthetic ? 'synthetic (labeled)' : a.type === 'workflow_prompt' ? 'repo prompt (real code in this repository)' : 'real public page' },
            ]}
          />
        </Section>
      </div>

      <Section title="Edges — which rule versions this artifact encodes">
        <DataTable columns={edgeColumns} data={a.edges} getRowId={(e) => e.id} emptyTitle="No edges" emptyHint="A scan proposes edges; a reviewer confirms them." />
      </Section>

      <Section band title="Versions — every fetched snapshot, by content hash">
        <DataTable columns={versionColumns} data={[...a.versions].reverse()} getRowId={(v) => v.id} emptyTitle="No versions" className="bg-surface" />
      </Section>
    </div>
  );
}
