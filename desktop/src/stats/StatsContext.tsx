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
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface LifetimeStats {
  totalBytesFreed: number;
  totalFilesDeleted: number;
  totalScansRun: number;
}

const DEFAULTS: LifetimeStats = {
  totalBytesFreed: 0,
  totalFilesDeleted: 0,
  totalScansRun: 0,
};

interface StatsContextValue {
  stats: LifetimeStats;
  refresh: () => Promise<void>;
}

const StatsContext = createContext<StatsContextValue | null>(null);

export function StatsProvider({ children }: { children: ReactNode }) {
  const [stats, setStats] = useState<LifetimeStats>(DEFAULTS);

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<LifetimeStats>('get_stats');
      setStats(s);
    } catch (err) {
      console.error('failed to load stats', err);
    }
  }, []);

  useEffect(() => {
    refresh();
    let unlisten: UnlistenFn | undefined;
    listen('scan://complete', () => {
      refresh();
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => console.error('stats scan listen failed', err));
    return () => {
      unlisten?.();
    };
  }, [refresh]);

  const value = useMemo(() => ({ stats, refresh }), [stats, refresh]);
  return <StatsContext.Provider value={value}>{children}</StatsContext.Provider>;
}

export function useStats() {
  const ctx = useContext(StatsContext);
  if (!ctx) throw new Error('useStats must be used inside StatsProvider');
  return ctx;
}
