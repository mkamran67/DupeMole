import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useResults } from '../../../results/ResultsContext';
import { toUiGroup, type UiGroup } from '../../../results/adapter';
import { useDelete } from '../../../results/useDelete';
import { formatBytes } from '../../../lib/format';

interface ResultsViewProps {
  onNavigateToScan?: () => void;
}

export default function ResultsView({ onNavigateToScan }: ResultsViewProps) {
  const { latestScan, loaded } = useResults();
  const { deleting, deleteFiles, lastFailures, clearFailures } = useDelete();
  const navigate = useNavigate();

  const [selected, setSelected] = useState<Record<string, number[]>>({});
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletePermanently, setDeletePermanently] = useState(false);

  const groups: UiGroup[] = useMemo(
    () => latestScan?.groups.map(toUiGroup) ?? [],
    [latestScan]
  );

  const toggleSelect = (groupId: string, fileIndex: number) => {
    setSelected((prev) => {
      const current = prev[groupId] || [];
      const exists = current.includes(fileIndex);
      return {
        ...prev,
        [groupId]: exists
          ? current.filter((i) => i !== fileIndex)
          : [...current, fileIndex],
      };
    });
  };

  // Files are pre-sorted oldest-first by toUiGroup (index 0 = oldest = "original").
  // "Old Duplicates": keep the newest copy, delete the older ones.
  const selectOldDuplicates = (group: UiGroup) => {
    const keepIdx = group.files.length - 1;
    setSelected((prev) => ({
      ...prev,
      [group.id]: group.files.map((_, i) => i).filter((i) => i !== keepIdx),
    }));
  };

  // "New Duplicates": keep the oldest copy (= original), delete the newer ones.
  const selectNewDuplicates = (group: UiGroup) => {
    setSelected((prev) => ({
      ...prev,
      [group.id]: group.files.map((_, i) => i).filter((i) => i !== 0),
    }));
  };

  const clearGroupSelection = (groupId: string) => {
    setSelected((prev) => {
      const next = { ...prev };
      delete next[groupId];
      return next;
    });
  };

  const handleKeepOriginal = () => {
    // Select every duplicate (everything except the original) across all groups.
    setSelected(() => {
      const next: Record<string, number[]> = {};
      groups.forEach((group) => {
        next[group.id] = group.files.map((_, i) => i).filter((i) => i !== 0);
      });
      return next;
    });
  };

  const selectedCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    Object.entries(selected).forEach(([gid, indices]) => {
      counts[gid] = indices.length;
    });
    return counts;
  }, [selected]);

  const { totalSelectedFiles, totalSpaceBytes, selectedPaths } = useMemo(() => {
    let files = 0;
    let space = 0;
    const paths: string[] = [];
    Object.entries(selected).forEach(([groupId, indices]) => {
      const group = groups.find((g) => g.id === groupId);
      if (!group) return;
      files += indices.length;
      indices.forEach((idx) => {
        const f = group.files[idx];
        if (!f) return;
        space += f.sizeBytes;
        paths.push(f.path);
      });
    });
    return { totalSelectedFiles: files, totalSpaceBytes: space, selectedPaths: paths };
  }, [selected, groups]);

  const totalWastedBytes = latestScan?.wastedBytes ?? 0;

  const openDeleteModal = () => {
    if (totalSelectedFiles === 0) return;
    setDeletePermanently(false);
    clearFailures();
    setShowDeleteModal(true);
  };

  const handleDelete = async () => {
    const result = await deleteFiles(selectedPaths, deletePermanently);
    if (result.deleted.length > 0) {
      // Drop deleted indices from local selection state.
      const deletedSet = new Set(result.deleted);
      setSelected((prev) => {
        const next: Record<string, number[]> = {};
        Object.entries(prev).forEach(([gid, indices]) => {
          const group = groups.find((g) => g.id === gid);
          if (!group) return;
          const remaining = indices.filter((i) => {
            const f = group.files[i];
            return f ? !deletedSet.has(f.path) : false;
          });
          if (remaining.length > 0) next[gid] = remaining;
        });
        return next;
      });
    }
    if (result.failed.length === 0) {
      setShowDeleteModal(false);
      setDeletePermanently(false);
    }
  };

  // Empty / unloaded states
  if (!loaded) {
    return (
      <div className="min-h-full flex items-center justify-center">
        <p className="text-white/40 text-sm">Loading results...</p>
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

  return (
    <div className="min-h-full flex flex-col pb-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-white text-2xl font-bold tracking-tight">Results</h2>
          <p className="text-white/40 text-sm mt-1">
            {groups.length} group{groups.length !== 1 ? 's' : ''} found &bull; {formatBytes(totalWastedBytes)} can be reclaimed
          </p>
        </div>
      </div>

      {/* Duplicate Cards */}
      <div className="pr-1 -mr-1 space-y-4">
        {groups.map((group) => {
          const groupSelectedCount = selectedCounts[group.id] || 0;
          return (
            <div key={group.id} className="bg-[#3d2418] rounded-2xl p-5 border border-white/10 overflow-hidden">
              <div className="flex items-center justify-between mb-3">
                <span className="text-white/40 text-xs font-medium font-mono uppercase tracking-wider">
                  {group.type} &bull; {group.count} duplicates
                </span>
                <div className="flex items-center gap-2">
                  {group.type === 'Images' && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/app/compare/${group.id}`);
                      }}
                      className="text-white/50 text-xs font-semibold hover:text-white transition-colors duration-200 cursor-pointer flex items-center gap-1.5 whitespace-nowrap"
                    >
                      <i className="ri-eye-line"></i>
                      Compare
                    </button>
                  )}
                  <span className="text-[#c45c5c] text-xs font-semibold bg-[#c45c5c]/10 px-2.5 py-1 rounded-full">
                    {group.formattedWasted} wasted
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2 mb-4">
                <button
                  onClick={() => selectOldDuplicates(group)}
                  className="text-xs font-medium px-3 py-1.5 rounded-lg border border-white/10 text-white/60 hover:text-white hover:border-white/30 hover:bg-white/5 transition-all duration-200 cursor-pointer whitespace-nowrap flex items-center gap-1.5"
                >
                  <i className="ri-time-line"></i>
                  Select Old Duplicates
                </button>
                <button
                  onClick={() => selectNewDuplicates(group)}
                  className="text-xs font-medium px-3 py-1.5 rounded-lg border border-white/10 text-white/60 hover:text-white hover:border-white/30 hover:bg-white/5 transition-all duration-200 cursor-pointer whitespace-nowrap flex items-center gap-1.5"
                >
                  <i className="ri-calendar-check-line"></i>
                  Select New Duplicates
                </button>
                {groupSelectedCount > 0 && (
                  <button
                    onClick={() => clearGroupSelection(group.id)}
                    className="text-xs font-medium px-3 py-1.5 rounded-lg border border-white/10 text-white/40 hover:text-white/70 hover:border-white/20 transition-all duration-200 cursor-pointer whitespace-nowrap flex items-center gap-1.5 ml-auto"
                  >
                    <i className="ri-close-line"></i>
                    Clear ({groupSelectedCount})
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {group.files.map((file, idx) => {
                  const isSelected = (selected[group.id] || []).includes(idx);
                  const isOriginal = idx === 0;
                  return (
                    <div
                      key={file.path}
                      className={`rounded-xl border p-4 cursor-pointer transition-all duration-200 ${
                        isSelected
                          ? 'border-[#c45c5c] bg-[#c45c5c]/5'
                          : 'border-white/10 hover:border-white/25'
                      }`}
                      onClick={() => toggleSelect(group.id, idx)}
                    >
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <div className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center">
                            <i className={`${file.icon} text-white/40 text-lg`}></i>
                          </div>
                          {isOriginal && (
                            <span className="text-emerald-400 text-[10px] font-semibold uppercase tracking-wider">
                              Original
                            </span>
                          )}
                        </div>
                        <div
                          className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors duration-200 ${
                            isSelected ? 'border-[#c45c5c] bg-[#c45c5c]' : 'border-white/20'
                          }`}
                        >
                          {isSelected && <i className="ri-check-line text-white text-xs"></i>}
                        </div>
                      </div>

                      <p className="text-white text-xs font-medium truncate" title={file.name}>{file.name}</p>
                      <p className="text-white/40 text-xs mt-1">{file.formattedSize}</p>
                      <p className="text-white/25 text-[11px] mt-0.5 truncate font-mono" title={file.dir}>{file.dir}</p>
                      {file.formattedDate && (
                        <p className="text-white/25 text-[11px] mt-0.5 font-mono">{file.formattedDate}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Floating Action Bar */}
      <div className="mt-4 flex justify-center">
        <div className="inline-flex items-center gap-3 bg-[#3d2418] border border-white/10 rounded-full px-5 py-3">
          <span className="text-white/50 text-xs font-medium">
            {totalSelectedFiles > 0
              ? `${totalSelectedFiles} file${totalSelectedFiles > 1 ? 's' : ''} selected`
              : 'Select files to remove'}
          </span>
          <div className="w-px h-4 bg-white/10" />
          <button
            onClick={handleKeepOriginal}
            disabled={groups.length === 0}
            className="text-white/60 text-xs font-semibold hover:text-white transition-colors duration-200 whitespace-nowrap cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Keep Original
          </button>
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

      {/* Delete Confirmation Modal */}
      {showDeleteModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget && !deleting) setShowDeleteModal(false);
          }}
        >
          <div className="bg-[#2a1810] border border-white/10 rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl">
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
                <p className="text-white/40 text-[11px] uppercase tracking-wider font-semibold mb-1">Files to Delete</p>
                <p className="text-white text-xl font-bold">{totalSelectedFiles}</p>
              </div>
              <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                <p className="text-white/40 text-[11px] uppercase tracking-wider font-semibold mb-1">Space to Reclaim</p>
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
          </div>
        </div>
      )}
    </div>
  );
}
