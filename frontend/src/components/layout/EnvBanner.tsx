import { TriangleAlert } from 'lucide-react';

/** Persistent thin amber-outlined strip: the environment label from /meta, notice on one line with ellipsis. */
export function EnvBanner({ label, notice }: { label: string; notice?: string }) {
  return (
    <div
      role="note"
      className="flex h-6 min-w-0 items-center gap-2 border-b border-amber/30 bg-amber/8 px-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-amber-ink sm:px-6"
      title={notice ? `${label} — ${notice}` : label}
    >
      <TriangleAlert size={12} className="shrink-0" aria-hidden />
      <span className="shrink-0">{label}</span>
      {notice && <span className="min-w-0 truncate font-medium normal-case tracking-normal text-ink-2">— {notice}</span>}
    </div>
  );
}
