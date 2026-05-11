import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { formatBytes, basename, formatDate } from '../../../lib/format';
import FilterPanel from './FilterPanel';
import DirectoryRow from './DirectoryRow';

interface Directory {
  id: number;
  name: string;
  path: string;
}

interface ExtensionStat {
  extension: string;
  count: number;
  totalBytes: number;
}

interface SizeBucket {
  label: string;
  minBytes: number;
  maxBytes: number | null;
  count: number;
  totalBytes: number;
}

interface AgeBucket {
  label: string;
  count: number;
}

interface AnalysisReport {
  totalFiles: number;
  totalBytes: number;
  largestFile: { path: string; size: number } | null;
  smallestFile: { path: string; size: number } | null;
  averageBytes: number;
  medianBytes: number;
  oldestModifiedMs: number | null;
  newestModifiedMs: number | null;
  extensions: ExtensionStat[];
  sizeBuckets: SizeBucket[];
  ageBuckets: AgeBucket[];
}

interface AnalysisCompleteEvent {
  analysisId: string;
  report: AnalysisReport;
}

interface AnalysisProgressEvent {
  analysisId: string;
  progress: {
    processed: number;
    currentPath: string | null;
    folderIndex: number;
    folderTotal: number;
  };
}

const TOP_EXTENSIONS = 15;

