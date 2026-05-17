import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useResults } from '../results/ResultsContext';

export type ScanPhase = 'discovery' | 'hashing' | 'verifying' | 'finalizing';

interface ScanProgressEvent {
  scanId: string;
  progress: {
    processed: number;
    total: number;
    currentPath: string | null;
    phase: ScanPhase;
    folderIndex?: number;
    folderTotal?: number;
    folderPath?: string | null;
  };
}

interface BackendDuplicateGroup {
  id: string;
  hash: string;
  size: number;
  hashKind: 'full' | 'partial';
  files: { path: string; size: number; modifiedMs: number | null }[];
}

interface ScanCompleteEvent {
  scanId: string;
  result: {
    groups: BackendDuplicateGroup[];
    totalFiles: number;
    duplicateFiles: number;
    wastedBytes: number;
    extensionCounts: Record<string, number>;
  };
}

export interface ScanProgressSnapshot {
  processed: number;
  total: number;
  currentPath: string | null;
  phase: ScanPhase;
  folderIndex: number | null;
  folderTotal: number | null;
  weightedPct: number;
}

export interface ScanContextValue {
  scanning: boolean;
  progress: number;
  phase: ScanPhase | null;
  phaseProcessed: number;
  phaseTotal: number;
  currentPath: string | null;
  etaSeconds: number | null;
  folderIndex: number | null;
  folderTotal: number | null;
  startScan: (paths: string[]) => Promise<string | null>;
  cancelScan: () => Promise<void>;
  onProgress: (cb: (s: ScanProgressSnapshot) => void) => () => void;
  onComplete: (
    cb: (r: ScanCompleteEvent['result']) => void
  ) => () => void;
}

export const ScanContext = createContext<ScanContextValue | null>(null);

