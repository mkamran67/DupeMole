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
import type { CollisionEvent } from '../pages/app/components/CollisionPromptModal';

export type OrganizeOp = 'copy' | 'move';
export type OrganizePhase = 'walking' | 'organizing';

export interface OrganizeStartArgs {
  sources: string[];
  target: string;
  op: OrganizeOp;
  granularity: { year: boolean; month: boolean; day: boolean };
  extensions: string[] | null;
  minSize: number | null;
  maxSize: number | null;
  ignoreMacosFiles: boolean;
  writeFilenameDate: boolean;
  skipImagesWithExistingDate: boolean;
}

export interface OrganizeCompleteResult {
  processed: number;
  copied: number;
  moved: number;
  skippedIdentical: number;
  skippedByUser: number;
  overwritten: number;
  renamed: number;
  metadataWritten: number;
  metadataWriteFailed: number;
  errors: { path: string; reason: string }[];
  cancelled: boolean;
  target: string;
}

interface OrganizeProgressEvent {
  organizeId: string;
  progress: {
    processed: number;
    total: number;
    currentPath: string | null;
    phase: OrganizePhase;
    bytesProcessed?: number;
    elapsedMs?: number;
    currentFileBytes?: number;
    currentFileTotal?: number;
  };
}

interface OrganizeCompleteEvent {
  organizeId: string;
  result: OrganizeCompleteResult;
}

export interface OrganizeContextValue {
  running: boolean;
  progress: number;
  phase: OrganizePhase | null;
  processed: number;
  total: number;
  currentPath: string | null;
  op: OrganizeOp | null;
  speedBytesPerSec: number | null;
  currentFileBytes: number | null;
  currentFileTotal: number | null;
  startOrganize: (args: OrganizeStartArgs) => Promise<string | null>;
  cancelOrganize: () => Promise<void>;
  onProgress: (cb: (e: OrganizeProgressEvent['progress']) => void) => () => void;
  onComplete: (cb: (r: OrganizeCompleteResult) => void) => () => void;
  onCollision: (cb: (e: CollisionEvent) => void) => () => void;
}

export const OrganizeContext = createContext<OrganizeContextValue | null>(null);

