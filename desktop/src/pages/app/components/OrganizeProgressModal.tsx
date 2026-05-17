import { useOrganize } from '../../../organize/OrganizeContext';

export default function OrganizeProgressModal() {
  const { running, progress, phase, processed, total, currentPath, op, cancelOrganize } =
    useOrganize();

  if (!running) return null;

  const pct = Math.round(progress);
  const title =
    phase === 'walking'
      ? 'Discovering files'
      : phase === 'organizing'
        ? `${op === 'move' ? 'Moving' : 'Copying'} files`
        : 'Organizing';
  const counts =
    phase === 'walking'
      ? `${processed.toLocaleString()} found`
      : phase === 'organizing'
        ? `${processed.toLocaleString()} / ${total.toLocaleString()}`
        : '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-6 w-[480px] max-w-[90vw] shadow-2xl">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-9 h-9 rounded-lg bg-[#f5c542]/10 flex items-center justify-center">
            <i className="ri-folders-line text-[#f5c542] text-lg" />
          </div>
          <div>
            <div className="text-white text-sm font-semibold">{title}</div>
            <div className="text-white/40 text-xs">
              {op === 'move'
                ? 'Originals are being relocated into the target folder.'
                : 'Files are being copied into the target folder.'}
            </div>
          </div>
        </div>

        <div className="mt-5 mb-3 flex items-center justify-between">
          <span className="text-white/60 text-xs font-mono">{counts}</span>
          <span className="text-[#f5c542] text-sm font-semibold">{pct}%</span>
        </div>

        <div className="h-3 bg-white/10 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full bg-[#f5c542] transition-all duration-150"
            style={{ width: `${progress}%` }}
          />
        </div>

        <div
          className="mt-3 text-white/40 text-xs font-mono truncate"
          title={currentPath ?? ''}
        >
          {currentPath ?? (phase === 'walking' ? 'Walking directories…' : 'Preparing…')}
        </div>

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={() => void cancelOrganize()}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-[#c45c5c] text-white hover:bg-[#a84848] transition-colors duration-200 cursor-pointer"
          >
            <i className="ri-stop-circle-line" />
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