export function ScanProvider({ children }: { children: ReactNode }) {
  const { setLatestScan } = useResults();

  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState<ScanPhase | null>(null);
  const [phaseProcessed, setPhaseProcessed] = useState(0);
  const [phaseTotal, setPhaseTotal] = useState(0);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const [folderIndex, setFolderIndex] = useState<number | null>(null);
  const [folderTotal, setFolderTotal] = useState<number | null>(null);

  const activeScanId = useRef<string | null>(null);
  const scanStartTime = useRef<number>(0);
  const etaRef = useRef<number | null>(null);

  const progressSubs = useRef<Set<(s: ScanProgressSnapshot) => void>>(new Set());
  const completeSubs = useRef<Set<(r: ScanCompleteEvent['result']) => void>>(
    new Set()
  );

  const onProgress = useCallback(
    (cb: (s: ScanProgressSnapshot) => void) => {
      progressSubs.current.add(cb);
      return () => {
        progressSubs.current.delete(cb);
      };
    },
    []
  );

  const onComplete = useCallback(
    (cb: (r: ScanCompleteEvent['result']) => void) => {
      completeSubs.current.add(cb);
      return () => {
        completeSubs.current.delete(cb);
      };
    },
    []
  );

  useEffect(() => {
    let unlistenProgress: UnlistenFn | undefined;
    let unlistenComplete: UnlistenFn | undefined;

    listen<ScanProgressEvent>('scan://progress', (e) => {
      if (e.payload.scanId !== activeScanId.current) return;
      const {
        processed,
        total,
        phase: ph,
        currentPath: cp,
        folderIndex: fi,
        folderTotal: ft,
      } = e.payload.progress;
      setPhase(ph);
      setPhaseProcessed(processed);
      setPhaseTotal(total);
      setCurrentPath(cp);
      setFolderIndex(fi ?? null);
      setFolderTotal(ft ?? null);

      const folderFrac =
        fi !== undefined && ft && ft > 0 ? Math.min(1, fi / ft) : 0;
      const withinFolderAsymptote = 1 - Math.exp(-processed / 5000);
      const folderSpan = ft && ft > 0 ? 1 / ft : 1;

      let pct: number;
      if (ph === 'discovery') {
        pct = 30 * (folderFrac + withinFolderAsymptote * folderSpan);
      } else if (ph === 'hashing') {
        pct = 30 + (total > 0 ? processed / total : 0) * 50;
      } else if (ph === 'verifying') {
        pct = 80 + (total > 0 ? processed / total : 0) * 12;
      } else {
        pct = 92 + (total > 0 ? processed / total : 0) * 7;
      }
      const clamped = Math.max(0, Math.min(99, pct));
      setProgress(clamped);

      const MIN_PROGRESS_FOR_ETA = 5;
      if (clamped >= MIN_PROGRESS_FOR_ETA) {
        const elapsed = (Date.now() - scanStartTime.current) / 1000;
        const rawEta = (elapsed * (100 - clamped)) / clamped;
        const alpha = 0.2;
        const prev = etaRef.current;
        const smoothed = prev === null ? rawEta : alpha * rawEta + (1 - alpha) * prev;
        etaRef.current = smoothed;
        setEtaSeconds(smoothed);
      }

      const snapshot: ScanProgressSnapshot = {
        processed,
        total,
        currentPath: cp,
        phase: ph,
        folderIndex: fi ?? null,
        folderTotal: ft ?? null,
        weightedPct: clamped,
      };
      progressSubs.current.forEach((cb) => cb(snapshot));
    }).then((u) => (unlistenProgress = u));

    listen<ScanCompleteEvent>('scan://complete', (e) => {
      if (e.payload.scanId !== activeScanId.current) return;
      const { result } = e.payload;
      setEtaSeconds(null);
      etaRef.current = null;
      setLatestScan({
        groups: result.groups,
        totalFiles: result.totalFiles,
        duplicateFiles: result.duplicateFiles,
        wastedBytes: result.wastedBytes,
        extensionCounts: result.extensionCounts ?? {},
      });
      setProgress(100);
      setPhase(null);
      setCurrentPath(null);
      setScanning(false);
      activeScanId.current = null;
      completeSubs.current.forEach((cb) => cb(result));
    }).then((u) => (unlistenComplete = u));

    return () => {
      unlistenProgress?.();
      unlistenComplete?.();
    };
  }, [setLatestScan]);

  const startScan = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return null;
    setScanning(true);
    setProgress(0);
    setPhase('discovery');
    setPhaseProcessed(0);
    setPhaseTotal(0);
    setCurrentPath(null);
    setEtaSeconds(null);
    etaRef.current = null;
    setFolderIndex(null);
    setFolderTotal(null);
    scanStartTime.current = Date.now();

    const scanId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `scan-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    activeScanId.current = scanId;
    try {
      await invoke<string>('start_scan', { paths, scanId });
      return scanId;
    } catch (err) {
      console.error('start_scan failed', err);
      activeScanId.current = null;
      setScanning(false);
      return null;
    }
  }, []);

  const cancelScan = useCallback(async () => {
    if (!activeScanId.current) return;
    try {
      await invoke('cancel_scan', { scanId: activeScanId.current });
    } catch (err) {
      console.error('cancel_scan failed', err);
    }
  }, []);

  const value = useMemo<ScanContextValue>(
    () => ({
      scanning,
      progress,
      phase,
      phaseProcessed,
      phaseTotal,
      currentPath,
      etaSeconds,
      folderIndex,
      folderTotal,
      startScan,
      cancelScan,
      onProgress,
      onComplete,
    }),
    [
      scanning,
      progress,
      phase,
      phaseProcessed,
      phaseTotal,
      currentPath,
      etaSeconds,
      folderIndex,
      folderTotal,
      startScan,
      cancelScan,
      onProgress,
      onComplete,
    ]
  );

  return <ScanContext.Provider value={value}>{children}</ScanContext.Provider>;
}

export function useScan() {
  const ctx = useContext(ScanContext);
  if (!ctx) throw new Error('useScan must be used inside ScanProvider');
  return ctx;
}

export function formatEta(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
