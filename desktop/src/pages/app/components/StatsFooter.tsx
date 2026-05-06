import { useStats } from '../../../stats/StatsContext';
import { formatBytes } from '../../../lib/format';

export default function StatsFooter() {
  const { stats } = useStats();
  const { totalBytesFreed, totalFilesDeleted, totalScansRun } = stats;

  if (totalScansRun === 0 && totalFilesDeleted === 0) {
    return (
      <footer className="mt-6 border-t border-amber-900/30 pt-3 text-center text-xs text-amber-200/40">
        Run your first scan to start tracking lifetime stats
      </footer>
    );
  }

  return (
    <footer className="mt-6 border-t border-amber-900/30 pt-3 text-center text-xs text-amber-200/60">
      All time:{' '}
      <span className="font-semibold text-amber-100">{formatBytes(totalBytesFreed)}</span> freed
      {' · '}
      <span className="font-semibold text-amber-100">{totalFilesDeleted.toLocaleString()}</span>{' '}
      duplicate{totalFilesDeleted === 1 ? '' : 's'} removed
      {' · '}
      <span className="font-semibold text-amber-100">{totalScansRun.toLocaleString()}</span>{' '}
      scan{totalScansRun === 1 ? '' : 's'} run
    </footer>
  );
}
