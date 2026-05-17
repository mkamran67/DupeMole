import { useState, useCallback, useEffect, useMemo } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useSettings } from '../../../settings/SettingsContext';
import { useOrganize, type OrganizeCompleteResult } from '../../../organize/OrganizeContext';
import {
  buildExtensionAllowlist,
  deriveActiveTypeIds,
  mergePresets,
} from '../../../settings/filterPresets';
import { basename } from '../../../lib/format';
import FilterPanel from './FilterPanel';
import CollisionPromptModal, { type CollisionEvent } from './CollisionPromptModal';
import CustomFileTypeModal from './CustomFileTypeModal';

interface SourceDir {
  id: number;
  name: string;
  path: string;
}

function buildPreview(year: boolean, month: boolean, day: boolean): string {
  const parts: string[] = ['Images'];
  if (year) {
    parts.push('2024');
    if (month) {
      parts.push('03-March');
      if (day) parts.push('15');
    }
  }
  parts.push('IMG_1234.jpg');
  return parts.join(' / ');
}

export default function OrganizeView() {
  const { settings, updateOrganizeFilters, updateSettings } = useSettings();

  // Single source of truth: presets (built-in + user-defined custom) and the
  // active type ids are derived from settings.organizeFilters.extensions.
  // Toggling a chip writes back to settings so OrganizeView and the embedded
  // FilterPanel stay in lockstep.
  const allPresets = useMemo(
    () => mergePresets(settings.customFileTypes),
    [settings.customFileTypes]
  );
  const activeTypeIds = useMemo(
    () => deriveActiveTypeIds(settings.organizeFilters.extensions, allPresets),
    [settings.organizeFilters.extensions, allPresets]
  );

  const [sources, setSources] = useState<SourceDir[]>([]);
  const [target, setTarget] = useState<string>('');
  const [op, setOp] = useState<'copy' | 'move'>('copy');
  const [year, setYear] = useState(true);
  const [month, setMonth] = useState(true);
  const [day, setDay] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [customTypeModalOpen, setCustomTypeModalOpen] = useState(false);

  const {
    running,
    startOrganize: ctxStartOrganize,
    cancelOrganize: ctxCancelOrganize,
    onComplete,
    onCollision,
  } = useOrganize();
  const [completion, setCompletion] = useState<OrganizeCompleteResult | null>(null);
  const [collision, setCollision] = useState<CollisionEvent | null>(null);
  const [dragActive, setDragActive] = useState(false);

  // disable month/day if year unchecked
  useEffect(() => {
    if (!year) {
      setMonth(false);
      setDay(false);
    }
  }, [year]);
  useEffect(() => {
    if (!month) setDay(false);
  }, [month]);

  const addSource = (path: string) => {
    setSources((prev) => {
      if (prev.some((s) => s.path === path)) return prev;
      return [
        ...prev,
        { id: Date.now() + Math.floor(Math.random() * 1000), name: basename(path), path },
      ];
    });
  };

  const browseSources = useCallback(async () => {
    try {
      const sel = await openDialog({ directory: true, multiple: true });
      if (!sel) return;
      const paths = Array.isArray(sel) ? sel : [sel];
      paths.forEach((p) => addSource(p));
    } catch (err) {
      console.error('source picker failed', err);
    }
  }, []);

  const browseTarget = useCallback(async () => {
    try {
      const sel = await openDialog({ directory: true, multiple: false });
      if (!sel || Array.isArray(sel)) return;
      setTarget(sel);
    } catch (err) {
      console.error('target picker failed', err);
    }
  }, []);

  const removeSource = (id: number) => {
    setSources((prev) => prev.filter((s) => s.id !== id));
  };

  const toggleType = (id: string) => {
    const next = activeTypeIds.includes(id)
      ? activeTypeIds.filter((t) => t !== id)
      : [...activeTypeIds, id];
    updateOrganizeFilters({ extensions: buildExtensionAllowlist(next, '', allPresets) });
  };

  const addCustomFileType = async (label: string, formats: string[]) => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const next = [...settings.customFileTypes, { id, label, formats }];
    await updateSettings({ customFileTypes: next });
    // Auto-activate the new type so the user sees it take effect immediately.
    const merged = mergePresets(next);
    const nextActive = [...activeTypeIds, `custom:${id}`];
    await updateOrganizeFilters({ extensions: buildExtensionAllowlist(nextActive, '', merged) });
  };

  const deleteCustomFileType = async (id: string) => {
    const next = settings.customFileTypes.filter((c) => c.id !== id);
    await updateSettings({ customFileTypes: next });
    const merged = mergePresets(next);
    const nextActive = activeTypeIds.filter((t) => t !== `custom:${id}`);
    await updateOrganizeFilters({ extensions: buildExtensionAllowlist(nextActive, '', merged) });
  };

  const start = useCallback(async () => {
    if (sources.length === 0 || !target) return;
    if (op === 'move') {
      const confirmed = window.confirm(
        'Move mode will relocate originals from the source folders into the target. Continue?'
      );
      if (!confirmed) return;
    }
    setCompletion(null);
    await ctxStartOrganize({
      sources: sources.map((s) => s.path),
      target,
      op,
      granularity: { year, month, day },
      extensions: settings.organizeFilters.extensions,
      minSize: settings.organizeFilters.minSize,
      maxSize: settings.organizeFilters.maxSize,
      ignoreMacosFiles: settings.organizeFilters.ignoreMacosFiles,
      writeFilenameDate: settings.organizeFilters.writeFilenameDateMetadata ?? false,
      skipImagesWithExistingDate:
        settings.organizeFilters.skipImagesWithExistingDate ?? false,
    });
  }, [sources, target, op, year, month, day, settings.organizeFilters.extensions, settings.organizeFilters.minSize, settings.organizeFilters.maxSize, settings.organizeFilters.ignoreMacosFiles, settings.organizeFilters.writeFilenameDateMetadata, settings.organizeFilters.skipImagesWithExistingDate, ctxStartOrganize]);

  const cancel = useCallback(() => {
    void ctxCancelOrganize();
  }, [ctxCancelOrganize]);

  useEffect(() => {
    const offComplete = onComplete((result) => {
      setCompletion(result);
      setCollision(null);
    });
    const offCollision = onCollision((e) => {
      setCollision(e);
    });
    return () => {
      offComplete();
      offCollision();
    };
  }, [onComplete, onCollision]);

  // Allow start when extensions = null (all types) OR at least one extension is in the
  // allowlist (covering both built-in chips and named custom types).
  const hasAnyAllowedType =
    settings.organizeFilters.extensions === null
    || settings.organizeFilters.extensions.length > 0;
  const canStart = sources.length > 0 && !!target && hasAnyAllowedType && !running;

  return (
    <div className="min-h-full flex flex-col relative pb-12 md:pb-16">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-white text-2xl font-bold tracking-tight">Organize</h2>
          <p className="text-white/40 text-sm mt-1">
            Sort photos & videos into Year / Month / Day folders by capture date
          </p>
        </div>
        {running ? (
          <button
            onClick={cancel}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold bg-[#c45c5c] text-white hover:bg-[#a84848] transition-colors duration-200 cursor-pointer whitespace-nowrap"
          >
            <i className="ri-stop-circle-line"></i>
            Cancel
          </button>
        ) : (
          <button
            onClick={start}
            disabled={!canStart}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 cursor-pointer whitespace-nowrap ${
              canStart
                ? 'bg-[#f5c542] text-[#2c1810] hover:bg-[#e0b038]'
                : 'bg-white/10 text-white/30 cursor-not-allowed'
            }`}
          >
            <i className="ri-play-circle-line"></i>
            Start Organizing
          </button>
        )}
      </div>

      {/* Source folders */}
      <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-5 mb-6">
        <div className="flex items-center justify-between mb-3">
          <p className="text-white/30 text-xs font-semibold uppercase tracking-wider">
            Source Folders
          </p>
          <button
            onClick={browseSources}
            disabled={running}
            className="text-[#f5c542] hover:text-[#e0b038] text-xs font-medium cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <i className="ri-add-line mr-1"></i>Add folder
          </button>
        </div>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            setDragActive(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragActive(false);
          }}
          onClick={browseSources}
          className={`rounded-xl border-2 border-dashed cursor-pointer p-4 text-center transition-colors duration-200 ${
            dragActive
              ? 'border-[#f5c542] bg-[#f5c542]/10'
              : 'border-white/15 hover:border-white/30'
          }`}
        >
          <p className="text-white/40 text-xs">Click to browse for folders to organize</p>
        </div>
        {sources.length > 0 && (
          <div className="space-y-2 mt-4">
            {sources.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-3 p-3 rounded-xl bg-white/5 border border-white/5"
              >
                <div className="w-9 h-9 rounded-lg bg-[#f5c542]/10 flex items-center justify-center shrink-0">
                  <i className="ri-folder-line text-[#f5c542] text-base"></i>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-white text-sm font-medium font-mono truncate">{s.name}</p>
                  <p className="text-white/30 text-xs font-mono truncate">{s.path}</p>
                </div>
                <button
                  onClick={() => removeSource(s.id)}
                  disabled={running}
                  className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/30 hover:text-white/60 transition-colors duration-200 cursor-pointer shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <i className="ri-close-line text-sm"></i>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Target folder */}
      <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-5 mb-6">
        <p className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-3">
          Target Folder
        </p>
        <button
          onClick={browseTarget}
          disabled={running}
          className="w-full flex items-center gap-3 p-3 rounded-xl bg-white/5 border border-white/5 hover:border-white/20 transition-colors duration-200 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed text-left"
        >
          <div className="w-9 h-9 rounded-lg bg-[#f5c542]/10 flex items-center justify-center shrink-0">
            <i className="ri-folder-open-line text-[#f5c542] text-base"></i>
          </div>
          <div className="flex-1 min-w-0">
            {target ? (
              <>
                <p className="text-white text-sm font-medium font-mono truncate">
                  {basename(target)}
                </p>
                <p className="text-white/30 text-xs font-mono truncate">{target}</p>
              </>
            ) : (
              <p className="text-white/40 text-sm">Click to choose where the organized files go</p>
            )}
          </div>
        </button>
      </div>

      {/* Operation */}
      <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-5 mb-6">
        <p className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-3">
          Operation
        </p>
        <div className="flex gap-2">
          {(['copy', 'move'] as const).map((mode) => {
            const active = op === mode;
            return (
              <button
                key={mode}
                onClick={() => setOp(mode)}
                disabled={running}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                  active
                    ? mode === 'move'
                      ? 'bg-[#c45c5c]/15 text-[#c45c5c] border border-[#c45c5c]/40'
                      : 'bg-[#f5c542]/15 text-[#f5c542] border border-[#f5c542]/40'
                    : 'bg-white/5 text-white/50 border border-white/10 hover:border-white/20'
                }`}
              >
                <i
                  className={
                    mode === 'copy' ? 'ri-file-copy-line' : 'ri-scissors-cut-line'
                  }
                ></i>
                {mode === 'copy' ? 'Copy (originals stay)' : 'Move (originals relocate)'}
              </button>
            );
          })}
        </div>
      </div>

      {/* Folder structure */}
      <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-5 mb-6">
        <p className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-3">
          Folder Structure
        </p>
        <div className="flex flex-wrap gap-2 mb-4">
          {[
            { id: 'year', label: 'Year', checked: year, set: setYear, disabled: false },
            { id: 'month', label: 'Month', checked: month, set: setMonth, disabled: !year },
            { id: 'day', label: 'Day', checked: day, set: setDay, disabled: !month },
          ].map((c) => (
            <button
              key={c.id}
              onClick={() => c.set(!c.checked)}
              disabled={running || c.disabled}
              className={`inline-flex items-center gap-2 text-xs font-medium px-3 py-2 rounded-full border transition-all duration-200 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
                c.checked
                  ? 'border-[#f5c542] bg-[#f5c542]/15 text-[#f5c542]'
                  : 'border-white/10 text-white/50 hover:border-white/20'
              }`}
            >
              <i className={c.checked ? 'ri-checkbox-fill' : 'ri-checkbox-blank-line'}></i>
              {c.label}
            </button>
          ))}
        </div>
        <div className="rounded-xl bg-[#2c1810] border border-white/5 p-3 space-y-1">
          <p className="text-white/30 text-[10px] font-semibold uppercase tracking-wider mb-1">
            Preview
          </p>
          <p className="text-[#f5c542] text-sm font-mono truncate">
            {target ? `${basename(target)} / ` : ''}
            {buildPreview(year, month, day)}
          </p>
          <p className="text-white/40 text-[11px] font-mono truncate">
            {target ? `${basename(target)} / ` : ''}PDFs / report.pdf
          </p>
          <p className="text-white/40 text-[11px] font-mono truncate">
            {target ? `${basename(target)} / ` : ''}Unknown / LOG / app.log
          </p>
        </div>
        <p className="text-white/30 text-[11px] mt-3 leading-relaxed">
          Files are grouped by type (Images, Videos, PDFs, Audio, Docs, Archives). Year/Month/Day
          applies to Images & Videos with a readable date — undated media goes into{' '}
          <code className="text-white/50">&lt;Category&gt;/Unknown</code>. Other types go directly
          into their category folder. Files with extensions outside these groups go into{' '}
          <code className="text-white/50">Unknown/&lt;EXT&gt;</code>.
        </p>
      </div>

      {/* File types */}
      <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-5 mb-6">
        <div className="flex items-center justify-between mb-3">
          <p className="text-white/30 text-xs font-semibold uppercase tracking-wider">
            File Types
          </p>
          <p className="text-white/30 text-[11px]">
            {activeTypeIds.length} of {allPresets.length} types
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {allPresets.map((ft) => {
            const active = activeTypeIds.includes(ft.id);
            const isCustom = ft.id.startsWith('custom:');
            const customId = isCustom ? ft.id.slice('custom:'.length) : null;
            return (
              <span key={ft.id} className="inline-flex items-stretch">
                <button
                  onClick={() => toggleType(ft.id)}
                  disabled={running}
                  className={`inline-flex items-center gap-1.5 text-xs font-medium pl-3 ${
                    isCustom ? 'pr-2' : 'pr-3'
                  } py-1.5 rounded-full border transition-all duration-200 cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed ${
                    active
                      ? 'border-[#f5c542] bg-[#f5c542]/15 text-[#f5c542]'
                      : 'border-white/10 text-white/50 hover:border-white/20'
                  }`}
                  title={isCustom ? `${ft.label} (${ft.formats.join(', ').toLowerCase()})` : ft.label}
                >
                  <i className={`${ft.icon} text-sm`}></i>
                  {ft.label}
                  {isCustom && customId && (
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`Delete ${ft.label}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (running) return;
                        void deleteCustomFileType(customId);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          e.stopPropagation();
                          if (running) return;
                          void deleteCustomFileType(customId);
                        }
                      }}
                      className="ml-1 -mr-0.5 w-4 h-4 inline-flex items-center justify-center rounded-full text-current opacity-50 hover:opacity-100 hover:text-[#c45c5c] cursor-pointer"
                    >
                      <i className="ri-close-line text-[10px]"></i>
                    </span>
                  )}
                </button>
              </span>
            );
          })}
          <button
            onClick={() => setCustomTypeModalOpen(true)}
            disabled={running}
            className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full border border-dashed border-white/15 text-white/40 hover:text-white/70 hover:border-white/30 transition-all duration-200 cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
            title="Create a custom file type with your own name and extensions"
          >
            <i className="ri-add-line text-sm"></i>
            New file type
          </button>
        </div>
        <p className="text-white/30 text-[11px] mt-3 leading-relaxed">
          Files with no readable capture date fall back to a date in the filename (e.g.{' '}
          <span className="font-mono">2025-02-11-0005.jpg</span>), then to the older of the
          filesystem created/modified times. Undated images and videos are routed to{' '}
          <code className="text-white/50">&lt;Category&gt;/Unknown</code>.
        </p>
        <div className="mt-4 flex justify-end">
          <button
            onClick={() => setShowFilters((v) => !v)}
            className="text-[#f5c542] hover:text-[#e0b038] text-xs font-medium cursor-pointer"
          >
            <i className={`${showFilters ? 'ri-arrow-up-s-line' : 'ri-arrow-down-s-line'} mr-1`}></i>
            {showFilters ? 'Hide advanced filters' : 'Advanced filters'}
          </button>
        </div>
        {showFilters && (
          <div className="mt-4">
            <FilterPanel kind="organize" />
          </div>
        )}
      </div>

      {/* Date metadata */}
      <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-5 mb-6">
        <p className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-3">
          Date Metadata
        </p>
        <label className="flex items-start gap-3 cursor-pointer">
          <button
            type="button"
            role="checkbox"
            aria-checked={settings.organizeFilters.writeFilenameDateMetadata ?? false}
            disabled={running}
            onClick={() =>
              void updateOrganizeFilters({
                writeFilenameDateMetadata:
                  !(settings.organizeFilters.writeFilenameDateMetadata ?? false),
              })
            }
            className={`mt-0.5 inline-flex items-center justify-center w-5 h-5 rounded border transition-all duration-200 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
              settings.organizeFilters.writeFilenameDateMetadata
                ? 'border-[#f5c542] bg-[#f5c542]/20 text-[#f5c542]'
                : 'border-white/20 text-transparent hover:border-white/40'
            }`}
          >
            <i className="ri-check-line text-sm leading-none"></i>
          </button>
          <span className="flex-1">
            <span className="block text-white text-sm font-medium">
              Write parsed filename date into image & video metadata (when missing)
            </span>
            <span className="block text-white/40 text-[11px] mt-1 leading-relaxed">
              Affects images and videos that lack a capture-date tag but have
              a parseable date in their filename (e.g.{' '}
              <span className="font-mono">2025-02-11.jpg</span>,{' '}
              <span className="font-mono">2025-02-11.mp4</span>). For images
              we write EXIF <span className="font-mono">DateTimeOriginal</span>;
              for videos in the QuickTime / MP4 family (mp4, m4v, mov, qt,
              3gp, 3g2) we patch the <span className="font-mono">mvhd</span>{' '}
              and <span className="font-mono">tkhd</span> creation time in
              place. Files in container formats we can't write into (RAW,
              BMP, GIF, AVIF, SVG, MKV, WEBM, AVI, FLV, WMV) are routed to{' '}
              <code className="text-white/60">MetadataWriteFailed/</code> so
              you can retry them later.
            </span>
          </span>
        </label>
        {(settings.organizeFilters.writeFilenameDateMetadata ?? false) && (
          <label className="flex items-start gap-3 cursor-pointer mt-4 pl-8">
            <button
              type="button"
              role="checkbox"
              aria-checked={settings.organizeFilters.skipImagesWithExistingDate ?? false}
              disabled={running}
              onClick={() =>
                void updateOrganizeFilters({
                  skipImagesWithExistingDate:
                    !(settings.organizeFilters.skipImagesWithExistingDate ?? false),
                })
              }
              className={`mt-0.5 inline-flex items-center justify-center w-5 h-5 rounded border transition-all duration-200 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
                settings.organizeFilters.skipImagesWithExistingDate
                  ? 'border-[#f5c542] bg-[#f5c542]/20 text-[#f5c542]'
                  : 'border-white/20 text-transparent hover:border-white/40'
              }`}
            >
              <i className="ri-check-line text-sm leading-none"></i>
            </button>
            <span className="flex-1">
              <span className="block text-white text-sm font-medium">
                Only process images without date metadata
              </span>
              <span className="block text-white/40 text-[11px] mt-1 leading-relaxed">
                Images that already have a date-taken EXIF tag are left in
                their source folder and not moved or copied. Videos are
                unaffected by this option.
              </span>
            </span>
          </label>
        )}
      </div>

      {/* Completion modal */}
      {completion && (
        <CompletionModal
          result={completion}
          op={op}
          onClose={() => setCompletion(null)}
        />
      )}

      {/* Collision prompt — blocks the worker until the user decides. */}
      {collision && (
        <CollisionPromptModal
          event={collision}
          onResolved={() => setCollision(null)}
        />
      )}

      {/* New custom file type */}
      {customTypeModalOpen && (
        <CustomFileTypeModal
          onClose={() => setCustomTypeModalOpen(false)}
          onCreate={addCustomFileType}
        />
      )}

      {/* Spacer to keep layout stable on tall screens */}
      <div className="flex-1" />
    </div>
  );
}

function CompletionModal({
  result,
  op,
  onClose,
}: {
  result: OrganizeCompleteResult;
  op: 'copy' | 'move';
  onClose: () => void;
}) {
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose]
  );
  useEffect(() => {
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [handleKey]);

  const moved = result.moved + result.copied; // user only sees one mode at a time
  const errorCount = result.errors.length;
  const skippedTotal = result.skippedIdentical + result.skippedByUser;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-[#3d2418] rounded-2xl border border-white/10 w-full max-w-lg shadow-2xl overflow-hidden">
        <div className="flex flex-col items-center pt-8 pb-4 px-6">
          <div
            className={`w-16 h-16 rounded-full flex items-center justify-center mb-4 ${
              result.cancelled ? 'bg-[#c45c5c]/15' : 'bg-[#f5c542]/15'
            }`}
          >
            <i
              className={`text-3xl ${
                result.cancelled
                  ? 'ri-close-circle-line text-[#c45c5c]'
                  : 'ri-checkbox-circle-line text-[#f5c542]'
              }`}
            ></i>
          </div>
          <h3 className="text-white text-xl font-bold">
            {result.cancelled ? 'Cancelled' : 'Organize Complete'}
          </h3>
          <p className="text-white/40 text-sm mt-1 text-center">
            {result.cancelled
              ? 'The operation was stopped — partial output is intact.'
              : 'Your files have been organized by capture date.'}
          </p>
        </div>

        <div className="px-6 pb-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-[#2c1810] rounded-xl border border-white/10 p-4 text-center">
              <p className="text-white text-2xl font-bold">{moved.toLocaleString()}</p>
              <p className="text-white/40 text-xs mt-1">{op === 'copy' ? 'Copied' : 'Moved'}</p>
            </div>
            <div className="bg-[#2c1810] rounded-xl border border-white/10 p-4 text-center">
              <p className="text-white text-2xl font-bold">{skippedTotal.toLocaleString()}</p>
              <p className="text-white/40 text-xs mt-1">
                Skipped
                {(result.skippedIdentical > 0 || result.skippedByUser > 0) && (
                  <span className="block text-white/30 text-[10px] mt-0.5">
                    {result.skippedIdentical} identical
                    {result.skippedByUser > 0 ? ` · ${result.skippedByUser} by user` : ''}
                  </span>
                )}
              </p>
            </div>
            <div className="bg-[#2c1810] rounded-xl border border-white/10 p-4 text-center">
              <p className="text-white text-2xl font-bold">{result.processed.toLocaleString()}</p>
              <p className="text-white/40 text-xs mt-1">
                Processed
                {(result.overwritten > 0 || result.renamed > 0) && (
                  <span className="block text-white/30 text-[10px] mt-0.5">
                    {result.overwritten > 0 ? `${result.overwritten} overwritten` : ''}
                    {result.overwritten > 0 && result.renamed > 0 ? ' · ' : ''}
                    {result.renamed > 0 ? `${result.renamed} renamed` : ''}
                  </span>
                )}
              </p>
            </div>
            <div className="bg-[#2c1810] rounded-xl border border-white/10 p-4 text-center">
              <p
                className={`text-2xl font-bold ${
                  errorCount > 0 ? 'text-[#c45c5c]' : 'text-white'
                }`}
              >
                {errorCount.toLocaleString()}
              </p>
              <p className="text-white/40 text-xs mt-1">Errors</p>
            </div>
          </div>

          {(result.metadataWritten > 0 || result.metadataWriteFailed > 0) && (
            <div className="mt-3 bg-[#2c1810] rounded-xl border border-white/10 p-3 flex items-center justify-between gap-3">
              <div className="flex-1">
                <p className="text-white/30 text-[10px] font-semibold uppercase tracking-wider">
                  Date metadata
                </p>
                <p className="text-white/70 text-xs mt-1">
                  {result.metadataWritten > 0 && (
                    <span>
                      <span className="text-[#f5c542] font-semibold">
                        {result.metadataWritten}
                      </span>{' '}
                      written
                    </span>
                  )}
                  {result.metadataWritten > 0 && result.metadataWriteFailed > 0 && ' · '}
                  {result.metadataWriteFailed > 0 && (
                    <span>
                      <span className="text-[#c45c5c] font-semibold">
                        {result.metadataWriteFailed}
                      </span>{' '}
                      in <code className="font-mono">MetadataWriteFailed/</code>
                    </span>
                  )}
                </p>
              </div>
            </div>
          )}

          <div className="mt-3 bg-[#2c1810] rounded-xl border border-white/10 p-3">
            <p className="text-white/30 text-[10px] font-semibold uppercase tracking-wider mb-1">
              Target
            </p>
            <div className="flex items-center gap-2">
              <p className="text-white/70 text-xs font-mono truncate flex-1">{result.target}</p>
              <button
                onClick={() => navigator.clipboard?.writeText(result.target).catch(() => {})}
                className="text-white/40 hover:text-white/80 text-xs cursor-pointer shrink-0"
                title="Copy path"
              >
                <i className="ri-file-copy-line"></i>
              </button>
            </div>
          </div>

          {errorCount > 0 && (
            <details className="mt-3 bg-[#2c1810] rounded-xl border border-[#c45c5c]/30 p-3">
              <summary className="text-[#c45c5c] text-xs font-semibold cursor-pointer">
                Show {errorCount} error{errorCount === 1 ? '' : 's'}
              </summary>
              <div className="mt-2 max-h-40 overflow-y-auto space-y-1">
                {result.errors.slice(0, 50).map((err, i) => (
                  <div key={i} className="text-white/60 text-[11px] font-mono">
                    <span className="text-[#c45c5c]">{err.reason}</span>
                    <span className="text-white/30"> — {err.path}</span>
                  </div>
                ))}
                {result.errors.length > 50 && (
                  <p className="text-white/30 text-[11px]">
                    …and {result.errors.length - 50} more
                  </p>
                )}
              </div>
            </details>
          )}
        </div>

        <div className="flex items-center gap-3 px-6 pb-6 pt-2">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-3 rounded-xl bg-[#f5c542] text-[#2c1810] text-sm font-semibold hover:bg-[#e0b038] transition-colors duration-200 cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
