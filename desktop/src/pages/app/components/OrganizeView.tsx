import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useSettings } from '../../../settings/SettingsContext';
import {
  FILTER_TYPE_PRESETS,
  buildExtensionAllowlist,
  deriveActiveTypeIds,
} from '../../../settings/filterPresets';
import { basename } from '../../../lib/format';
import FilterPanel from './FilterPanel';

interface SourceDir {
  id: number;
  name: string;
  path: string;
}

type Phase = 'walking' | 'organizing';

interface OrganizeProgressEvent {
  organizeId: string;
  progress: {
    processed: number;
    total: number;
    currentPath: string | null;
    phase: Phase;
  };
}

interface OrganizeCompleteEvent {
  organizeId: string;
  result: {
    processed: number;
    copied: number;
    moved: number;
    skipped: number;
    errors: { path: string; reason: string }[];
    cancelled: boolean;
    target: string;
  };
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
  const { settings } = useSettings();
  const initialTypeIds = useMemo(
    () => deriveActiveTypeIds(settings.organizeFilters.extensions),
    [settings.organizeFilters.extensions]
  );

  const [sources, setSources] = useState<SourceDir[]>([]);
  const [target, setTarget] = useState<string>('');
  const [op, setOp] = useState<'copy' | 'move'>('copy');
  const [year, setYear] = useState(true);
  const [month, setMonth] = useState(true);
  const [day, setDay] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [activeTypeIds, setActiveTypeIds] = useState<string[]>(
    initialTypeIds.length > 0 ? initialTypeIds : ['images', 'videos']
  );

  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [processed, setProcessed] = useState(0);
  const [total, setTotal] = useState(0);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [completion, setCompletion] = useState<OrganizeCompleteEvent['result'] | null>(null);

  const activeId = useRef<string | null>(null);
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
    setActiveTypeIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  };

  const start = useCallback(async () => {
    if (sources.length === 0 || !target) return;
    if (op === 'move') {
      const confirmed = window.confirm(
        'Move mode will relocate originals from the source folders into the target. Continue?'
      );
      if (!confirmed) return;
    }

    setRunning(true);
    setPhase('walking');
    setProcessed(0);
    setTotal(0);
    setCurrentPath(null);
    setCompletion(null);

    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `org-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    activeId.current = id;

    const extensions = buildExtensionAllowlist(activeTypeIds, '');

    try {
      await invoke<string>('start_organize', {
        organizeId: id,
        sources: sources.map((s) => s.path),
        target,
        op,
        granularity: { year, month, day },
        extensions,
        minSize: settings.organizeFilters.minSize,
        ignoreMacosFiles: settings.organizeFilters.ignoreMacosFiles,
      });
    } catch (err) {
      console.error('start_organize failed', err);
      activeId.current = null;
      setRunning(false);
      setPhase(null);
    }
  }, [sources, target, op, year, month, day, activeTypeIds, settings.organizeFilters.minSize, settings.organizeFilters.ignoreMacosFiles]);

  const cancel = useCallback(async () => {
    if (!activeId.current) return;
    try {
      await invoke('cancel_organize', { organizeId: activeId.current });
    } catch (err) {
      console.error('cancel_organize failed', err);
    }
  }, []);

  useEffect(() => {
    let unlistenProgress: UnlistenFn | undefined;
    let unlistenComplete: UnlistenFn | undefined;

    listen<OrganizeProgressEvent>('organize://progress', (e) => {
      if (e.payload.organizeId !== activeId.current) return;
      const p = e.payload.progress;
      setPhase(p.phase);
      setProcessed(p.processed);
      setTotal(p.total);
      setCurrentPath(p.currentPath);
    }).then((u) => (unlistenProgress = u));

    listen<OrganizeCompleteEvent>('organize://complete', (e) => {
      if (e.payload.organizeId !== activeId.current) return;
      setCompletion(e.payload.result);
      setRunning(false);
      setPhase(null);
      activeId.current = null;
    }).then((u) => (unlistenComplete = u));

    return () => {
      unlistenProgress?.();
      unlistenComplete?.();
    };
  }, []);

  const progressPct = useMemo(() => {
    if (phase === 'walking') return Math.min(20, 20 * (1 - Math.exp(-processed / 2000)));
    if (phase === 'organizing') {
      if (total === 0) return 100;
      return 20 + (processed / total) * 80;
    }
    return 0;
  }, [phase, processed, total]);

  const canStart = sources.length > 0 && target && activeTypeIds.length > 0 && !running;

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
            {activeTypeIds.length} of {FILTER_TYPE_PRESETS.length} types
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {FILTER_TYPE_PRESETS.map((ft) => {
            const active = activeTypeIds.includes(ft.id);
            return (
              <button
                key={ft.id}
                onClick={() => toggleType(ft.id)}
                disabled={running}
                className={`inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full border transition-all duration-200 cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed ${
                  active
                    ? 'border-[#f5c542] bg-[#f5c542]/15 text-[#f5c542]'
                    : 'border-white/10 text-white/50 hover:border-white/20'
                }`}
              >
                <i className={`${ft.icon} text-sm`}></i>
                {ft.label}
              </button>
            );
          })}
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

      {/* Progress */}
      {running && (
        <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-5 mb-6">
          <div className="flex items-center justify-between mb-3">
            <span className="text-white text-sm font-medium">
              {phase === 'walking'
                ? 'Discovering files'
                : phase === 'organizing'
                  ? `${op === 'copy' ? 'Copying' : 'Moving'} files`
                  : 'Working…'}
            </span>
            <span className="text-[#f5c542] text-sm font-semibold">
              {Math.round(progressPct)}%
            </span>
          </div>
          <div className="h-3 bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full bg-[#f5c542] transition-all duration-150"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="flex items-center justify-between mt-3 gap-4">
            <p className="text-white/40 text-xs font-mono truncate">
              {currentPath ?? (phase === 'walking' ? 'Walking directories…' : 'Preparing…')}
            </p>
            <p className="text-white/40 text-xs font-mono shrink-0">
              {phase === 'walking'
                ? `${processed.toLocaleString()} found`
                : `${processed.toLocaleString()} / ${total.toLocaleString()}`}
            </p>
          </div>
        </div>
      )}

      {/* Completion modal */}
      {completion && (
        <CompletionModal
          result={completion}
          op={op}
          onClose={() => setCompletion(null)}
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
  result: OrganizeCompleteEvent['result'];
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
              <p className="text-white text-2xl font-bold">{result.skipped.toLocaleString()}</p>
              <p className="text-white/40 text-xs mt-1">Skipped (duplicates)</p>
            </div>
            <div className="bg-[#2c1810] rounded-xl border border-white/10 p-4 text-center">
              <p className="text-white text-2xl font-bold">{result.processed.toLocaleString()}</p>
              <p className="text-white/40 text-xs mt-1">Processed</p>
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
