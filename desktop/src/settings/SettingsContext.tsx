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
  ignoreMacosFiles: boolean;
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
  ignoreMacosFiles: false,
};

export function isMacos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  return /Mac/i.test(platform) || /Mac OS X|Macintosh/i.test(ua);
}

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
        if (cancelled) return;
        const loadedFilters = s.filters ?? ({} as Partial<AppFilters>);
        const firstRunOnMac =
          isMacos() && !Object.prototype.hasOwnProperty.call(loadedFilters, 'ignoreMacosFiles');
        const mergedFilters: AppFilters = {
          ...DEFAULT_FILTERS,
          ...loadedFilters,
          ...(firstRunOnMac ? { ignoreMacosFiles: true } : {}),
        };
        const merged: AppSettings = { ...s, filters: mergedFilters };
        setSettings(merged);
        setLoaded(true);
        if (firstRunOnMac) {
          invoke('update_settings', { new: merged }).catch((err) =>
            console.error('failed to persist macOS-default filter', err)
          );
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
