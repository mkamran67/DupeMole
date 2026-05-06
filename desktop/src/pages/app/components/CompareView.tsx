import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { duplicateGroups } from '@/mocks/scanResults';

export default function CompareView() {
  const { groupId } = useParams();
  const navigate = useNavigate();
  const group = duplicateGroups.find((g) => g.id === groupId);

  const [selected, setSelected] = useState<Set<number>>(new Set());

  if (!group) {
    return (
      <div className="h-full flex flex-col items-center justify-center">
        <i className="ri-error-warning-line text-white/20 text-4xl mb-3"></i>
        <p className="text-white/40 text-sm">Group not found</p>
        <button
          onClick={() => navigate('/app')}
          className="mt-4 text-white/60 text-xs font-semibold hover:text-white transition-colors duration-200 cursor-pointer"
        >
          Back to Results
        </button>
      </div>
    );
  }

  const original = group.files[0];
  const duplicates = group.files.slice(1);
  const originalCount = 1;
  const duplicateCount = duplicates.length;

  const toggleSelect = (idx: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  };

  const selectAllNewer = () => {
    const allNewer = new Set(duplicates.map((_, i) => i + 1));
    setSelected(allNewer);
  };

  const selectAllOlder = () => {
    const allOlder = new Set([0]);
    setSelected(allOlder);
  };

  const clearAll = () => setSelected(new Set());

  const handleKeepSelected = () => {
    clearAll();
  };

  const handleDeleteSelected = () => {
    clearAll();
  };

  return (
    <div className="min-h-full flex flex-col pb-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-white text-2xl font-bold tracking-tight">Compare Images</h2>
          <p className="text-white/40 text-sm mt-1">
            {group.files.length} copies of <span className="text-white/60">{original.name}</span>
          </p>
        </div>
        <button
          onClick={() => navigate('/app')}
          className="flex items-center gap-2 text-white/40 hover:text-white text-xs font-medium transition-colors duration-200 cursor-pointer"
        >
          <i className="ri-arrow-left-line"></i>
          Back to Results
        </button>
      </div>

      {/* Bulk Select Bar */}
      <div className="flex items-center gap-3 mb-5">
        <button
          onClick={selectAllOlder}
          className="inline-flex items-center gap-1.5 text-white/60 hover:text-white text-xs font-semibold bg-white/5 hover:bg-white/10 border border-white/10 rounded-full px-3 py-1.5 transition-all duration-200 cursor-pointer"
        >
          <i className="ri-star-line"></i>
          Select All Original ({originalCount})
        </button>
        <button
          onClick={selectAllNewer}
          className="inline-flex items-center gap-1.5 text-white/60 hover:text-white text-xs font-semibold bg-white/5 hover:bg-white/10 border border-white/10 rounded-full px-3 py-1.5 transition-all duration-200 cursor-pointer"
        >
          <i className="ri-file-copy-line"></i>
          Select All Duplicates ({duplicateCount})
        </button>
        <button
          onClick={clearAll}
          className="inline-flex items-center gap-1.5 text-white/40 hover:text-white/60 text-xs font-medium hover:bg-white/5 rounded-full px-3 py-1.5 transition-all duration-200 cursor-pointer"
        >
          <i className="ri-close-circle-line"></i>
          Clear Selection
        </button>
        <div className="flex-1" />
        <span className="text-white/40 text-xs">
          {selected.size} selected
        </span>
      </div>

      {/* Compare Grid */}
      <div className="pr-1 -mr-1">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Original Card */}
          <div
            onClick={() => toggleSelect(0)}
            className={`relative bg-[#3d2418] rounded-2xl border overflow-hidden flex flex-col cursor-pointer transition-all duration-200 ${
              selected.has(0)
                ? 'border-emerald-500/60 ring-2 ring-emerald-500/20'
                : 'border-white/10 hover:border-white/25'
            }`}
          >
            {/* Selection indicator */}
            <div
              className={`absolute top-3 right-3 z-10 w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all duration-200 ${
                selected.has(0)
                  ? 'border-emerald-500 bg-emerald-500'
                  : 'border-white/20 bg-black/20'
              }`}
            >
              {selected.has(0) && <i className="ri-check-line text-white text-xs"></i>}
            </div>

            <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full bg-emerald-500/20 flex items-center justify-center">
                  <i className="ri-star-fill text-emerald-400 text-xs"></i>
                </div>
                <span className="text-white text-sm font-semibold">Original</span>
              </div>
              <span className="text-white/30 text-xs font-mono">{original.path}{original.name}</span>
            </div>
            <div className="flex-1 p-5 flex items-center justify-center bg-[#2a160e]">
              {original.imageUrl ? (
                <img
                  src={original.imageUrl}
                  alt={original.name}
                  className="max-w-full max-h-[60vh] object-contain rounded-xl"
                />
              ) : (
                <div className="text-center">
                  <i className="ri-image-line text-white/20 text-4xl"></i>
                  <p className="text-white/30 text-xs mt-2">No preview available</p>
                </div>
              )}
            </div>
            <div className="px-5 py-3 border-t border-white/10 flex items-center gap-4 text-white/40 text-xs">
              <span>{original.size}</span>
              <span>&bull;</span>
              <span>{original.date}</span>
            </div>
          </div>

          {/* Duplicate Cards */}
          {duplicates.map((dup, idx) => {
            const realIdx = idx + 1;
            const isSelected = selected.has(realIdx);
            return (
              <div
                key={realIdx}
                onClick={() => toggleSelect(realIdx)}
                className={`relative bg-[#3d2418] rounded-2xl border overflow-hidden flex flex-col cursor-pointer transition-all duration-200 ${
                  isSelected
                    ? 'border-[#c45c5c]/60 ring-2 ring-[#c45c5c]/20'
                    : 'border-white/10 hover:border-white/25'
                }`}
              >
                {/* Selection indicator */}
                <div
                  className={`absolute top-3 right-3 z-10 w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all duration-200 ${
                    isSelected
                      ? 'border-[#c45c5c] bg-[#c45c5c]'
                      : 'border-white/20 bg-black/20'
                  }`}
                >
                  {isSelected && <i className="ri-check-line text-white text-xs"></i>}
                </div>

                <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-[#c45c5c]/20 flex items-center justify-center">
                      <i className="ri-file-copy-line text-[#c45c5c] text-xs"></i>
                    </div>
                    <span className="text-white text-sm font-semibold">Duplicate #{idx + 1}</span>
                  </div>
                  <span className="text-white/30 text-xs font-mono">{dup.path}{dup.name}</span>
                </div>
                <div className="flex-1 p-5 flex items-center justify-center bg-[#2a160e]">
                  {dup.imageUrl ? (
                    <img
                      src={dup.imageUrl}
                      alt={dup.name}
                      className="max-w-full max-h-[60vh] object-contain rounded-xl"
                    />
                  ) : (
                    <div className="text-center">
                      <i className="ri-image-line text-white/20 text-4xl"></i>
                      <p className="text-white/30 text-xs mt-2">No preview available</p>
                    </div>
                  )}
                </div>
                <div className="px-5 py-3 border-t border-white/10 flex items-center gap-4 text-white/40 text-xs">
                  <span>{dup.size}</span>
                  <span>&bull;</span>
                  <span>{dup.date}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Bottom Action Bar */}
      {selected.size > 0 && (
        <div className="mt-4 flex justify-center">
          <div className="inline-flex items-center gap-3 bg-[#3d2418] border border-white/10 rounded-full px-5 py-3">
            <span className="text-white/50 text-xs font-medium">
              {selected.size} file{selected.size > 1 ? 's' : ''} selected
            </span>
            <div className="w-px h-4 bg-white/10" />
            <button
              onClick={handleKeepSelected}
              className="text-white/60 text-xs font-semibold hover:text-white transition-colors duration-200 whitespace-nowrap cursor-pointer"
            >
              Keep Selected
            </button>
            <button
              onClick={handleDeleteSelected}
              className="text-sm font-semibold px-4 py-2 rounded-full transition-colors duration-200 whitespace-nowrap cursor-pointer bg-[#c45c5c] text-white hover:bg-[#b05050]"
            >
              Delete Selected
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
