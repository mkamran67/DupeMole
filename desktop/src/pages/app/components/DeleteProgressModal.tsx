import type { DeleteProgress } from '../../../results/useDelete';

interface Props {
  progress: DeleteProgress | null;
}

export default function DeleteProgressModal({ progress }: Props) {
  if (!progress) return null;
  const { processed, total, currentPath, permanent } = progress;
  const pct = total > 0 ? Math.min(100, (processed / total) * 100) : 0;
  const title = permanent ? 'Deleting files permanently' : 'Moving files to Trash';
  const subtitle = permanent
    ? 'These files cannot be recovered.'
    : 'You can restore them from the Trash if needed.';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-6 w-[440px] max-w-[90vw] shadow-2xl">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-9 h-9 rounded-lg bg-[#f5c542]/10 flex items-center justify-center">
            <i className={`${permanent ? 'ri-delete-bin-2-line' : 'ri-delete-bin-line'} text-[#f5c542] text-lg`} />
          </div>
          <div>
            <div className="text-white text-sm font-semibold">{title}</div>
            <div className="text-white/40 text-xs">{subtitle}</div>
          </div>
        </div>

        <div className="mt-5 mb-3 flex items-center justify-between">
          <span className="text-white/60 text-xs font-mono">
            {processed.toLocaleString()} / {total.toLocaleString()}
          </span>
          <span className="text-[#f5c542] text-xs font-semibold">{Math.round(pct)}%</span>
        </div>

        <div className="h-2 bg-white/10 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full bg-[#f5c542] transition-all duration-150"
            style={{ width: `${pct}%` }}
          />
        </div>

        <div className="mt-3 text-white/40 text-xs font-mono truncate" title={currentPath ?? ''}>
          {currentPath ?? (processed === 0 ? 'Starting…' : 'Finishing…')}
        </div>
      </div>
    </div>
  );
}