export function OrganizeProvider({ children }: { children: ReactNode }) {
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<OrganizePhase | null>(null);
  const [processed, setProcessed] = useState(0);
  const [total, setTotal] = useState(0);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [op, setOp] = useState<OrganizeOp | null>(null);
  const [speedBytesPerSec, setSpeedBytesPerSec] = useState<number | null>(null);
  const [currentFileBytes, setCurrentFileBytes] = useState<number | null>(null);
  const [currentFileTotal, setCurrentFileTotal] = useState<number | null>(null);
  // Sliding window of recent (bytes, ms) samples used to smooth speed across
  // chunk-level emits. Last 1s worth of data.
  const speedWindow = useRef<{ bytes: number; ms: number }[]>([]);

  const activeId = useRef<string | null>(null);
  const progressSubs = useRef<Set<(e: OrganizeProgressEvent['progress']) => void>>(
    new Set()
  );
  const completeSubs = useRef<Set<(r: OrganizeCompleteResult) => void>>(new Set());
  const collisionSubs = useRef<Set<(e: CollisionEvent) => void>>(new Set());

  const onProgress = useCallback(
    (cb: (e: OrganizeProgressEvent['progress']) => void) => {
      progressSubs.current.add(cb);
      return () => {
        progressSubs.current.delete(cb);
      };
    },
    []
  );
  const onComplete = useCallback((cb: (r: OrganizeCompleteResult) => void) => {
    completeSubs.current.add(cb);
    return () => {
      completeSubs.current.delete(cb);
    };
  }, []);
  const onCollision = useCallback((cb: (e: CollisionEvent) => void) => {
    collisionSubs.current.add(cb);
    return () => {
      collisionSubs.current.delete(cb);
    };
  }, []);

  useEffect(() => {
    let unP: UnlistenFn | undefined;
    let unC: UnlistenFn | undefined;
    let unX: UnlistenFn | undefined;

    listen<OrganizeProgressEvent>('organize://progress', (e) => {
      if (e.payload.organizeId !== activeId.current) return;
      const p = e.payload.progress;
      setPhase(p.phase);
      setProcessed(p.processed);
      setTotal(p.total);
      setCurrentPath(p.currentPath);
      setCurrentFileBytes(
        typeof p.currentFileBytes === 'number' ? p.currentFileBytes : null
      );
      setCurrentFileTotal(
        typeof p.currentFileTotal === 'number' ? p.currentFileTotal : null
      );
      if (
        p.phase === 'organizing' &&
        typeof p.bytesProcessed === 'number' &&
        typeof p.elapsedMs === 'number'
      ) {
        const WINDOW_MS = 1000;
        const sample = { bytes: p.bytesProcessed, ms: p.elapsedMs };
        const window = speedWindow.current;
        window.push(sample);
        // Drop samples older than WINDOW_MS relative to the latest one.
        while (window.length > 1 && sample.ms - window[0].ms > WINDOW_MS) {
          window.shift();
        }
        if (window.length >= 2) {
          const oldest = window[0];
          const dB = sample.bytes - oldest.bytes;
          const dMs = sample.ms - oldest.ms;
          if (dMs > 0 && dB >= 0) {
            setSpeedBytesPerSec((dB / dMs) * 1000);
          }
        }
      } else {
        speedWindow.current = [];
        setSpeedBytesPerSec(null);
      }
      progressSubs.current.forEach((cb) => cb(p));
    }).then((u) => (unP = u));

    listen<OrganizeCompleteEvent>('organize://complete', (e) => {
      if (e.payload.organizeId !== activeId.current) return;
      setRunning(false);
      setPhase(null);
      setCurrentPath(null);
      setSpeedBytesPerSec(null);
      setCurrentFileBytes(null);
      setCurrentFileTotal(null);
      speedWindow.current = [];
      activeId.current = null;
      completeSubs.current.forEach((cb) => cb(e.payload.result));
    }).then((u) => (unC = u));

    listen<CollisionEvent>('organize://collision', (e) => {
      if (e.payload.organizeId !== activeId.current) return;
      collisionSubs.current.forEach((cb) => cb(e.payload));
    }).then((u) => (unX = u));

    return () => {
      unP?.();
      unC?.();
      unX?.();
    };
  }, []);

  const progress = useMemo(() => {
    if (phase === 'walking') return Math.min(20, 20 * (1 - Math.exp(-processed / 2000)));
    if (phase === 'organizing') {
      if (total === 0) return 100;
      return 20 + (processed / total) * 80;
    }
    return 0;
  }, [phase, processed, total]);

  const startOrganize = useCallback(async (args: OrganizeStartArgs) => {
    setRunning(true);
    setPhase('walking');
    setProcessed(0);
    setTotal(0);
    setCurrentPath(null);
    setOp(args.op);
    setSpeedBytesPerSec(null);
    setCurrentFileBytes(null);
    setCurrentFileTotal(null);
    speedWindow.current = [];

    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `org-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    activeId.current = id;
    try {
      await invoke<string>('start_organize', {
        organizeId: id,
        sources: args.sources,
        target: args.target,
        op: args.op,
        granularity: args.granularity,
        extensions: args.extensions,
        minSize: args.minSize,
        maxSize: args.maxSize,
        ignoreMacosFiles: args.ignoreMacosFiles,
        writeFilenameDate: args.writeFilenameDate,
        skipImagesWithExistingDate: args.skipImagesWithExistingDate,
      });
      return id;
    } catch (err) {
      console.error('start_organize failed', err);
      activeId.current = null;
      setRunning(false);
      setPhase(null);
      return null;
    }
  }, []);

  const cancelOrganize = useCallback(async () => {
    if (!activeId.current) return;
    try {
      await invoke('cancel_organize', { organizeId: activeId.current });
    } catch (err) {
      console.error('cancel_organize failed', err);
    }
  }, []);

  const value = useMemo<OrganizeContextValue>(
    () => ({
      running,
      progress,
      phase,
      processed,
      total,
      currentPath,
      op,
      speedBytesPerSec,
      currentFileBytes,
      currentFileTotal,
      startOrganize,
      cancelOrganize,
      onProgress,
      onComplete,
      onCollision,
    }),
    [
      running,
      progress,
      phase,
      processed,
      total,
      currentPath,
      op,
      speedBytesPerSec,
      currentFileBytes,
      currentFileTotal,
      startOrganize,
      cancelOrganize,
      onProgress,
      onComplete,
      onCollision,
    ]
  );

  return (
    <OrganizeContext.Provider value={value}>{children}</OrganizeContext.Provider>
  );
}

export function useOrganize() {
  const ctx = useContext(OrganizeContext);
  if (!ctx) throw new Error('useOrganize must be used inside OrganizeProvider');
  return ctx;
}
