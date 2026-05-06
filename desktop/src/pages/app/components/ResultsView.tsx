import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { duplicateGroups } from '@/mocks/scanResults';

interface FileItem {
  name: string;
  size: string;
  path: string;
  date: string;
  icon: string;
  imageUrl?: string;
}

interface DuplicateGroup {
  id: string;
  type: string;
  count: number;
  wastedSize: string;
  files: FileItem[];
}

function parseSizeToMB(sizeStr: string): number {
  const match = sizeStr.match(/^([\d.]+)\s*(MB|GB|KB|B)?$/i);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  const unit = (match[2] || 'B').toUpperCase();
  if (unit === 'GB') return val * 1024;
  if (unit === 'MB') return val;
  if (unit === 'KB') return val / 1024;
  return val / (1024 * 1024);
}

function formatSizeMB(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb < 1) return `${(mb * 1024).toFixed(1)} KB`;
  return `${mb.toFixed(1)} MB`;
}

export default function ResultsView() {
  const [selected, setSelected] = useState<Record<string, number[]>>({});
  const [deleting, setDeleting] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletePermanently, setDeletePermanently] = useState(false);
  const navigate = useNavigate();

  const toggleSelect = (groupId: string, fileIndex: number) => {
    setSelected((prev) => {
      const current = prev[groupId] || [];
      const exists = current.includes(fileIndex);
      return {
        ...prev,
        [groupId]: exists ? current.filter((i) => i !== fileIndex) : [...current, fileIndex],
      };
    });
  };

  const selectOldDuplicates = (group: DuplicateGroup) => {
    const sortedIndices = group.files
      .map((f, i) => ({ i, date: new Date(f.date).getTime() }))
      .sort((a, b) => a.date - b.date);
    // Keep the newest (last), select all older ones
    const toSelect = sortedIndices.slice(0, -1).map((x) => x.i);
    setSelected((prev) => ({
      ...prev,
      [group.id]: toSelect,
    }));
  };

  const selectNewDuplicates = (group: DuplicateGroup) => {
    const sortedIndices = group.files
      .map((f, i) => ({ i, date: new Date(f.date).getTime() }))
      .sort((a, b) => a.date - b.date);
    // Keep the oldest (first), select all newer ones
    const toSelect = sortedIndices.slice(1).map((x) => x.i);
    setSelected((prev) => ({
      ...prev,
      [group.id]: toSelect,
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
    setSelected((prev) => {
      const next: Record<string, number[]> = {};
      Object.keys(prev).forEach((groupId) => {
        const group = duplicateGroups.find((g) => g.id === groupId);
        if (group) {
          const keepIdx = 0;
          next[groupId] = group.files.map((_, i) => i).filter((i) => i !== keepIdx);
        }
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

  const { totalSelectedFiles, totalSpaceMB } = useMemo(() => {
    let files = 0;
    let space = 0;
    Object.entries(selected).forEach(([groupId, indices]) => {
      const group = duplicateGroups.find((g) => g.id === groupId);
      if (!group) return;
      files += indices.length;
      indices.forEach((idx) => {
        space += parseSizeToMB(group.files[idx].size);
      });
    });
    return { totalSelectedFiles: files, totalSpaceMB: space };
  }, [selected]);

  const openDeleteModal = () => {
    if (totalSelectedFiles === 0) return;
    setDeletePermanently(false);
    setShowDeleteModal(true);
  };

  const handleDelete = () => {
    setDeleting(true);
    setTimeout(() => {
      setSelected({});
      setDeleting(false);
      setShowDeleteModal(false);
      setDeletePermanently(false);
    }, 1500);
  };

  const totalWasted = duplicateGroups.reduce((sum, g) => sum + parseSizeToMB(g.wastedSize), 0);

  return (
    <div className="min-h-full flex flex-col pb-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-white text-2xl font-bold tracking-tight">Results</h2>
          <p className="text-white/40 text-sm mt-1">
            {duplicateGroups.length} groups found &bull; {formatSizeMB(totalWasted)} can be reclaimed
          </p>
        </div>
      </div>

      {/* Duplicate Cards */}
      <div className="pr-1 -mr-1 space-y-4">
        {duplicateGroups.map((group) => {
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
                    {group.wastedSize} wasted
                  </span>
                </div>
              </div>

              {/* Select Old / New buttons */}
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
                  return (
                    <div
                      key={idx}
                      className={`rounded-xl border p-4 cursor-pointer transition-all duration-200 ${
                        isSelected
                          ? 'border-[#c45c5c] bg-[#c45c5c]/5'
                          : 'border-white/10 hover:border-white/25'
                      }`}
                      onClick={() => toggleSelect(group.id, idx)}
                    >
                      <div className="flex items-center justify-between mb-3">
                        <div className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center">
                          <i className={`${file.icon} text-white/40 text-lg`}></i>
                        </div>
                        <div
                          className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors duration-200 ${
                            isSelected ? 'border-[#c45c5c] bg-[#c45c5c]' : 'border-white/20'
                          }`}
                        >
                          {isSelected && <i className="ri-check-line text-white text-xs"></i>}
                        </div>
                      </div>

                      <p className="text-white text-xs font-medium truncate">{file.name}</p>
                      <p className="text-white/40 text-xs mt-1">{file.size}</p>
                      <p className="text-white/25 text-[11px] mt-0.5 truncate font-mono">{file.path}</p>
                      <p className="text-white/25 text-[11px] mt-0.5 font-mono">{file.date}</p>
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
        <div className="inline-flex items-center gap-3 bg-[#3d2418] border border-white/10 rounded-pill px-5 py-3">
          <span className="text-white/50 text-xs font-medium">
            {totalSelectedFiles > 0
              ? `${totalSelectedFiles} file${totalSelectedFiles > 1 ? 's' : ''} selected`
              : 'Select files to remove'}
          </span>
          <div className="w-px h-4 bg-white/10" />
          <button
            onClick={handleKeepOriginal}
            disabled={totalSelectedFiles === 0}
            className="text-white/60 text-xs font-semibold hover:text-white transition-colors duration-200 whitespace-nowrap cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Keep Original
          </button>
          <button
            onClick={openDeleteModal}
            disabled={totalSelectedFiles === 0 || deleting}
            className={`text-sm font-semibold px-4 py-2 rounded-pill transition-colors duration-200 whitespace-nowrap cursor-pointer ${
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
            if (e.target === e.currentTarget) setShowDeleteModal(false);
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
                <p className="text-emerald-400 text-xl font-bold">{formatSizeMB(totalSpaceMB)}</p>
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

            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowDeleteModal(false)}
                className="flex-1 text-white/60 text-sm font-medium px-4 py-2.5 rounded-xl border border-white/10 hover:border-white/25 hover:text-white transition-all duration-200 cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className={`flex-1 text-sm font-semibold px-4 py-2.5 rounded-xl transition-colors duration-200 cursor-pointer whitespace-nowrap ${
                  deletePermanently
                    ? 'bg-[#c45c5c] text-white hover:bg-[#a84848]'
                    : 'bg-white text-[#1f1008] hover:bg-white/90'
                }`}
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