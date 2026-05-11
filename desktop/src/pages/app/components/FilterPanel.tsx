import { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { isMacos, useSettings, type AppFilters } from '../../../settings/SettingsContext';
import {
  SIZE_PRESETS,
  DATE_PRESETS,
  buildExtensionAllowlist,
  deriveActiveTypeIds,
  mergePresets,
  sizePresetLabel,
  datePresetLabel,
  datePresetToAfterMs,
  type FilterTypePreset,
} from '../../../settings/filterPresets';

interface FilterPanelProps {
  kind: 'scan' | 'organize';
  title?: string;
  subtitle?: string;
}

export default function FilterPanel({ kind, title, subtitle }: FilterPanelProps) {
  const { settings, updateScanFilters, updateOrganizeFilters, updateSettings } = useSettings();
  const filters: AppFilters = kind === 'scan' ? settings.scanFilters : settings.organizeFilters;
  const updateFilters = useCallback(
    (patch: Partial<AppFilters>) =>
      kind === 'scan' ? updateScanFilters(patch) : updateOrganizeFilters(patch),
    [kind, updateScanFilters, updateOrganizeFilters]
  );

  // Merge built-in presets with user-defined custom types so a custom chip
  // shows up here too and toggling stays in sync with OrganizeView.
  const mergedFromSettings = useMemo(
    () => mergePresets(settings.customFileTypes),
    [settings.customFileTypes]
  );
  const [filterTypes, setFilterTypes] = useState<FilterTypePreset[]>(mergedFromSettings);
  useEffect(() => {
    setFilterTypes(mergedFromSettings);
  }, [mergedFromSettings]);
  const activeTypes = useMemo(
    () => deriveActiveTypeIds(filters.extensions, filterTypes),
    [filters.extensions, filterTypes]
  );

  const customExtFromFilters = useMemo(() => {
    if (!filters.extensions) return '';
    const presetExts = new Set<string>();
    activeTypes.forEach((id) => {
      filterTypes
        .find((p) => p.id === id)
        ?.formats.forEach((f) => presetExts.add(f.toLowerCase()));
    });
    const extras = filters.extensions.filter((e) => !presetExts.has(e.toLowerCase()));
    return extras.map((e) => `.${e}`).join(', ');
  }, [filters.extensions, activeTypes, filterTypes]);

  const [customExt, setCustomExt] = useState(customExtFromFilters);
  useEffect(() => setCustomExt(customExtFromFilters), [customExtFromFilters]);

  // Staged input for the custom-extension picker — committed only on click/Enter.
  const [customExtInput, setCustomExtInput] = useState('');

  // Custom extensions (those not covered by any preset), uppercased and unique.
  const customExtensions = useMemo(() => {
    return customExt
      .split(',')
      .map((s) => s.trim().replace(/^\./, '').toUpperCase())
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i);
  }, [customExt]);

  const sizePreset = sizePresetLabel(filters.minSize, filters.maxSize);
  const datePreset = datePresetLabel(filters.modifiedAfterMs);

  const ignoredFolders = filters.ignoredFolders;
  const ignoredTypes = filters.ignoredExtensions.map((e) => e.toUpperCase());

  const [editingType, setEditingType] = useState<FilterTypePreset | null>(null);
  const [editFormats, setEditFormats] = useState<string[]>([]);
  const [newEditExt, setNewEditExt] = useState('');
  const modalRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  const [newFolder, setNewFolder] = useState('');
  const [newType, setNewType] = useState('');

  const showMacosToggle = useMemo(() => isMacos(), []);

  const initialMinUnit: 'KB' | 'MB' = useMemo(() => {
    const n = filters.minSize;
    if (n && n >= 1024 * 1024 && n % (1024 * 1024) === 0) return 'MB';
    return 'KB';
  }, [filters.minSize]);
  const [minSizeUnit, setMinSizeUnit] = useState<'KB' | 'MB'>(initialMinUnit);
  const minSizeInputValue = useMemo(() => {
    if (filters.minSize == null) return '';
    const div = minSizeUnit === 'MB' ? 1024 * 1024 : 1024;
    const v = filters.minSize / div;
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }, [filters.minSize, minSizeUnit]);

  const onMinSizeInputChange = (raw: string) => {
    if (raw.trim() === '') {
      updateFilters({ minSize: null });
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return;
    const mult = minSizeUnit === 'MB' ? 1024 * 1024 : 1024;
    updateFilters({ minSize: Math.round(n * mult) });
  };

  const writeAllowlist = (typeIds: string[], custom: string) => {
    const list = buildExtensionAllowlist(typeIds, custom, filterTypes);
    updateFilters({ extensions: list });
  };

  const toggleType = (id: string) => {
    const next = activeTypes.includes(id)
      ? activeTypes.filter((t) => t !== id)
      : [...activeTypes, id];
    writeAllowlist(next, customExt);
  };

  const setSizePreset = (label: string) => {
    const p = SIZE_PRESETS.find((s) => s.label === label) ?? SIZE_PRESETS[0];
    updateFilters({ minSize: p.min ?? null, maxSize: p.max ?? null });
  };

  const setDatePreset = (label: string) => {
    const after = datePresetToAfterMs(label);
    updateFilters({ modifiedAfterMs: after ?? null });
  };

  const openEditModal = (e: React.MouseEvent, ft: FilterTypePreset) => {
    e.stopPropagation();
    setEditingType(ft);
    setEditFormats([...ft.formats]);
    setNewEditExt('');
    setTimeout(() => editInputRef.current?.focus(), 50);
  };

  const closeEditModal = () => {
    setEditingType(null);
    setEditFormats([]);
    setNewEditExt('');
  };

  const saveEditModal = () => {
    if (!editingType) return;
    const updated = filterTypes.map((ft) =>
      ft.id === editingType.id ? { ...ft, formats: editFormats } : ft
    );
    setFilterTypes(updated);
    const list = buildExtensionAllowlist(activeTypes, customExt, updated);
    updateFilters({ extensions: list });
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

  const presetExtensions = useMemo(() => {
    if (!filters.extensions) {
      const all: string[] = [];
      filterTypes.forEach((ft) => ft.formats.forEach((f) => all.push(f)));
      return [...new Set(all)];
    }
    const customSet = new Set(customExtensions.map((e) => e.toLowerCase()));
    return [
      ...new Set(
        filters.extensions
          .map((e) => e.toLowerCase())
          .filter((e) => !customSet.has(e))
          .map((e) => e.toUpperCase())
      ),
    ];
  }, [filters.extensions, filterTypes, customExtensions]);

  const commitCustomExt = () => {
    const raw = customExtInput.trim();
    if (!raw) return;
    const tokens = raw
      .split(',')
      .map((s) => s.trim().replace(/^\./, '').toLowerCase())
      .filter(Boolean);
    if (tokens.length === 0) return;
    const existing = customExt
      .split(',')
      .map((s) => s.trim().replace(/^\./, '').toLowerCase())
      .filter(Boolean);
    const merged = Array.from(new Set([...existing, ...tokens]));
    const next = merged.map((e) => `.${e}`).join(', ');
    setCustomExt(next);
    setCustomExtInput('');
    writeAllowlist(activeTypes, next);
  };

  const removeCustomExt = (ext: string) => {
    const target = ext.toLowerCase();
    const remaining = customExt
      .split(',')
      .map((s) => s.trim().replace(/^\./, '').toLowerCase())
      .filter(Boolean)
      .filter((e) => e !== target);
    const next = remaining.map((e) => `.${e}`).join(', ');
    setCustomExt(next);
    writeAllowlist(activeTypes, next);
  };

  const addIgnoredFolder = () => {
    if (!newFolder.trim()) return;
    updateFilters({ ignoredFolders: [...ignoredFolders, newFolder.trim()] });
    setNewFolder('');
  };

  const removeIgnoredFolder = (idx: number) => {
    updateFilters({ ignoredFolders: ignoredFolders.filter((_, i) => i !== idx) });
  };

  const addIgnoredType = () => {
    if (!newType.trim()) return;
    const clean = newType.trim().replace(/^\./, '').toLowerCase();
    updateFilters({ ignoredExtensions: [...filters.ignoredExtensions, clean] });
    setNewType('');
  };

  const removeIgnoredType = (idx: number) => {
    updateFilters({
      ignoredExtensions: filters.ignoredExtensions.filter((_, i) => i !== idx),
    });
  };

  return (
    <div className="space-y-5">
      {(title || subtitle) && (
        <div>
          {title && <h3 className="text-white text-base font-semibold">{title}</h3>}
          {subtitle && <p className="text-white/40 text-xs mt-1">{subtitle}</p>}
        </div>
      )}

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

      <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-5">
        <p className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-3">
          {filters.extensions ? 'Selected Extensions' : 'All Extensions Included'}
        </p>
        {presetExtensions.length === 0 && customExtensions.length === 0 ? (
          <p className="text-white/25 text-xs">No file types selected. Add at least one category or a custom extension.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {presetExtensions.map((ext) => (
              <span
                key={`p-${ext}`}
                className="text-xs font-medium px-2.5 py-1 rounded-full border border-[#f5c542]/30 bg-[#f5c542]/10 text-[#f5c542]"
              >
                .{ext.toLowerCase()}
              </span>
            ))}
            {customExtensions.map((ext) => (
              <span
                key={`c-${ext}`}
                className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border border-[#7ab8f5]/40 bg-[#7ab8f5]/10 text-[#7ab8f5]"
              >
                .{ext.toLowerCase()}
                <button
                  onClick={() => removeCustomExt(ext)}
                  className="w-4 h-4 rounded-full flex items-center justify-center text-[#7ab8f5]/60 hover:text-[#c45c5c] transition-colors duration-200 cursor-pointer"
                  title={`Remove .${ext.toLowerCase()}`}
                >
                  <i className="ri-close-line text-[10px]"></i>
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-5 space-y-6">
        <p className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-1">Ignore</p>

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
            <p className="text-white/25 text-xs">No folders ignored yet.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {ignoredFolders.map((folder, idx) => (
                <span
                  key={`${folder}-${idx}`}
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
                  key={`${ext}-${idx}`}
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

      <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-5">
        <p className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-3">Custom Extensions</p>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder=".custom, .ext, .log ..."
            value={customExtInput}
            onChange={(e) => setCustomExtInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitCustomExt();
              }
            }}
            className="flex-1 text-sm px-4 py-3 rounded-lg border border-white/10 bg-white/5 text-white placeholder-white/30 focus:outline-none focus:border-[#f5c542]/40 transition-colors duration-200"
          />
          <button
            onClick={commitCustomExt}
            disabled={!customExtInput.trim()}
            className="w-12 rounded-lg bg-[#f5c542] text-[#2c1810] flex items-center justify-center hover:bg-[#e5b535] transition-colors duration-200 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            title="Add custom extensions"
          >
            <i className="ri-add-line text-lg"></i>
          </button>
        </div>
        <p className="text-white/25 text-[11px] mt-2">
          Type one or more comma-separated extensions and press Enter or click +.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-5">
          <p className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-3">File Size</p>
          <div className="flex flex-wrap gap-2">
            {SIZE_PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => setSizePreset(p.label)}
                className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-all duration-200 cursor-pointer whitespace-nowrap ${
                  sizePreset === p.label
                    ? 'border-[#f5c542] bg-[#f5c542]/10 text-[#f5c542]'
                    : 'border-white/10 text-white/50 hover:border-white/20'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="mt-4 pt-4 border-t border-white/5">
            <p className="text-white/40 text-[11px] font-medium mb-2">Minimum Size</p>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                step="any"
                inputMode="decimal"
                placeholder="None"
                value={minSizeInputValue}
                onChange={(e) => onMinSizeInputChange(e.target.value)}
                className="flex-1 min-w-0 text-sm px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-white placeholder-white/30 focus:outline-none focus:border-[#f5c542]/40 transition-colors duration-200"
              />
              <div className="relative">
                <select
                  value={minSizeUnit}
                  onChange={(e) => setMinSizeUnit(e.target.value as 'KB' | 'MB')}
                  className="text-sm pl-3 pr-8 py-2 rounded-lg border border-white/10 bg-white/5 text-white focus:outline-none focus:border-[#f5c542]/40 transition-colors duration-200 cursor-pointer appearance-none"
                >
                  <option value="KB" className="bg-[#3d2418]">KB</option>
                  <option value="MB" className="bg-[#3d2418]">MB</option>
                </select>
                <i className="ri-arrow-down-s-line absolute right-2 top-1/2 -translate-y-1/2 text-white/30 text-sm pointer-events-none"></i>
              </div>
              {filters.minSize != null && (
                <button
                  onClick={() => updateFilters({ minSize: null })}
                  className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-white/40 hover:text-white/60 transition-colors duration-200 cursor-pointer"
                  title="Clear minimum size"
                >
                  <i className="ri-close-line text-xs"></i>
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-5">
          <p className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-3">Date Modified</p>
          <div className="flex flex-wrap gap-2">
            {DATE_PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => setDatePreset(p.label)}
                className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-all duration-200 cursor-pointer whitespace-nowrap ${
                  datePreset === p.label
                    ? 'border-[#f5c542] bg-[#f5c542]/10 text-[#f5c542]'
                    : 'border-white/10 text-white/50 hover:border-white/20'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-white text-sm font-medium">Ignore Hidden Files</p>
            <p className="text-white/30 text-xs mt-0.5">Skip files starting with a dot</p>
          </div>
          <button
            onClick={() => updateSettings({ ignoreHidden: !settings.ignoreHidden })}
            className={`relative w-12 h-7 rounded-full transition-colors duration-300 cursor-pointer ${
              settings.ignoreHidden ? 'bg-[#f5c542]' : 'bg-white/10'
            }`}
          >
            <div
              className={`absolute top-1 w-5 h-5 rounded-full bg-white shadow-md transition-transform duration-300 ${
                settings.ignoreHidden ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
        {showMacosToggle && (
          <>
            <div className="border-t border-white/5" />
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white text-sm font-medium">Ignore macOS Metadata Files</p>
                <p className="text-white/30 text-xs mt-0.5">
                  Skip <code className="text-white/40">._*</code>, <code className="text-white/40">.DS_Store</code>, and similar
                </p>
              </div>
              <button
                onClick={() => updateFilters({ ignoreMacosFiles: !filters.ignoreMacosFiles })}
                className={`relative w-12 h-7 rounded-full transition-colors duration-300 cursor-pointer ${
                  filters.ignoreMacosFiles ? 'bg-[#f5c542]' : 'bg-white/10'
                }`}
              >
                <div
                  className={`absolute top-1 w-5 h-5 rounded-full bg-white shadow-md transition-transform duration-300 ${
                    filters.ignoreMacosFiles ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          </>
        )}
        {kind === 'scan' && (
          <>
            <div className="border-t border-white/5" />
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white text-sm font-medium">Include Subdirectories</p>
                <p className="text-white/30 text-xs mt-0.5">Scan nested folders recursively</p>
              </div>
              <button
                onClick={() => updateFilters({ includeSubdirs: !filters.includeSubdirs })}
                className={`relative w-12 h-7 rounded-full transition-colors duration-300 cursor-pointer ${
                  filters.includeSubdirs ? 'bg-[#f5c542]' : 'bg-white/10'
                }`}
              >
                <div
                  className={`absolute top-1 w-5 h-5 rounded-full bg-white shadow-md transition-transform duration-300 ${
                    filters.includeSubdirs ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          </>
        )}
      </div>

      {editingType && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div
            ref={modalRef}
            className="bg-[#3d2418] rounded-2xl border border-white/10 w-full max-w-md shadow-2xl"
          >
            <div className="flex items-center justify-between p-5 border-b border-white/10">
              <div>
                <h3 className="text-white text-lg font-semibold">Edit {editingType.label} Extensions</h3>
                <p className="text-white/40 text-xs mt-0.5">Add or remove known file extensions</p>
              </div>
              <button
                onClick={closeEditModal}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-white/30 hover:text-white/60 hover:bg-white/5 transition-colors duration-200 cursor-pointer"
              >
                <i className="ri-close-line text-lg"></i>
              </button>
            </div>

            <div className="p-5 space-y-4">
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

              <div>
                <p className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-3">
                  {editFormats.length} Extension{editFormats.length !== 1 ? 's' : ''}
                </p>
                {editFormats.length === 0 ? (
                  <p className="text-white/25 text-sm">No extensions defined.</p>
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
