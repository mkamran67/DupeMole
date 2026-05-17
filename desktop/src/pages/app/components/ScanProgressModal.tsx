import { useScan, formatEta, type ScanPhase } from '../../../scan/ScanContext';

function phaseTitle(phase: ScanPhase | null): string {
  switch (phase) {
    case 'discovery':
      return 'Discovering files';
    case 'hashing':
      return 'Hashing';
    case 'verifying':
      return 'Verifying duplicates';
    case 'finalizing':
      return 'Reading metadata';
    default:
      return 'Scanning';
  }
}

function fallbackPath(phase: ScanPhase | null): string {
  switch (phase) {
    case 'discovery':
      return 'Walking directories…';
    case 'hashing':
      return 'Hashing files…';
    case 'verifying':
      return 'Verifying duplicate hashes…';
    default:
      return 'Preparing…';
  }
}

export default function ScanProgressModal() {
  const {
    scanning,
    progress,
    phase,
    phaseProcessed,
    phaseTotal,
    currentPath,
    etaSeconds,
    cancelScan,
  } = useScan();

  if (!scanning) return null;

  const pct = Math.round(progress);
  const counts =
    phase === 'discovery'
      ? `${phaseProcessed.toLocaleString()} found`
      : phase === 'hashing'
        ? `${phaseProcessed.toLocaleString()} / ${phaseTotal.toLocaleString()}`
        : '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-6 w-[480px] max-w-[90vw] shadow-2xl">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-9 h-9 rounded-lg bg-[#f5c542]/10 flex items-center justify-center">
            <i className="ri-search-line text-[#f5c542] text-lg" />
          </div>
          <div>
            <div className="text-white text-sm font-semibold">{phaseTitle(phase)}</div>
            <div className="text-white/40 text-xs">
              BLAKE3 content hashing · partial hash for files &gt; 64 MB
            </div>
          </div>
        </div>

        <div className="mt-5 mb-3 flex items-center justify-between">
          <span className="text-white/60 text-xs font-mono">{counts}</span>
          <span className="text-[#f5c542] text-sm font-semibold">
            {pct}%
            {etaSeconds !== null && (
              <span className="text-white/50 font-normal ml-2">
                · ~{formatEta(etaSeconds)} left
              </span>
            )}
          </span>
        </div>

        <div className="h-3 bg-white/10 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full bg-[#f5c542] transition-all duration-150"
            style={{ width: `${progress}%` }}
          />
        </div>

        <div className="mt-3 text-white/40 text-xs font-mono truncate" title={currentPath ?? ''}>
          {currentPath ?? fallbackPath(phase)}
        </div>

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={() => void cancelScan()}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all duration-200 cursor-pointer bg-[#c45c5c] text-white hover:bg-[#a84848]"
          >
            <i className="ri-stop-circle-line" />
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
