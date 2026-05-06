import { useMemo, useState, useRef, useEffect } from 'react';

interface FilterType {
  id: string;
  icon: string;
  label: string;
  formats: string;
}

const defaultFilterTypes: FilterType[] = [
  { id: 'images', icon: 'ri-image-line', label: 'Images', formats: 'JPG, PNG, WebP, RAW, HEIC, BMP, TIFF, GIF, SVG, AVIF' },
  { id: 'videos', icon: 'ri-video-line', label: 'Videos', formats: 'MP4, MOV, MKV, AVI, WEBM, FLV, WMV, M4V' },
  { id: 'pdfs', icon: 'ri-file-pdf-line', label: 'PDFs', formats: 'PDF' },
  { id: 'audio', icon: 'ri-music-line', label: 'Audio', formats: 'MP3, FLAC, WAV, AAC, OGG, M4A, WMA, AIFF' },
  { id: 'docs', icon: 'ri-file-text-line', label: 'Docs', formats: 'DOCX, TXT, RTF, ODT, DOC, XLSX, PPTX, CSV' },
  { id: 'archives', icon: 'ri-archive-line', label: 'Archives', formats: 'ZIP, RAR, 7Z, TAR, GZ, BZ2, XZ' },
];

const sizePresets = ['Any', '< 1 MB', '1 - 10 MB', '10 - 100 MB', '> 100 MB'];
const datePresets = ['Any time', 'Today', 'This week', 'This month', 'This year'];

