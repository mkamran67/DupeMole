import { memo } from 'react';
import type { UiFile } from '../../../results/adapter';
import FilePreview from './FilePreview';

interface PairRowProps {
  original: UiFile;
  duplicate: UiFile;
  isOriginalSelected: boolean;
  isDuplicateSelected: boolean;
  onToggle: (path: string, partnerPath: string) => void;
  onOpen: (path: string) => void;
  onReveal: (path: string) => void;
}

function FileSide({
  file,
  partnerPath,
  variant,
  isSelected,
  onToggle,
  onOpen,
  onReveal,
}: {
  file: UiFile;
  partnerPath: string;
  variant: 'original' | 'duplicate';
  isSelected: boolean;
  onToggle: (path: string, partnerPath: string) => void;
  onOpen: (path: string) => void;
  onReveal: (path: string) => void;
}) {
  return (
    <div
      onClick={() => onToggle(file.path, partnerPath)}
      className={`flex items-center gap-3 min-w-0 flex-1 p-2 rounded-md cursor-pointer transition-colors duration-150 border ${
        isSelected
          ? 'border-[#c45c5c]/60 bg-[#c45c5c]/10'
          : 'border-transparent hover:bg-white/[0.03]'
      }`}
    >
      <div className="w-20 h-20 shrink-0">
        <div className="w-20 h-20 rounded-md overflow-hidden border border-white/10 bg-black/30 [&>*]:!h-20 [&>*]:!rounded-md">
          <FilePreview file={file} onOpen={onOpen} />
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-0.5">
          <span
            className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
              variant === 'original'
                ? 'text-emerald-300 bg-emerald-500/10'
                : 'text-[#c45c5c] bg-[#c45c5c]/10'
            }`}
          >
            {variant === 'original' ? 'Old' : 'New'}
          </span>
          <span className="text-white/40 text-[11px] font-mono">{file.formattedSize}</span>
        </div>
        <p className="text-white text-sm font-medium truncate" title={file.name}>
          {file.name}
        </p>
        <p
          className="text-white/40 text-[11px] truncate font-mono mt-0.5"
          title={file.dir}
        >
          {file.dir}
        </p>
        {file.formattedDate && (
          <p className="text-white/35 text-[11px] mt-0.5 font-mono">{file.formattedDate}</p>
        )}
        <div className="flex items-center gap-1.5 mt-1.5">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onOpen(file.path);
            }}
            className="text-[10px] font-semibold px-2 py-0.5 rounded border border-white/15 text-white/60 hover:text-white hover:border-white/35 transition-colors duration-150 cursor-pointer"
            title="Open"
          >
            Open
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onReveal(file.path);
            }}
            className="text-[10px] font-semibold px-2 py-0.5 rounded border border-white/15 text-white/60 hover:text-white hover:border-white/35 transition-colors duration-150 cursor-pointer"
            title="Open Containing Folder"
          >
            Open Containing Folder
          </button>
        </div>
      </div>
      <div
        className={`shrink-0 self-start mt-1 w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors duration-150 ${
          isSelected ? 'border-[#c45c5c] bg-[#c45c5c]' : 'border-white/30 bg-black/40'
        }`}
        aria-label={isSelected ? 'Selected for deletion' : 'Not selected'}
      >
        {isSelected && <i className="ri-check-line text-white text-xs"></i>}
      </div>
    </div>
  );
}

function PairRowImpl({
  original,
  duplicate,
  isOriginalSelected,
  isDuplicateSelected,
  onToggle,
  onOpen,
  onReveal,
}: PairRowProps) {
  return (
    <div className="flex items-center gap-2 px-2 py-2 rounded-lg border bg-[#3a2316] border-white/10">
      <FileSide
        file={original}
        partnerPath={duplicate.path}
        variant="original"
        isSelected={isOriginalSelected}
        onToggle={onToggle}
        onOpen={onOpen}
        onReveal={onReveal}
      />
      <i className="ri-arrow-right-line text-white/25 shrink-0"></i>
      <FileSide
        file={duplicate}
        partnerPath={original.path}
        variant="duplicate"
        isSelected={isDuplicateSelected}
        onToggle={onToggle}
        onOpen={onOpen}
        onReveal={onReveal}
      />
    </div>
  );
}

const PairRow = memo(PairRowImpl);
export default PairRow;
