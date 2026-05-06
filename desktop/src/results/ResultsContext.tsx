import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ScanComplete } from './types';
import { toUiGroup, type UiGroup } from './adapter';

interface ResultsContextValue {
  latestScan: ScanComplete | null;
  loaded: boolean;
  uiGroups: UiGroup[] | null;
  uiGroupsReady: boolean;
  setLatestScan: (scan: ScanComplete | null) => void;
  pruneScan: (deletedPaths: string[]) => Promise<void>;
}

const ResultsContext = createContext<ResultsContextValue | null>(null);

const CHUNK_SIZE = 200;

type IdleScheduler = (cb: () => void) => number;
type IdleCanceler = (handle: number) => void;

const scheduleIdle: IdleScheduler =
  typeof window !== 'undefined' && 'requestIdleCallback' in window
    ? (cb) => (window as unknown as { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback(cb)
    : (cb) => window.setTimeout(cb, 0);

const cancelIdle: IdleCanceler =
  typeof window !== 'undefined' && 'cancelIdleCallback' in window
    ? (h) => (window as unknown as { cancelIdleCallback: (h: number) => void }).cancelIdleCallback(h)
    : (h) => window.clearTimeout(h);

export function ResultsProvider({ children }: { children: ReactNode }) {
  const [latestScan, setLatestScan] = useState<ScanComplete | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [uiGroups, setUiGroups] = useState<UiGroup[] | null>(null);
  const [uiGroupsReady, setUiGroupsReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    invoke<ScanComplete | null>('get_last_scan')
      .then((s) => {
        if (!cancelled) {
          setLatestScan(s ?? null);
          setLoaded(true);
        }
      })
      .catch((err) => {
        console.error('failed to load last scan', err);
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Map backend groups → UI groups in idle-time chunks so the work doesn't
  // freeze the main thread when the user opens the Results tab.
  useEffect(() => {
    if (!latestScan) {
      setUiGroups(null);
      setUiGroupsReady(true);
      return;
    }
    setUiGroups(null);
    setUiGroupsReady(false);

    const source = latestScan.groups;
    const out: UiGroup[] = new Array(source.length);
    let i = 0;
    let handle: number | null = null;
    let cancelled = false;

    const step = () => {
      if (cancelled) return;
      const end = Math.min(i + CHUNK_SIZE, source.length);
      for (; i < end; i++) {
        out[i] = toUiGroup(source[i]);
      }
      if (i < source.length) {
        handle = scheduleIdle(step);
      } else {
        setUiGroups(out);
        setUiGroupsReady(true);
        handle = null;
      }
    };

    handle = scheduleIdle(step);

    return () => {
      cancelled = true;
      if (handle !== null) cancelIdle(handle);
    };
  }, [latestScan]);

  const pruneScan = useCallback(async (deletedPaths: string[]) => {
    if (deletedPaths.length === 0) return;
    try {
      const next = await invoke<ScanComplete | null>('prune_last_scan', {
        deleted: deletedPaths,
      });
      setLatestScan(next ?? null);
    } catch (err) {
      console.error('prune_last_scan failed', err);
    }
  }, []);

  const value = useMemo(
    () => ({ latestScan, loaded, uiGroups, uiGroupsReady, setLatestScan, pruneScan }),
    [latestScan, loaded, uiGroups, uiGroupsReady, pruneScan]
  );

  return <ResultsContext.Provider value={value}>{children}</ResultsContext.Provider>;
}

export function useResults() {
  const ctx = useContext(ResultsContext);
  if (!ctx) throw new Error('useResults must be used inside ResultsProvider');
  return ctx;
}
