import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { ScanSearch, Upload } from 'lucide-react';
import { canEdit, useAssets, useHealthDeep, useIngestFormats, useIngestTranscripts, useRole, useTranscripts } from '../api/hooks';
import type { AssetOut, IngestResultOut, ScanOut, TranscriptOut } from '../api/types';
import { useTopBar } from '../components/layout/useShell';
import { PageHeader, Section, Field } from '../components/layout/Page';
import { GatedButton } from '../components/access/GatedButton';
import { DataTable } from '../components/ui/DataTable';
import { Chip } from '../components/ui/Chip';
import { SourceBadge, TranscriptBadge } from '../components/artifacts/SourceBadge';
import { Drawer } from '../components/ui/Drawer';
import { KeyValue } from '../components/ui/KeyValue';
import { ErrorState } from '../components/ui/ErrorState';
import { LoadingState } from '../components/ui/LoadingState';
import { useToast } from '../components/ui/useToast';
import { RunScanControl } from '../components/artifacts/RunScanControl';
import { HOLDOUT_TOOLTIP } from '../components/runs/CorpusChip';
import { ScanStats } from '../components/artifacts/ScanStats';
import { fmtDuration, fmtTs, shortHash } from '../lib/format';
import { artifactTypeLabel, roleLabel } from '../lib/vocab';
import { str } from '../lib/evidence';

function IngestDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const formats = useIngestFormats();
  const ingest = useIngestTranscripts();
  const { toast } = useToast();
  const [format, setFormat] = useState('attention-snowflake');
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<IngestResultOut | null>(null);
  const selected = formats.data?.[format];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!file || ingest.isPending) return;
    // Drop the previous upload's result so it never sits next to this upload's error.
    setResult(null);
    ingest.mutate(
      { file, format },
      {
        onSuccess: (r) => {
          setResult(r);
          toast({ title: `${r.created} transcript${r.created === 1 ? '' : 's'} ingested · ${r.skipped_existing} skipped`, detail: `batch ${shortHash(r.batch_hash, 12)} · redacted MBI ${r.redacted.medicare_number}, SSN ${r.redacted.ssn}, DOB ${r.redacted.dob}`, tone: 'green' });
        },
      },
    );
  };

  return (
    <Drawer open={open} onClose={onClose} title="Ingest transcripts" subtitle="POST /ingest/transcripts — multipart field “file”; PII is redacted before storage; ingested transcripts carry no ground truth">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Export format" htmlFor="ing-format">
          <select id="ing-format" className="input" value={format} onChange={(e) => setFormat(e.target.value)}>
            {Object.keys(formats.data ?? { [format]: null }).map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="File"
          htmlFor="ing-file"
          hint={
            selected
              ? `CSV only, UTF-8, header row first, max 20 MB. Header: ${Object.keys(selected.columns).join(',')}`
              : 'CSV only, UTF-8, header row first, max 20 MB.'
          }
        >
          <input
            id="ing-file"
            type="file"
            accept=".csv,text/csv"
            className="input h-auto py-1"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setResult(null);
              ingest.reset();
            }}
            required
          />
        </Field>
        {formats.isLoading && <LoadingState rows={2} />}
        {formats.error ? <ErrorState error={formats.error} title="Could not load /ingest/formats" /> : null}
        {selected && (
          <div className="card p-3">
            <div className="eyebrow mb-1">Documented assumption — column mapping</div>
            <p className="text-[12px] text-ink-2">{selected.description}</p>
            <KeyValue className="mt-2" rows={Object.entries(selected.columns).map(([k, v]) => ({ key: k, value: v, mono: false }))} />
            <div className="mt-2 text-[12px] text-ink-2">
              <span className="font-semibold text-slate">Redaction:</span> {selected.redaction}
            </div>
          </div>
        )}
        {ingest.error ? <ErrorState error={ingest.error} title="Ingest refused" /> : null}
        {result && (
          <div className="border border-green p-3">
            <div className="eyebrow mb-1">Result</div>
            <KeyValue
              rows={[
                { key: 'Format', value: result.format },
                { key: 'Created', value: String(result.created) },
                { key: 'Skipped (existing)', value: String(result.skipped_existing) },
                { key: 'Redacted', value: `Medicare numbers ${result.redacted.medicare_number} · SSN ${result.redacted.ssn} · DOB ${result.redacted.dob}` },
                { key: 'Batch hash', value: result.batch_hash },
                { key: 'Note', value: result.note, mono: false },
              ]}
            />
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
          <button type="submit" className="btn" disabled={!file || ingest.isPending}>
            <Upload size={13} aria-hidden /> {ingest.isPending ? 'Uploading…' : 'Ingest'}
          </button>
        </div>
      </form>
    </Drawer>
  );
}

