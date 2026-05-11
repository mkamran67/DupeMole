interface DirectoryRowProps {
  name: string;
  files: number;
  progress: number;
  scanned: boolean;
  scanning: boolean;
  onRemove: () => void;
}

export default function DirectoryRow({
  name,
  files,
  progress,
  scanned,
  scanning,
  onRemove,
}: DirectoryRowProps) {
  return (
    <div className="flex items-center gap-4 p-4 rounded-xl bg-white/5 border border-white/5">
      <div className="w-10 h-10 rounded-lg bg-[#f5c542]/10 flex items-center justify-center shrink-0">
        <i className="ri-folder-line text-[#f5c542] text-base"></i>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-white text-sm font-medium font-mono truncate">{name}</span>
          <span className="text-white/40 text-xs font-mono">{files.toLocaleString()} files</span>
        </div>
        <div className="h-2 bg-white/10 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full bg-[#f5c542] transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {scanned && (
          <div
            className="w-6 h-6 rounded-full bg-[#f5c542]/20 flex items-center justify-center"
            aria-label="Scanned"
          >
            <i className="ri-check-line text-[#f5c542] text-xs"></i>
          </div>
        )}
        {!scanning && (
          <button
            onClick={onRemove}
            aria-label={`Remove ${name}`}
            className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/30 hover:text-white/60 transition-colors duration-200 cursor-pointer"
          >
            <i className="ri-close-line text-sm"></i>
          </button>
        )}
      </div>
    </div>
  );
}
