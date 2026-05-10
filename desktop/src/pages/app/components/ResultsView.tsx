import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { invoke } from '@tauri-apps/api/core';
import { Virtuoso } from 'react-virtuoso';
import { useResults } from '../../../results/ResultsContext';
import { type BucketType, type UiGroup, type UiFile } from '../../../results/adapter';
import { useDelete } from '../../../results/useDelete';
import { dirname, formatBytes } from '../../../lib/format';
import PairRow from './PairRow';
import DeleteProgressModal from './DeleteProgressModal';

interface ResultsViewProps {
  onNavigateToScan?: () => void;
}

const CATEGORY_ORDER: BucketType[] = [
  'Images',
  'Videos',
  'PDFs',
  'Audio',
  'Docs',
  'Archives',
  'Other',
];

const CATEGORY_ICONS: Record<BucketType, string> = {
  Images: 'ri-image-line',
  Videos: 'ri-video-line',
  PDFs: 'ri-file-pdf-line',
  Audio: 'ri-music-line',
  Docs: 'ri-file-text-line',
  Archives: 'ri-archive-line',
  Other: 'ri-file-line',
};

interface Pair {
  groupId: string;
  original: UiFile;
  duplicate: UiFile;
}

function VirtualPairList({
  pairs,
  selectedPaths,
  onToggle,
  onOpen,
  onReveal,
}: {
  pairs: Pair[];
  selectedPaths: Set<string>;
  onToggle: (path: string, partnerPath: string) => void;
  onOpen: (path: string) => void;
  onReveal: (path: string) => void;
}) {
  return (
    <div className="flex-1 min-h-0">
      <Virtuoso
        data={pairs}
        computeItemKey={(_, p) => `${p.groupId}::${p.duplicate.path}`}
        increaseViewportBy={400}
        itemContent={(_, p) => (
          <div className="pb-2">
            <PairRow
              original={p.original}
              duplicate={p.duplicate}
              isOriginalSelected={selectedPaths.has(p.original.path)}
              isDuplicateSelected={selectedPaths.has(p.duplicate.path)}
              onToggle={onToggle}
              onOpen={onOpen}
              onReveal={onReveal}
            />
          </div>
        )}
        style={{ height: '100%' }}
      />
    </div>
  );
}

