import { memo } from 'react';
import type { UiFile } from '../../../results/adapter';
import FilePreview from './FilePreview';
import LazyMount from './LazyMount';

interface FileCardProps {
  file: UiFile;
  isSelected: boolean;
  isOriginal: boolean;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  onReveal: (path: string) => void;
  revealLabel: string;
}

function FileCardImpl({
  file,
  isSelected,
  isOriginal,
  onToggle,
  onOpen,
  onReveal,
  revealLabel,
}: FileCardProps) {
  return (
    <div
      className={`rounded-xl border p-4 cursor-pointer transition-all duration-200 bg-[#2a1810] ${
        isSelected ? 'border-[#c45c5c] bg-[#c45c5c]/10' : 'border-white/20 hover:border-white/40'
      }`}
      onClick={() => onToggle(file.path)}
    >
      <div className="relative mb-3">
        <LazyMount
          placeholder={
            <div className="w-full h-32 rounded-lg bg-black/20 border border-white/10 flex items-center justify-center">
              <i className={`${file.icon} text-white/20 text-2xl`}></i>
            </div>
          }
        >
          <FilePreview file={file} onOpen={onOpen} />
        </LazyMount>
        {isOriginal && (
          <span className="absolute top-1.5 left-1.5 text-emerald-300 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30">
            Original
          </span>
        )}
        <div
          className={`absolute top-1.5 right-1.5 w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors duration-200 ${
            isSelected ? 'border-[#c45c5c] bg-[#c45c5c]' : 'border-white/30 bg-black/40'
          }`}
        >
          {isSelected && <i className="ri-check-line text-white text-xs"></i>}
        </div>
      </div>

      <p className="text-white text-xs font-medium truncate" title={file.name}>
        {file.name}
      </p>
      <p className="text-white/50 text-xs mt-1">{file.formattedSize}</p>
      <p className="text-white/35 text-[11px] mt-0.5 truncate font-mono" title={file.dir}>
        {file.dir}
      </p>
      {file.formattedDate && (
        <p className="text-white/35 text-[11px] mt-0.5 font-mono">{file.formattedDate}</p>
      )}
      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpen(file.path);
          }}
          className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-lg border border-white/15 text-white/70 hover:text-white hover:border-white/40 hover:bg-white/5 transition-all duration-200 cursor-pointer"
          title="Open with default app"
        >
          <i className="ri-external-link-line"></i>
          Open
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onReveal(file.path);
          }}
          className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-lg border border-white/15 text-white/70 hover:text-white hover:border-white/40 hover:bg-white/5 transition-all duration-200 cursor-pointer"
          title={revealLabel}
        >
          <i className="ri-folder-open-line"></i>
          {revealLabel}
        </button>
      </div>
    </div>
  );
}

const FileCard = memo(FileCardImpl);
export default FileCard;
