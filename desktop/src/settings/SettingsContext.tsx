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

export type ScanThreads = 'Auto' | { N: number };

export interface AppFilters {
  extensions: string[] | null;
  ignoredExtensions: string[];
  ignoredFolders: string[];
  minSize: number | null;
  maxSize: number | null;
  modifiedAfterMs: number | null;
  modifiedBeforeMs: number | null;
  includeSubdirs: boolean;
}

export const DEFAULT_FILTERS: AppFilters = {
  extensions: null,
  ignoredExtensions: [],
  ignoredFolders: [],
  minSize: null,
  maxSize: null,
  modifiedAfterMs: null,
  modifiedBeforeMs: null,
  includeSubdirs: true,
};

export interface AppSettings {
  confirmDelete: boolean;
  moveToTrash: boolean;
  scanThreads: ScanThreads;
  notifications: boolean;
  ignoreHidden: boolean;
  autoScan: boolean;
  minimizeTray: boolean;
  language: string;
  filters: AppFilters;
  useMetadataDates: boolean;
}

const DEFAULTS: AppSettings = {
  confirmDelete: true,
  moveToTrash: true,
  scanThreads: 'Auto',
  notifications: true,
  ignoreHidden: false,
  autoScan: false,
  minimizeTray: true,
  language: 'English',
  filters: DEFAULT_FILTERS,
  useMetadataDates: false,
};

interface SettingsContextValue {
  settings: AppSettings;
  loaded: boolean;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  updateFilters: (patch: Partial<AppFilters>) => Promise<void>;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    invoke<AppSettings>('get_settings')
      .then((s) => {
        if (!cancelled) {
          setSettings({ ...s, filters: { ...DEFAULT_FILTERS, ...(s.filters ?? {}) } });
          setLoaded(true);
        }
      })
      .catch((err) => {
        console.error('failed to load settings', err);
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      const merged = { ...settings, ...patch };
      await invoke('update_settings', { new: merged });
      setSettings(merged);
    },
    [settings]
  );

  const updateFilters = useCallback(
    async (patch: Partial<AppFilters>) => {
      const merged: AppSettings = {
        ...settings,
        filters: { ...settings.filters, ...patch },
      };
      await invoke('update_settings', { new: merged });
      setSettings(merged);
    },
    [settings]
  );

  const value = useMemo(
    () => ({ settings, loaded, updateSettings, updateFilters }),
    [settings, loaded, updateSettings, updateFilters]
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used inside SettingsProvider');
  return ctx;
}
