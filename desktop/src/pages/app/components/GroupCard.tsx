import { memo, useMemo } from 'react';
import type { UiGroup } from '../../../results/adapter';
import FileCard from './FileCard';

interface GroupCardProps {
  group: UiGroup;
  selectedPaths: ReadonlySet<string>;
  selectedCount: number;
  visibleDuplicates?: number;
  onToggleFile: (groupId: string, path: string) => void;
  onSelectOld: (groupId: string) => void;
  onSelectNew: (groupId: string) => void;
  onClearGroup: (groupId: string) => void;
  onOpen: (path: string) => void;
  onReveal: (path: string) => void;
  onCompare: (groupId: string) => void;
  revealLabel: string;
}

function GroupCardImpl({
  group,
  selectedPaths,
  selectedCount,
  visibleDuplicates = 3,
  onToggleFile,
  onSelectOld,
  onSelectNew,
  onClearGroup,
  onOpen,
  onReveal,
  onCompare,
  revealLabel,
}: GroupCardProps) {
  const original = group.files[0];
  const duplicates = useMemo(() => group.files.slice(1), [group.files]);
  const shownDuplicates = duplicates.slice(0, visibleDuplicates);
  const hiddenCount = duplicates.length - shownDuplicates.length;

  // Per-file toggle adapter so children get a stable signature.
  const toggle = (path: string) => onToggleFile(group.id, path);

  return (
    <div className="bg-[#4d2e1d] rounded-2xl p-5 border border-white/20 shadow-lg shadow-black/30 overflow-hidden">
      <div className="flex items-center justify-between mb-3">
        <span className="text-white/40 text-xs font-medium font-mono uppercase tracking-wider">
          {group.formattedWasted} wasted &bull; {group.count} copies
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onCompare(group.id);
            }}
            className="text-white/50 text-xs font-semibold hover:text-white transition-colors duration-200 cursor-pointer flex items-center gap-1.5 whitespace-nowrap"
          >
            <i className="ri-eye-line"></i>
            Compare All
          </button>
          <span className="text-[#c45c5c] text-xs font-semibold bg-[#c45c5c]/10 px-2.5 py-1 rounded-full">
            {group.formattedWasted}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <button
          onClick={() => onSelectOld(group.id)}
          className="text-xs font-medium px-3 py-1.5 rounded-lg border border-white/10 text-white/60 hover:text-white hover:border-white/30 hover:bg-white/5 transition-all duration-200 cursor-pointer whitespace-nowrap flex items-center gap-1.5"
        >
          <i className="ri-time-line"></i>
          Select Old Duplicates
        </button>
        <button
          onClick={() => onSelectNew(group.id)}
          className="text-xs font-medium px-3 py-1.5 rounded-lg border border-white/10 text-white/60 hover:text-white hover:border-white/30 hover:bg-white/5 transition-all duration-200 cursor-pointer whitespace-nowrap flex items-center gap-1.5"
        >
          <i className="ri-calendar-check-line"></i>
          Select New Duplicates
        </button>
        {selectedCount > 0 && (
          <button
            onClick={() => onClearGroup(group.id)}
            className="text-xs font-medium px-3 py-1.5 rounded-lg border border-white/10 text-white/40 hover:text-white/70 hover:border-white/20 transition-all duration-200 cursor-pointer whitespace-nowrap flex items-center gap-1.5 ml-auto"
          >
            <i className="ri-close-line"></i>
            Clear ({selectedCount})
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,2fr)] gap-3 items-start">
        <div className="space-y-2">
          <p className="text-emerald-300/80 text-[10px] font-semibold uppercase tracking-wider px-1">
            Original
          </p>
          {original && (
            <FileCard
              file={original}
              isSelected={selectedPaths.has(original.path)}
              isOriginal
              onToggle={toggle}
              onOpen={onOpen}
              onReveal={onReveal}
              revealLabel={revealLabel}
            />
          )}
        </div>

        <div className="hidden md:flex items-stretch justify-center">
          <div className="w-px bg-white/10" />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <p className="text-[#c45c5c]/80 text-[10px] font-semibold uppercase tracking-wider">
              {duplicates.length === 1 ? 'Duplicate' : `Duplicates (${duplicates.length})`}
            </p>
            {hiddenCount > 0 && (
              <button
                onClick={() => onCompare(group.id)}
                className="text-white/50 text-[10px] font-semibold hover:text-white transition-colors duration-200 cursor-pointer"
              >
                +{hiddenCount} more &rarr;
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {shownDuplicates.map((file) => (
              <FileCard
                key={file.path}
                file={file}
                isSelected={selectedPaths.has(file.path)}
                isOriginal={false}
                onToggle={toggle}
                onOpen={onOpen}
                onReveal={onReveal}
                revealLabel={revealLabel}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const GroupCard = memo(GroupCardImpl);
export default GroupCard;