export function ArtifactsPage() {
  useTopBar([{ label: 'Artifacts' }]);
  const navigate = useNavigate();
  const role = useRole();
  const assets = useAssets();
  // The API's default corpus leaves the held-out calls out; health reports how many there are.
  const transcripts = useTranscripts(500, 0);
  const health = useHealthDeep(true);
  const holdoutCount = health.data?.holdout_transcripts;
  const [ingestOpen, setIngestOpen] = useState(false);
  const [lastScan, setLastScan] = useState<ScanOut | null>(null);

  const columns = useMemo<ColumnDef<AssetOut, unknown>[]>(
    () => [
      {
        header: 'Artifact',
        accessorKey: 'name',
        meta: { wrap: true },
        cell: (c) => (
          <span className="cell-primary max-w-[460px]">
            <span className="font-semibold text-ink">{c.row.original.name}</span>
            <span className="cell-sub">
              <span className="font-medium">{artifactTypeLabel(c.row.original.type)}</span>
              <span className="font-mono text-[11px] text-ink-3"> · {c.row.original.code}</span>
            </span>
          </span>
        ),
      },
      {
        header: 'Source system',
        accessorKey: 'source_system',
        meta: { mono: true, wrap: true },
        // "scripting-platform(synthetic)" → may break before the "(synthetic)" suffix
        cell: (c) => {
          const v = c.row.original.source_system;
          const i = v.indexOf('(');
          return (
            <span className="text-[12px] text-ink-2">
              {i > 0 ? (
                <>
                  {v.slice(0, i)}
                  <wbr />
                  {v.slice(i)}
                </>
              ) : (
                v
              )}
            </span>
          );
        },
      },
      {
        id: 'provenance',
        header: 'Provenance',
        accessorFn: (r) => (r.is_synthetic ? 'synthetic' : r.type === 'workflow_prompt' ? 'repo' : 'real'),
        cell: (c) => <SourceBadge isSynthetic={c.row.original.is_synthetic} type={c.row.original.type} url={c.row.original.url} stacked />,
      },
      { header: 'Owner', accessorKey: 'owner_role', cell: (c) => <span className="text-ink-2" title={c.row.original.owner_role}>{roleLabel(c.row.original.owner_role)}</span> },
      {
        header: 'Latest version',
        accessorKey: 'latest_fetched_at',
        meta: { mono: true, wrap: true },
        cell: (c) => (
          <span className="cell-primary">
            <span className="text-[12px] text-ink" title={c.row.original.latest_hash ?? ''}>
              {shortHash(c.row.original.latest_hash)}
            </span>
            <span className="cell-sub text-[11px]">{fmtTs(c.row.original.latest_fetched_at)}</span>
          </span>
        ),
      },
      { header: 'Edges', accessorKey: 'edge_count', meta: { align: 'right', mono: true }, size: 70 },
      { id: 'versions', header: 'Versions', accessorFn: (r) => r.versions.length, meta: { align: 'right', mono: true }, size: 90 },
    ],
    [],
  );

  const transcriptColumns = useMemo<ColumnDef<TranscriptOut, unknown>[]>(
    () => [
      { header: 'Code', accessorKey: 'code', meta: { mono: true }, cell: (c) => <span className="font-semibold text-navy">{c.row.original.code}</span>, size: 130 },
      { id: 'provenance', header: 'Provenance', accessorFn: (t) => (t.synthetic ? 'synthetic' : 'ingested'), cell: (c) => <TranscriptBadge synthetic={c.row.original.synthetic} labels={c.row.original.labels} /> },
      { header: 'Product line', accessorKey: 'product_line', cell: (c) => <Chip tone="slate">{c.row.original.product_line}</Chip>, size: 110 },
      { header: 'Duration', accessorKey: 'duration_seconds', meta: { align: 'right', mono: true }, cell: (c) => fmtDuration(c.row.original.duration_seconds * 1000), size: 90 },
      {
        id: 'labels',
        header: 'Labels',
        accessorFn: (t) => Object.keys(t.labels).length,
        meta: { wrap: true },
        cell: (c) => {
          const l = c.row.original.labels;
          if (!c.row.original.synthetic) {
            return (
              <span className="text-[12px] text-ink-2">
                {typeof l.format === 'string' ? `${l.format} · ` : ''}agent {str(l.agent)} · started {fmtTs(typeof l.started_at === 'string' ? l.started_at : null)} · ground truth: <span className="text-amber-ink">none</span>
              </span>
            );
          }
          return (
            <span className="text-[12px] text-ink-2">
              scenario {str(l.scenario)} · {str(l.carrier)} · disclaimer {l.disclaimer_delivered === false ? 'missing' : `${str(l.disclaimer_seconds)}s`} · benefits {str(l.benefits_started_seconds)}s · SOA +{str(l.appointment_hours_after_soa)}h
              {Array.isArray(l.superlatives) && l.superlatives.length ? ' · superlative' : ''}
            </span>
          );
        },
      },
    ],
    [],
  );

  const real = assets.data?.filter((a) => !a.is_synthetic && a.type === 'web_page').length ?? 0;
  const repo = assets.data?.filter((a) => !a.is_synthetic && a.type === 'workflow_prompt').length ?? 0;
  const synthetic = assets.data?.filter((a) => a.is_synthetic).length ?? 0;
  const ingestedCount = transcripts.data?.filter((t) => !t.synthetic).length ?? 0;

  return (
    <div>
      <PageHeader
        eyebrow="Artifact inventory"
        title="Artifacts"
        description={`Everything that encodes a rule — ${real} real public pages (crawled, hashed, attributed), ${repo} repo prompts and ${synthetic} labeled synthetic internals.`}
        actions={
          canEdit(role) ? (
            <>
              <RunScanControl onScanned={setLastScan} withKeyInput />
              <button type="button" className="btn btn-outline" onClick={() => setIngestOpen(true)}>
                <Upload size={13} aria-hidden /> Ingest transcripts
              </button>
            </>
          ) : (
            <>
              <GatedButton action="start_scans" className="btn btn-outline">
                <ScanSearch size={13} aria-hidden /> Run scan
              </GatedButton>
              <GatedButton action="ingest_transcripts" className="btn btn-outline">
                <Upload size={13} aria-hidden /> Ingest transcripts
              </GatedButton>
            </>
          )
        }
      />
      {lastScan && (
        <Section>
          <ScanStats scan={lastScan} />
        </Section>
      )}
      <Section>
        <DataTable columns={columns} data={assets.data} isLoading={assets.isLoading} error={assets.error} retry={() => void assets.refetch()} getRowId={(r) => r.code} onRowClick={(r) => navigate(`/artifacts/${encodeURIComponent(r.code)}`)} initialSort={[{ id: 'edge_count', desc: true }]} emptyTitle="No artifacts" emptyHint="Run a scan to crawl the frozen snapshots and seed the synthetic internals." caption="Artifact inventory" />
      </Section>
      <Section band title="Transcript corpus" right={`${transcripts.data?.length ?? 0} transcripts · ${ingestedCount} ingested (redacted, no ground truth)`}>
        {typeof holdoutCount === 'number' && holdoutCount > 0 && (
          <p className="mb-2 text-[12px] text-ink-2" title={HOLDOUT_TOOLTIP}>
            + {holdoutCount} held-out calls kept out of view (used only to check prompt overfitting)
          </p>
        )}
        <DataTable columns={transcriptColumns} data={transcripts.data} isLoading={transcripts.isLoading} error={transcripts.error} retry={() => void transcripts.refetch()} getRowId={(t) => t.code} initialSort={[{ id: 'provenance', desc: false }]} maxHeight="52vh" emptyTitle="No transcripts" className="bg-surface" caption="Transcript corpus" />
      </Section>
      <IngestDrawer open={ingestOpen} onClose={() => setIngestOpen(false)} />
    </div>
  );
}