export default function ResultsView({ onNavigateToScan }: ResultsViewProps) {
  const { latestScan, loaded, uiGroups, uiGroupsReady } = useResults();
  const { deleting, progress: deleteProgress, deleteFiles, lastFailures, clearFailures } = useDelete();
  const navigate = useNavigate();

  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletePermanently, setDeletePermanently] = useState(false);
  const [activeCategory, setActiveCategory] = useState<BucketType | null>(null);

  const groups: UiGroup[] = uiGroups ?? [];

  const groupsByCategory = useMemo(() => {
    const map = new Map<BucketType, UiGroup[]>();
    for (const g of groups) {
      const arr = map.get(g.type);
      if (arr) arr.push(g);
      else map.set(g.type, [g]);
    }
    return map;
  }, [groups]);

  const categories = useMemo(
    () => CATEGORY_ORDER.filter((c) => groupsByCategory.has(c)),
    [groupsByCategory]
  );

  const categoryStats = useMemo(() => {
    const stats = new Map<BucketType, { duplicates: number; wastedBytes: number }>();
    for (const [type, gs] of groupsByCategory) {
      let dup = 0;
      let wasted = 0;
      for (const g of gs) {
        dup += Math.max(0, g.count - 1);
        wasted += g.wastedBytes;
      }
      stats.set(type, { duplicates: dup, wastedBytes: wasted });
    }
    return stats;
  }, [groupsByCategory]);

  // Reset active category when scan changes / pick the first available.
  useEffect(() => {
    if (categories.length === 0) {
      setActiveCategory(null);
    } else if (!activeCategory || !categories.includes(activeCategory)) {
      setActiveCategory(categories[0]);
    }
  }, [categories, activeCategory]);

  // Flatten the active category's groups into (original, duplicate) pair rows.
  const pairs: Pair[] = useMemo(() => {
    if (!activeCategory) return [];
    const out: Pair[] = [];
    const catGroups = groupsByCategory.get(activeCategory) ?? [];
    for (const g of catGroups) {
      const original = g.files[0];
      if (!original) continue;
      for (let i = 1; i < g.files.length; i++) {
        out.push({ groupId: g.id, original, duplicate: g.files[i] });
      }
    }
    return out;
  }, [activeCategory, groupsByCategory]);

  // Mutual exclusion within a pair: selecting one side deselects its partner
  // so we never queue both halves of a duplicate pair for deletion.
  const togglePath = useCallback((path: string, partnerPath: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        next.delete(partnerPath);
      }
      return next;
    });
  }, []);

  const openWithDefaultApp = useCallback(async (path: string) => {
    try {
      await invoke('plugin:opener|open_path', { path });
    } catch (err) {
      console.error('Failed to open file:', err);
    }
  }, []);

  const revealInFileManager = useCallback(async (path: string) => {
    // `reveal_item_in_dir` highlights the item in the OS file manager. On
    // Linux it goes through D-Bus FileManager1, which not every desktop
    // session exposes — in that case the call rejects. Fall back to opening
    // the parent directory so the user still lands at the file's location.
    try {
      await invoke('plugin:opener|reveal_item_in_dir', { path });
      return;
    } catch (revealErr) {
      console.warn('reveal_item_in_dir unavailable, opening parent dir', revealErr);
    }
    const parent = dirname(path);
    if (!parent) {
      console.error('cannot derive parent directory of', path);
      return;
    }
    try {
      await invoke('plugin:opener|open_path', { path: parent });
    } catch (err) {
      console.error('Failed to open parent directory:', err);
    }
  }, []);

  const selectAllOld = useCallback(() => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      for (const p of pairs) {
        next.add(p.original.path);
        next.delete(p.duplicate.path);
      }
      return next;
    });
  }, [pairs]);

  const selectAllNew = useCallback(() => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      for (const p of pairs) {
        next.add(p.duplicate.path);
        next.delete(p.original.path);
      }
      return next;
    });
  }, [pairs]);

  const clearAllInCategory = useCallback(() => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      for (const p of pairs) {
        next.delete(p.original.path);
        next.delete(p.duplicate.path);
      }
      return next;
    });
  }, [pairs]);

  const handleClearAll = () => setSelectedPaths(new Set());

  // O(N) once per scan — stable lookup so selection totals are O(|selected|).
  const sizeByPath = useMemo(() => {
    const map = new Map<string, number>();
    for (const g of groups) {
      for (const f of g.files) map.set(f.path, f.sizeBytes);
    }
    return map;
  }, [groups]);

  const { totalSelectedFiles, totalSpaceBytes, paths } = useMemo(() => {
    let space = 0;
    const list: string[] = [];
    for (const p of selectedPaths) {
      const sz = sizeByPath.get(p);
      if (sz === undefined) continue;
      space += sz;
      list.push(p);
    }
    return { totalSelectedFiles: list.length, totalSpaceBytes: space, paths: list };
  }, [sizeByPath, selectedPaths]);

  const totalWastedBytes = latestScan?.wastedBytes ?? 0;

  const openDeleteModal = () => {
    if (totalSelectedFiles === 0) return;
    setDeletePermanently(false);
    clearFailures();
    setShowDeleteModal(true);
  };

  const handleDelete = async () => {
    const result = await deleteFiles(paths, deletePermanently);
    if (result.deleted.length > 0) {
      const deletedSet = new Set(result.deleted);
      setSelectedPaths((prev) => {
        const next = new Set<string>();
        for (const p of prev) if (!deletedSet.has(p)) next.add(p);
        return next;
      });
    }
    if (result.failed.length === 0) {
      setShowDeleteModal(false);
      setDeletePermanently(false);
    }
  };

  if (!loaded) {
    return (
      <div className="min-h-full flex items-center justify-center">
        <p className="text-white/40 text-sm">Loading results...</p>
      </div>
    );
  }

  if (latestScan && !uiGroupsReady) {
    return (
      <div className="min-h-full flex flex-col items-center justify-center text-center">
        <div className="w-12 h-12 rounded-full bg-[#f5c542]/10 flex items-center justify-center mb-3">
          <i className="ri-loader-4-line animate-spin text-[#f5c542] text-2xl"></i>
        </div>
        <p className="text-white/70 text-sm font-medium">Preparing results…</p>
        <p className="text-white/40 text-xs mt-1">
          {latestScan.groups.length.toLocaleString()} groups to organize
        </p>
      </div>
    );
  }

  if (!latestScan || groups.length === 0) {
    return (
      <div className="min-h-full flex flex-col items-center justify-center text-center">
        <div className="w-14 h-14 rounded-full bg-[#f5c542]/10 flex items-center justify-center mb-4">
          <i className="ri-folders-line text-[#f5c542] text-2xl"></i>
        </div>
        <h2 className="text-white text-xl font-bold">No duplicates yet</h2>
        <p className="text-white/40 text-sm mt-2 max-w-sm">
          {latestScan
            ? 'All duplicates from your last scan have been resolved.'
            : 'Run a scan from the Scan tab to find duplicate files.'}
        </p>
        <button
          onClick={() => (onNavigateToScan ? onNavigateToScan() : navigate('/app'))}
          className="mt-5 inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#f5c542] text-[#2c1810] text-sm font-semibold hover:bg-[#e0b038] transition-colors duration-200 cursor-pointer"
        >
          <i className="ri-search-line"></i>
          Go to Scan
        </button>
      </div>
    );
  }

  const activeStats = activeCategory ? categoryStats.get(activeCategory) : undefined;

  return (
    <div className="h-full flex flex-col">
      <DeleteProgressModal progress={deleteProgress} />
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-white text-2xl font-bold tracking-tight">Results</h2>
          <p className="text-white/40 text-sm mt-1">
            {groups.length} group{groups.length !== 1 ? 's' : ''} across {categories.length}{' '}
            categor{categories.length !== 1 ? 'ies' : 'y'} &bull;{' '}
            {formatBytes(totalWastedBytes)} can be reclaimed
          </p>
        </div>
        {selectedPaths.size > 0 && (
          <button
            onClick={handleClearAll}
            className="text-white/50 hover:text-white text-xs font-semibold transition-colors duration-200 cursor-pointer"
          >
            Clear all ({selectedPaths.size})
          </button>
        )}
      </div>

      {/* Category tabs */}
      <div className="flex items-center gap-1.5 mb-4 overflow-x-auto pb-1">
        {categories.map((cat) => {
          const stats = categoryStats.get(cat);
          const isActive = cat === activeCategory;
          return (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={`shrink-0 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors duration-150 cursor-pointer whitespace-nowrap border ${
                isActive
                  ? 'bg-[#f5c542] text-[#2c1810] border-[#f5c542]'
                  : 'bg-transparent text-white/60 border-white/10 hover:text-white hover:border-white/30'
              }`}
            >
              <i className={CATEGORY_ICONS[cat]}></i>
              {cat}
              <span
                className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                  isActive ? 'bg-[#2c1810]/20 text-[#2c1810]' : 'bg-white/5 text-white/50'
                }`}
              >
                {stats?.duplicates ?? 0}
              </span>
            </button>
          );
        })}
      </div>

      {/* Category summary bar */}
      {activeCategory && activeStats && (
        <div className="flex items-center justify-between mb-3 px-1">
          <p className="text-white/50 text-xs">
            {activeStats.duplicates} duplicate{activeStats.duplicates !== 1 ? 's' : ''} &bull;{' '}
            {formatBytes(activeStats.wastedBytes)} reclaimable
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={selectAllOld}
              className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10 transition-colors duration-150 cursor-pointer"
            >
              <i className="ri-time-line"></i>
              Select All Old
            </button>
            <button
              onClick={selectAllNew}
              className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded border border-[#c45c5c]/40 text-[#e88a8a] hover:bg-[#c45c5c]/10 transition-colors duration-150 cursor-pointer"
            >
              <i className="ri-calendar-check-line"></i>
              Select All New
            </button>
            <button
              onClick={clearAllInCategory}
              className="text-white/40 text-xs font-semibold hover:text-white/70 transition-colors duration-150 cursor-pointer ml-1"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      <VirtualPairList
        pairs={pairs}
        selectedPaths={selectedPaths}
        onToggle={togglePath}
        onOpen={openWithDefaultApp}
        onReveal={revealInFileManager}
      />


      {/* Sticky action bar */}
      <div className="mt-6 flex justify-center sticky bottom-3 z-30">
        <div className="inline-flex items-center gap-3 bg-[#3d2418] border border-white/15 rounded-full px-5 py-3 shadow-xl shadow-black/40 backdrop-blur">
          <span className="text-white/60 text-xs font-medium">
            {totalSelectedFiles > 0
              ? `${totalSelectedFiles} file${totalSelectedFiles > 1 ? 's' : ''} selected`
              : 'Select files to remove'}
          </span>
          <div className="w-px h-4 bg-white/10" />
          <button
            onClick={openDeleteModal}
            disabled={totalSelectedFiles === 0 || deleting}
            className={`text-sm font-semibold px-4 py-2 rounded-full transition-colors duration-200 whitespace-nowrap cursor-pointer ${
              totalSelectedFiles > 0 && !deleting
                ? 'bg-[#c45c5c] text-white hover:bg-[#b05050]'
                : 'bg-white/10 text-white/30 cursor-not-allowed'
            }`}
          >
            {deleting ? (
              <span className="flex items-center gap-1.5">
                <i className="ri-loader-4-line animate-spin"></i>
                Deleting...
              </span>
            ) : (
              'Delete Duplicates'
            )}
          </button>
        </div>
      </div>

      {showDeleteModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget && !deleting) setShowDeleteModal(false);
          }}
        >
          <div className="bg-[#2a1810] border border-white/10 rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl">
            {deleting ? (
              <div className="flex flex-col items-center text-center py-8">
                <div className="w-16 h-16 rounded-full bg-[#c45c5c]/15 flex items-center justify-center mb-4">
                  <i className="ri-loader-4-line animate-spin text-[#c45c5c] text-3xl"></i>
                </div>
                <h3 className="text-white text-lg font-bold">
                  {deletePermanently ? 'Deleting permanently…' : 'Moving to trash…'}
                </h3>
                <p className="text-white/50 text-sm mt-1">
                  {totalSelectedFiles.toLocaleString()} file{totalSelectedFiles !== 1 ? 's' : ''} ·{' '}
                  {formatBytes(totalSpaceBytes)}
                </p>
                <p className="text-white/30 text-xs mt-4 max-w-xs">
                  This can take a few seconds for large batches. Please don't close the app.
                </p>
              </div>
            ) : (
              <>
            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 rounded-full bg-[#c45c5c]/15 flex items-center justify-center">
                <i className="ri-delete-bin-line text-[#c45c5c] text-lg"></i>
              </div>
              <div>
                <h3 className="text-white font-bold text-base">Delete Duplicates</h3>
                <p className="text-white/40 text-xs">Review before confirming</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-5">
              <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                <p className="text-white/40 text-[11px] uppercase tracking-wider font-semibold mb-1">
                  Files to Delete
                </p>
                <p className="text-white text-xl font-bold">{totalSelectedFiles}</p>
              </div>
              <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                <p className="text-white/40 text-[11px] uppercase tracking-wider font-semibold mb-1">
                  Space to Reclaim
                </p>
                <p className="text-emerald-400 text-xl font-bold">{formatBytes(totalSpaceBytes)}</p>
              </div>
            </div>

            <div className="bg-white/5 rounded-xl p-4 border border-white/5 mb-5">
              <label className="flex items-start gap-3 cursor-pointer">
                <div className="relative flex items-center justify-center mt-0.5">
                  <input
                    type="checkbox"
                    checked={deletePermanently}
                    onChange={(e) => setDeletePermanently(e.target.checked)}
                    className="peer sr-only"
                  />
                  <div className="w-5 h-5 rounded border-2 border-white/30 peer-checked:border-[#c45c5c] peer-checked:bg-[#c45c5c] transition-colors duration-200 flex items-center justify-center">
                    {deletePermanently && <i className="ri-check-line text-white text-xs"></i>}
                  </div>
                </div>
                <div className="flex-1">
                  <p className="text-white text-sm font-medium">Delete permanently</p>
                  <p className="text-white/40 text-xs mt-0.5">By default, files are moved to trash</p>
                </div>
              </label>
            </div>

            {deletePermanently && (
              <div className="flex items-start gap-2 mb-5 bg-[#c45c5c]/10 border border-[#c45c5c]/20 rounded-xl p-3">
                <i className="ri-error-warning-line text-[#c45c5c] text-base mt-0.5"></i>
                <div>
                  <p className="text-[#c45c5c] text-sm font-semibold">This action is permanent and irreversible.</p>
                  <p className="text-[#c45c5c]/70 text-xs mt-0.5">Deleted files cannot be recovered from trash.</p>
                </div>
              </div>
            )}

            {lastFailures.length > 0 && (
              <div className="mb-5 bg-[#c45c5c]/10 border border-[#c45c5c]/20 rounded-xl p-3">
                <div className="flex items-start gap-2 mb-2">
                  <i className="ri-error-warning-line text-[#c45c5c] text-base mt-0.5"></i>
                  <p className="text-[#c45c5c] text-sm font-semibold">
                    {lastFailures.length} file{lastFailures.length !== 1 ? 's' : ''} could not be deleted
                  </p>
                </div>
                <ul className="text-[#c45c5c]/80 text-[11px] font-mono space-y-1 max-h-24 overflow-y-auto">
                  {lastFailures.slice(0, 5).map((f) => (
                    <li key={f.path} className="truncate" title={`${f.path}: ${f.error}`}>
                      {f.path.split(/[\\/]/).pop()}: {f.error}
                    </li>
                  ))}
                  {lastFailures.length > 5 && (
                    <li className="text-[#c45c5c]/60">+{lastFailures.length - 5} more...</li>
                  )}
                </ul>
              </div>
            )}

            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowDeleteModal(false)}
                disabled={deleting}
                className="flex-1 text-white/60 text-sm font-medium px-4 py-2.5 rounded-xl border border-white/10 hover:border-white/25 hover:text-white transition-all duration-200 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {lastFailures.length > 0 ? 'Close' : 'Cancel'}
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting || totalSelectedFiles === 0}
                className={`flex-1 text-sm font-semibold px-4 py-2.5 rounded-xl transition-colors duration-200 cursor-pointer whitespace-nowrap ${
                  deletePermanently
                    ? 'bg-[#c45c5c] text-white hover:bg-[#a84848]'
                    : 'bg-white text-[#1f1008] hover:bg-white/90'
                } disabled:opacity-40 disabled:cursor-not-allowed`}
              >
                {deleting ? (
                  <span className="flex items-center justify-center gap-1.5">
                    <i className="ri-loader-4-line animate-spin"></i>
                    Deleting...
                  </span>
                ) : deletePermanently ? (
                  'Delete Forever'
                ) : (
                  'Move to Trash'
                )}
              </button>
            </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