export default function FiltersView() {
  const [filterTypes, setFilterTypes] = useState<FilterType[]>(defaultFilterTypes);
  const [activeTypes, setActiveTypes] = useState<string[]>(['images', 'videos', 'pdfs']);
  const [customExt, setCustomExt] = useState('');
  const [sizePreset, setSizePreset] = useState('Any');
  const [datePreset, setDatePreset] = useState('Any time');
  const [ignoreHidden, setIgnoreHidden] = useState(true);
  const [includeSubdirs, setIncludeSubdirs] = useState(true);

  // Extension editing modal
  const [editingType, setEditingType] = useState<FilterType | null>(null);
  const [editFormats, setEditFormats] = useState<string[]>([]);
  const [newEditExt, setNewEditExt] = useState('');
  const modalRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  // Ignore lists
  const [ignoredFolders, setIgnoredFolders] = useState<string[]>(['/Users/Trash', '/Users/Library/Caches']);
  const [newFolder, setNewFolder] = useState('');
  const [ignoredTypes, setIgnoredTypes] = useState<string[]>(['TMP', 'DS_Store']);
  const [newType, setNewType] = useState('');

  const toggleType = (id: string) => {
    setActiveTypes((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  };

  const openEditModal = (e: React.MouseEvent, ft: FilterType) => {
    e.stopPropagation();
    setEditingType(ft);
    setEditFormats(
      ft.formats
        .split(',')
        .map((f) => f.trim().toUpperCase())
        .filter(Boolean)
    );
    setNewEditExt('');
    // Focus input after modal opens
    setTimeout(() => editInputRef.current?.focus(), 50);
  };

  const closeEditModal = () => {
    setEditingType(null);
    setEditFormats([]);
    setNewEditExt('');
  };

  const saveEditModal = () => {
    if (!editingType) return;
    setFilterTypes((prev) =>
      prev.map((ft) =>
        ft.id === editingType.id
          ? { ...ft, formats: editFormats.join(', ') }
          : ft
      )
    );
    closeEditModal();
  };

  const addEditExt = () => {
    if (!newEditExt.trim()) return;
    const clean = newEditExt.trim().replace(/^\./, '').toUpperCase();
    if (!clean || editFormats.includes(clean)) {
      setNewEditExt('');
      return;
    }
    setEditFormats((prev) => [...prev, clean]);
    setNewEditExt('');
    setTimeout(() => editInputRef.current?.focus(), 50);
  };

  const removeEditExt = (ext: string) => {
    setEditFormats((prev) => prev.filter((e) => e !== ext));
  };

  // Close modal on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        closeEditModal();
      }
    };
    if (editingType) {
      document.addEventListener('mousedown', handleClick);
      document.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Escape') closeEditModal();
      });
    }
    return () => {
      document.removeEventListener('mousedown', handleClick);
    };
  }, [editingType]);

  const selectedExtensions = useMemo(() => {
    const exts: string[] = [];
    activeTypes.forEach((id) => {
      const ft = filterTypes.find((t) => t.id === id);
      if (ft) {
        ft.formats.split(',').forEach((f) => exts.push(f.trim()));
      }
    });
    if (customExt.trim()) {
      customExt
        .split(',')
        .map((s) => s.trim().replace(/^\./, '').toUpperCase())
        .filter(Boolean)
        .forEach((e) => exts.push(e));
    }
    return [...new Set(exts)];
  }, [activeTypes, customExt, filterTypes]);

  const addIgnoredFolder = () => {
    if (!newFolder.trim()) return;
    setIgnoredFolders((prev) => [...prev, newFolder.trim()]);
    setNewFolder('');
  };

  const removeIgnoredFolder = (idx: number) => {
    setIgnoredFolders((prev) => prev.filter((_, i) => i !== idx));
  };

  const addIgnoredType = () => {
    if (!newType.trim()) return;
    const clean = newType.trim().replace(/^\./, '').toUpperCase();
    setIgnoredTypes((prev) => [...prev, clean]);
    setNewType('');
  };

  const removeIgnoredType = (idx: number) => {
    setIgnoredTypes((prev) => prev.filter((_, i) => i !== idx));
  };

  return (
    <div className="min-h-full flex flex-col relative pb-8">
      {/* Header */}
      <div className="mb-6">
        <h2 className="text-white text-2xl font-bold tracking-tight">Filters</h2>
        <p className="text-white/40 text-sm mt-1">Customize which files to include in the scan</p>
      </div>

      <div className="pr-1 -mr-1 space-y-5">
        {/* File Types */}
        <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-5">
          <p className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-4">File Types</p>
          <div className="grid grid-cols-3 md:grid-cols-6 gap-2.5">
            {filterTypes.map((ft) => {
              const active = activeTypes.includes(ft.id);
              return (
                <button
                  key={ft.id}
                  onClick={() => toggleType(ft.id)}
                  className={`flex flex-col items-center gap-2 p-3 rounded-xl border transition-all duration-200 cursor-pointer relative group ${
                    active
                      ? 'border-[#f5c542] bg-[#f5c542]/10'
                      : 'border-white/10 hover:border-white/20'
                  }`}
                >
                  <div
                    onClick={(e) => openEditModal(e, ft)}
                    className="absolute top-1.5 right-1.5 w-5 h-5 rounded-md flex items-center justify-center text-white/20 hover:text-[#f5c542] hover:bg-white/5 transition-colors duration-200 cursor-pointer z-10"
                    title={`Edit ${ft.label} extensions`}
                  >
                    <i className="ri-pencil-line text-[10px]"></i>
                  </div>
                  <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors duration-200 ${
                      active ? 'bg-[#f5c542]' : 'bg-white/5'
                    }`}
                  >
                    <i className={`${ft.icon} text-sm ${active ? 'text-[#2c1810]' : 'text-white/40'}`}></i>
                  </div>
                  <span className={`text-xs font-medium ${active ? 'text-[#f5c542]' : 'text-white/50'}`}>
                    {ft.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Selected Extensions */}
        <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-5">
          <p className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-3">Selected Extensions</p>
          {selectedExtensions.length === 0 ? (
            <p className="text-white/25 text-xs">No file types selected. Add at least one category or a custom extension.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {selectedExtensions.map((ext) => (
                <span
                  key={ext}
                  className="text-xs font-medium px-2.5 py-1 rounded-full border border-[#f5c542]/30 bg-[#f5c542]/10 text-[#f5c542]"
                >
                  .{ext.toLowerCase()}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Ignore Section */}
        <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-5 space-y-6">
          <p className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-1">Ignore</p>

          {/* Ignored Folders */}
          <div>
            <p className="text-white text-sm font-medium mb-2">Ignored Folders</p>
            <div className="flex gap-2 mb-3">
              <input
                type="text"
                placeholder="node_modules, .git, temp, build ..."
                value={newFolder}
                onChange={(e) => setNewFolder(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addIgnoredFolder()}
                className="flex-1 text-sm px-4 py-2.5 rounded-lg border border-white/10 bg-white/5 text-white placeholder-white/30 focus:outline-none focus:border-[#f5c542]/40 transition-colors duration-200"
              />
              <button
                onClick={addIgnoredFolder}
                disabled={!newFolder.trim()}
                className="px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-white/60 text-sm font-medium hover:bg-white/10 hover:text-white transition-colors duration-200 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed whitespace-nowrap"
              >
                Add
              </button>
            </div>
            {ignoredFolders.length === 0 ? (
              <p className="text-white/25 text-xs">No folders ignored yet. Add names like node_modules or .git to skip them anywhere.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {ignoredFolders.map((folder, idx) => (
                  <span
                    key={idx}
                    className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-full border border-white/10 bg-white/5 text-white/60"
                  >
                    <i className="ri-folder-line text-white/30"></i>
                    {folder}
                    <button
                      onClick={() => removeIgnoredFolder(idx)}
                      className="w-4 h-4 rounded-full flex items-center justify-center text-white/30 hover:text-[#c45c5c] transition-colors duration-200 cursor-pointer ml-0.5"
                    >
                      <i className="ri-close-line text-[10px]"></i>
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-white/5" />

          {/* Ignored File Types */}
          <div>
            <p className="text-white text-sm font-medium mb-2">Ignored File Types</p>
            <div className="flex gap-2 mb-3">
              <input
                type="text"
                placeholder=".tmp, .bak, .old ..."
                value={newType}
                onChange={(e) => setNewType(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addIgnoredType()}
                className="flex-1 text-sm px-4 py-2.5 rounded-lg border border-white/10 bg-white/5 text-white placeholder-white/30 focus:outline-none focus:border-[#f5c542]/40 transition-colors duration-200"
              />
              <button
                onClick={addIgnoredType}
                disabled={!newType.trim()}
                className="px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-white/60 text-sm font-medium hover:bg-white/10 hover:text-white transition-colors duration-200 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed whitespace-nowrap"
              >
                Add
              </button>
            </div>
            {ignoredTypes.length === 0 ? (
              <p className="text-white/25 text-xs">No file types ignored yet.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {ignoredTypes.map((ext, idx) => (
                  <span
                    key={idx}
                    className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-full border border-white/10 bg-white/5 text-white/60"
                  >
                    <i className="ri-file-forbid-line text-white/30"></i>
                    .{ext.toLowerCase()}
                    <button
                      onClick={() => removeIgnoredType(idx)}
                      className="w-4 h-4 rounded-full flex items-center justify-center text-white/30 hover:text-[#c45c5c] transition-colors duration-200 cursor-pointer ml-0.5"
                    >
                      <i className="ri-close-line text-[10px]"></i>
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Custom Extensions */}
        <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-5">
          <p className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-3">Custom Extensions</p>
          <div className="relative">
            <input
              type="text"
              placeholder=".custom, .ext, .log ..."
              value={customExt}
              onChange={(e) => setCustomExt(e.target.value)}
              className="w-full text-sm px-4 py-3 rounded-lg border border-white/10 bg-white/5 text-white placeholder-white/30 focus:outline-none focus:border-[#f5c542]/40 transition-colors duration-200"
            />
            {customExt && (
              <button
                onClick={() => setCustomExt('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-white/10 flex items-center justify-center text-white/40 hover:text-white/60 transition-colors duration-200 cursor-pointer"
              >
                <i className="ri-close-line text-xs"></i>
              </button>
            )}
          </div>
          <p className="text-white/25 text-[11px] mt-2">Comma-separated list of custom file extensions to include in the scan.</p>
        </div>

        {/* Size & Date */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-5">
            <p className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-3">File Size</p>
            <div className="flex flex-wrap gap-2">
              {sizePresets.map((preset) => (
                <button
                  key={preset}
                  onClick={() => setSizePreset(preset)}
                  className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-all duration-200 cursor-pointer whitespace-nowrap ${
                    sizePreset === preset
                      ? 'border-[#f5c542] bg-[#f5c542]/10 text-[#f5c542]'
                      : 'border-white/10 text-white/50 hover:border-white/20'
                  }`}
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>
          <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-5">
            <p className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-3">Date Modified</p>
            <div className="flex flex-wrap gap-2">
              {datePresets.map((preset) => (
                <button
                  key={preset}
                  onClick={() => setDatePreset(preset)}
                  className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-all duration-200 cursor-pointer whitespace-nowrap ${
                    datePreset === preset
                      ? 'border-[#f5c542] bg-[#f5c542]/10 text-[#f5c542]'
                      : 'border-white/10 text-white/50 hover:border-white/20'
                  }`}
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Toggles */}
        <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-white text-sm font-medium">Ignore Hidden Files</p>
              <p className="text-white/30 text-xs mt-0.5">Skip files starting with a dot</p>
            </div>
            <button
              onClick={() => setIgnoreHidden(!ignoreHidden)}
              className={`relative w-12 h-7 rounded-full transition-colors duration-300 cursor-pointer ${
                ignoreHidden ? 'bg-[#f5c542]' : 'bg-white/10'
              }`}
            >
              <div
                className={`absolute top-1 w-5 h-5 rounded-full bg-white shadow-md transition-transform duration-300 ${
                  ignoreHidden ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
          <div className="border-t border-white/5" />
          <div className="flex items-center justify-between">
            <div>
              <p className="text-white text-sm font-medium">Include Subdirectories</p>
              <p className="text-white/30 text-xs mt-0.5">Scan nested folders recursively</p>
            </div>
            <button
              onClick={() => setIncludeSubdirs(!includeSubdirs)}
              className={`relative w-12 h-7 rounded-full transition-colors duration-300 cursor-pointer ${
                includeSubdirs ? 'bg-[#f5c542]' : 'bg-white/10'
              }`}
            >
              <div
                className={`absolute top-1 w-5 h-5 rounded-full bg-white shadow-md transition-transform duration-300 ${
                  includeSubdirs ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
        </div>
      </div>

      {/* Extension Edit Modal */}
      {editingType && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div
            ref={modalRef}
            className="bg-[#3d2418] rounded-2xl border border-white/10 w-full max-w-md shadow-2xl"
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between p-5 border-b border-white/10">
              <div>
                <h3 className="text-white text-lg font-semibold">
                  Edit {editingType.label} Extensions
                </h3>
                <p className="text-white/40 text-xs mt-0.5">
                  Add or remove known file extensions
                </p>
              </div>
              <button
                onClick={closeEditModal}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-white/30 hover:text-white/60 hover:bg-white/5 transition-colors duration-200 cursor-pointer"
              >
                <i className="ri-close-line text-lg"></i>
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 space-y-4">
              {/* Add new extension */}
              <div className="flex gap-2">
                <input
                  ref={editInputRef}
                  type="text"
                  placeholder=".newext"
                  value={newEditExt}
                  onChange={(e) => setNewEditExt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addEditExt();
                    }
                  }}
                  className="flex-1 text-sm px-4 py-2.5 rounded-lg border border-white/10 bg-white/5 text-white placeholder-white/30 focus:outline-none focus:border-[#f5c542]/40 transition-colors duration-200"
                />
                <button
                  onClick={addEditExt}
                  disabled={!newEditExt.trim()}
                  className="px-4 py-2.5 rounded-lg bg-[#f5c542] text-[#2c1810] text-sm font-medium hover:bg-[#e5b535] transition-colors duration-200 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
                >
                  Add
                </button>
              </div>

              {/* Extensions list */}
              <div>
                <p className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-3">
                  {editFormats.length} Extension{editFormats.length !== 1 ? 's' : ''}
                </p>
                {editFormats.length === 0 ? (
                  <p className="text-white/25 text-sm">No extensions defined. Add at least one.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {editFormats.map((ext) => (
                      <span
                        key={ext}
                        className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-full border border-[#f5c542]/30 bg-[#f5c542]/10 text-[#f5c542]"
                      >
                        .{ext.toLowerCase()}
                        <button
                          onClick={() => removeEditExt(ext)}
                          className="w-4 h-4 rounded-full flex items-center justify-center text-[#f5c542]/50 hover:text-[#c45c5c] transition-colors duration-200 cursor-pointer"
                        >
                          <i className="ri-close-line text-[10px]"></i>
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-end gap-2 p-5 border-t border-white/10">
              <button
                onClick={closeEditModal}
                className="px-4 py-2 rounded-lg text-white/60 text-sm font-medium hover:text-white hover:bg-white/5 transition-colors duration-200 cursor-pointer whitespace-nowrap"
              >
                Cancel
              </button>
              <button
                onClick={saveEditModal}
                className="px-5 py-2 rounded-lg bg-[#f5c542] text-[#2c1810] text-sm font-medium hover:bg-[#e5b535] transition-colors duration-200 cursor-pointer whitespace-nowrap"
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}