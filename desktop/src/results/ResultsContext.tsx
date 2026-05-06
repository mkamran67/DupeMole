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

interface ResultsContextValue {
  latestScan: ScanComplete | null;
  loaded: boolean;
  setLatestScan: (scan: ScanComplete | null) => void;
  pruneScan: (deletedPaths: string[]) => Promise<void>;
}

const ResultsContext = createContext<ResultsContextValue | null>(null);

export function ResultsProvider({ children }: { children: ReactNode }) {
  const [latestScan, setLatestScan] = useState<ScanComplete | null>(null);
  const [loaded, setLoaded] = useState(false);

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
    () => ({ latestScan, loaded, setLatestScan, pruneScan }),
    [latestScan, loaded, pruneScan]
  );

  return <ResultsContext.Provider value={value}>{children}</ResultsContext.Provider>;
}

export function useResults() {
  const ctx = useContext(ResultsContext);
  if (!ctx) throw new Error('useResults must be used inside ResultsProvider');
  return ctx;
}