function StatCard({
  icon,
  label,
  value,
  hint,
}: {
  icon: string;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="bg-[#3d2418] rounded-2xl p-5 border border-white/10">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-9 h-9 rounded-lg bg-[#f5c542]/10 flex items-center justify-center">
          <i className={`${icon} text-[#f5c542] text-sm`}></i>
        </div>
        <span className="text-white/60 text-sm font-medium">{label}</span>
      </div>
      <p className="text-white text-2xl font-bold truncate">{value}</p>
      {hint && <p className="text-white/30 text-xs mt-1 truncate font-mono">{hint}</p>}
    </div>
  );
}

function HorizontalBar({
  label,
  count,
  total,
  right,
}: {
  label: string;
  count: number;
  total: number;
  right?: string;
}) {
  const pct = total > 0 ? Math.max(0, Math.min(100, (count / total) * 100)) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-white/70 font-medium">{label}</span>
        <span className="text-white/40 font-mono">
          {count.toLocaleString()}
          {right ? ` · ${right}` : ''}
        </span>
      </div>
      <div className="h-2 bg-white/10 rounded-full overflow-hidden">
        <div
          className="h-full bg-[#f5c542] rounded-full transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export default function AnalysisView() {
  const [directories, setDirectories] = useState<Directory[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [processed, setProcessed] = useState(0);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const activeId = useRef<string | null>(null);
  const reportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (report && typeof reportRef.current?.scrollIntoView === 'function') {
      reportRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [report]);

  useEffect(() => {
    let unlistenProgress: UnlistenFn | undefined;
    let unlistenComplete: UnlistenFn | undefined;
    listen<AnalysisProgressEvent>('analysis://progress', (e) => {
      if (e.payload.analysisId !== activeId.current) return;
      setProcessed(e.payload.progress.processed);
      setCurrentPath(e.payload.progress.currentPath);
    }).then((u) => (unlistenProgress = u));
    listen<AnalysisCompleteEvent>('analysis://complete', (e) => {
      if (e.payload.analysisId !== activeId.current) return;
      setReport(e.payload.report);
      setAnalyzing(false);
      setCurrentPath(null);
      activeId.current = null;
    }).then((u) => (unlistenComplete = u));
    return () => {
      unlistenProgress?.();
      unlistenComplete?.();
    };
  }, []);

  const addDirectory = (path: string) => {
    setDirectories((prev) => {
      if (prev.some((d) => d.path === path)) return prev;
      return [
        ...prev,
        {
          id: Date.now() + Math.floor(Math.random() * 1000),
          name: basename(path),
          path,
        },
      ];
    });
  };

  const removeDirectory = (id: number) =>
    setDirectories((prev) => prev.filter((d) => d.id !== id));

  const handleBrowse = useCallback(async () => {
    try {
      const selected = await openDialog({ directory: true, multiple: true });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      paths.forEach((p) => addDirectory(p));
    } catch (err) {
      console.error('folder picker failed', err);
    }
  }, []);

  const startAnalysis = useCallback(async () => {
    if (directories.length === 0) return;
    setAnalyzing(true);
    setReport(null);
    setProcessed(0);
    setCurrentPath(null);
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `analysis-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    activeId.current = id;
    try {
      await invoke<string>('start_analysis', {
        paths: directories.map((d) => d.path),
        analysisId: id,
      });
    } catch (err) {
      console.error('start_analysis failed', err);
      activeId.current = null;
      setAnalyzing(false);
    }
  }, [directories]);

  const cancelAnalysis = useCallback(async () => {
    if (!activeId.current) return;
    try {
      await invoke('cancel_analysis', { analysisId: activeId.current });
    } catch (err) {
      console.error('cancel_analysis failed', err);
    }
  }, []);

  const topExtensions = report
    ? report.extensions.slice(0, TOP_EXTENSIONS)
    : [];
  const otherExtensions = report
    ? report.extensions.slice(TOP_EXTENSIONS).reduce(
        (acc, e) => ({ count: acc.count + e.count, totalBytes: acc.totalBytes + e.totalBytes }),
        { count: 0, totalBytes: 0 },
      )
    : { count: 0, totalBytes: 0 };

  return (
    <div className="min-h-full flex flex-col relative pb-12 md:pb-16">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-white text-2xl font-bold tracking-tight">Analysis</h2>
          <p className="text-white/40 text-sm mt-1">
            Walk a directory and aggregate stats on every file — no hashing, just counts and sizes.
          </p>
        </div>
        {analyzing ? (
          <button
            onClick={cancelAnalysis}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 cursor-pointer whitespace-nowrap bg-[#c45c5c] text-white hover:bg-[#a84848]"
          >
            <i className="ri-stop-circle-line"></i>
            Cancel
          </button>
        ) : (
          <button
            onClick={startAnalysis}
            disabled={directories.length === 0}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 cursor-pointer whitespace-nowrap ${
              directories.length === 0
                ? 'bg-white/10 text-white/30 cursor-not-allowed'
                : 'bg-[#f5c542] text-[#2c1810] hover:bg-[#e0b038]'
            }`}
          >
            <i className="ri-bar-chart-2-line"></i>
            Start Analysis
          </button>
        )}
      </div>

      <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <p className="text-white/30 text-xs font-semibold uppercase tracking-wider">
            Directories to Analyse
          </p>
          <button
            onClick={handleBrowse}
            className="text-[#f5c542] hover:text-[#e0b038] text-xs font-medium cursor-pointer"
          >
            <i className="ri-add-line mr-1"></i>
            Add folder
          </button>
        </div>
        {directories.length === 0 ? (
          <div className="text-center py-10 text-white/30 text-sm">
            Add a folder to begin. Defaults scan everything except hidden files.
          </div>
        ) : (
          <div className="space-y-3 pb-2">
            {directories.map((dir) => (
              <DirectoryRow
                key={dir.id}
                name={dir.name}
                files={0}
                progress={analyzing ? 50 : report ? 100 : 0}
                scanned={!analyzing && !!report}
                scanning={analyzing}
                onRemove={() => removeDirectory(dir.id)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-5 mb-6">
        <p className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-4">
          Filters
        </p>
        <FilterPanel kind="analysis" />
      </div>

      {analyzing && (
        <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-5 mb-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-white text-sm font-medium">Analysing files…</span>
            <span className="text-[#f5c542] text-sm font-semibold font-mono">
              {processed.toLocaleString()} found
            </span>
          </div>
          <p className="text-white/40 text-xs font-mono truncate">
            {currentPath ?? 'Walking directories…'}
          </p>
        </div>
      )}

      {report && <div ref={reportRef} aria-hidden className="scroll-mt-4" />}

      {report && report.totalFiles === 0 && (
        <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-10 text-center mb-6">
          <p className="text-white/60 text-sm">No files matched the current filters.</p>
          <p className="text-white/30 text-xs mt-2">
            Try turning off "ignore hidden" or removing extension restrictions.
          </p>
        </div>
      )}

      {report && report.totalFiles > 0 && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
            <StatCard
              icon="ri-stack-line"
              label="Total files"
              value={report.totalFiles.toLocaleString()}
              hint={formatBytes(report.totalBytes) + ' total'}
            />
            <StatCard
              icon="ri-arrow-up-line"
              label="Largest file"
              value={report.largestFile ? formatBytes(report.largestFile.size) : '—'}
              hint={report.largestFile ? basename(report.largestFile.path) : undefined}
            />
            <StatCard
              icon="ri-arrow-down-line"
              label="Smallest file"
              value={report.smallestFile ? formatBytes(report.smallestFile.size) : '—'}
              hint={report.smallestFile ? basename(report.smallestFile.path) : undefined}
            />
            <StatCard
              icon="ri-equalizer-line"
              label="Average size"
              value={formatBytes(report.averageBytes)}
            />
            <StatCard
              icon="ri-line-chart-line"
              label="Median size"
              value={formatBytes(report.medianBytes)}
            />
            <StatCard
              icon="ri-calendar-line"
              label="Date range"
              value={
                report.oldestModifiedMs && report.newestModifiedMs
                  ? `${formatDate(report.oldestModifiedMs).split(',')[0]} → ${formatDate(report.newestModifiedMs).split(',')[0]}`
                  : '—'
              }
            />
          </div>

          <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-5 mb-6">
            <p className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-4">
              File types
            </p>
            <div className="space-y-3">
              {topExtensions.map((e) => (
                <div key={e.extension} className="flex items-center justify-between text-sm">
                  <span className="text-white font-medium font-mono">
                    {e.extension ? e.extension.toUpperCase() : '(no ext)'}
                  </span>
                  <div className="flex items-center gap-4 text-xs">
                    <span className="text-white/60 font-mono">
                      {e.count.toLocaleString()} files
                    </span>
                    <span className="text-white/40 font-mono w-24 text-right">
                      {formatBytes(e.totalBytes)}
                    </span>
                  </div>
                </div>
              ))}
              {otherExtensions.count > 0 && (
                <div className="flex items-center justify-between text-sm pt-2 border-t border-white/5">
                  <span className="text-white/60 font-medium">Other</span>
                  <div className="flex items-center gap-4 text-xs">
                    <span className="text-white/60 font-mono">
                      {otherExtensions.count.toLocaleString()} files
                    </span>
                    <span className="text-white/40 font-mono w-24 text-right">
                      {formatBytes(otherExtensions.totalBytes)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-6">
            <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-5">
              <p className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-4">
                Size distribution
              </p>
              <div className="space-y-3">
                {report.sizeBuckets.map((b) => (
                  <HorizontalBar
                    key={b.label}
                    label={b.label}
                    count={b.count}
                    total={report.totalFiles}
                    right={formatBytes(b.totalBytes)}
                  />
                ))}
              </div>
            </div>

            <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-5">
              <p className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-4">
                Age distribution
              </p>
              <div className="space-y-3">
                {report.ageBuckets.map((b) => (
                  <HorizontalBar
                    key={b.label}
                    label={b.label}
                    count={b.count}
                    total={report.totalFiles}
                  />
                ))}
              </div>
            </div>
          </div>
        </>
      )}

    </div>
  );
}
