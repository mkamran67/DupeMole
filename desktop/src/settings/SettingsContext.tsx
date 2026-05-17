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
  /** Per-scope override of the global ignoreHidden setting. When undefined,
   *  consumers fall back to settings.ignoreHidden. Analysis defaults to true. */
  ignoreHidden?: boolean;
  /** Organize-only: when true and a file lacks "date taken" metadata but
   *  has a parseable date in its filename, write that date into the image
   *  EXIF before placing it. Unwritable formats (RAW/BMP/GIF/AVIF/SVG)
   *  get routed to MetadataWriteFailed/ for later retry. Ignored on the
   *  scan and analysis pages. */
  writeFilenameDateMetadata?: boolean;
  /** Organize-only sub-option of writeFilenameDateMetadata: when true,
   *  skip images that already have a date-taken EXIF tag entirely (leave
   *  them in source, do not move/copy). Only meaningful when
   *  writeFilenameDateMetadata is also true. */
  skipImagesWithExistingDate?: boolean;
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

export const DEFAULT_ANALYSIS_FILTERS: AppFilters = {
  ...DEFAULT_FILTERS,
  ignoreHidden: true,
};

export function isMacos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  return /Mac/i.test(platform) || /Mac OS X|Macintosh/i.test(ua);
}

export interface CustomFileType {
  /** Stable id (uuid or slug) used when persisting + toggling. */
  id: string;
  /** User-given label shown on the chip. */
  label: string;
  /** Extensions (no leading dot, case-insensitive when matched). */
  formats: string[];
}

export interface AppSettings {
  confirmDelete: boolean;
  scanThreads: ScanThreads;
  notifications: boolean;
  ignoreHidden: boolean;
  autoScan: boolean;
  minimizeTray: boolean;
  language: string;
  scanFilters: AppFilters;
  organizeFilters: AppFilters;
  analysisFilters: AppFilters;
  customFileTypes: CustomFileType[];
}

const DEFAULTS: AppSettings = {
  confirmDelete: true,
  scanThreads: 'Auto',
  notifications: true,
  ignoreHidden: false,
  autoScan: false,
  minimizeTray: true,
  language: 'English',
  scanFilters: DEFAULT_FILTERS,
  organizeFilters: DEFAULT_FILTERS,
  analysisFilters: DEFAULT_ANALYSIS_FILTERS,
  customFileTypes: [],
};

interface SettingsContextValue {
  settings: AppSettings;
  loaded: boolean;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  updateScanFilters: (patch: Partial<AppFilters>) => Promise<void>;
  updateOrganizeFilters: (patch: Partial<AppFilters>) => Promise<void>;
  updateAnalysisFilters: (patch: Partial<AppFilters>) => Promise<void>;
}

/**
 * Migrate a possibly-legacy settings payload (with a single `filters` field) into
 * the new shape with separate `scanFilters` and `organizeFilters`. Exported for
 * testing.
 */
export function migrateSettings(raw: Partial<AppSettings> & { filters?: Partial<AppFilters> }): AppSettings {
  const legacy = raw.filters;
  const scan = raw.scanFilters ?? legacy ?? DEFAULT_FILTERS;
  const organize = raw.organizeFilters ?? legacy ?? DEFAULT_FILTERS;
  const { filters: _drop, ...rest } = raw;
  void _drop;
  const analysis = raw.analysisFilters ?? DEFAULT_ANALYSIS_FILTERS;
  return {
    ...DEFAULTS,
    ...rest,
    scanFilters: { ...DEFAULT_FILTERS, ...scan },
    organizeFilters: { ...DEFAULT_FILTERS, ...organize },
    analysisFilters: { ...DEFAULT_ANALYSIS_FILTERS, ...analysis },
  } as AppSettings;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    invoke<AppSettings & { filters?: AppFilters }>('get_settings')
      .then((s) => {
        if (cancelled) return;
        let migrated = migrateSettings(s);
        const needsMacosDefault =
          isMacos() &&
          !Object.prototype.hasOwnProperty.call(s.scanFilters ?? s.filters ?? {}, 'ignoreMacosFiles');
        if (needsMacosDefault) {
          migrated = {
            ...migrated,
            scanFilters: { ...migrated.scanFilters, ignoreMacosFiles: true },
            organizeFilters: { ...migrated.organizeFilters, ignoreMacosFiles: true },
          };
        }
        setSettings(migrated);
        setLoaded(true);
        if (needsMacosDefault) {
          invoke('update_settings', { new: migrated }).catch((err) =>
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

  const updateScanFilters = useCallback(
    async (patch: Partial<AppFilters>) => {
      const merged: AppSettings = {
        ...settings,
        scanFilters: { ...settings.scanFilters, ...patch },
      };
      await invoke('update_settings', { new: merged });
      setSettings(merged);
    },
    [settings]
  );

  const updateOrganizeFilters = useCallback(
    async (patch: Partial<AppFilters>) => {
      const merged: AppSettings = {
        ...settings,
        organizeFilters: { ...settings.organizeFilters, ...patch },
      };
      await invoke('update_settings', { new: merged });
      setSettings(merged);
    },
    [settings]
  );

  const updateAnalysisFilters = useCallback(
    async (patch: Partial<AppFilters>) => {
      const merged: AppSettings = {
        ...settings,
        analysisFilters: { ...settings.analysisFilters, ...patch },
      };
      await invoke('update_settings', { new: merged });
      setSettings(merged);
    },
    [settings]
  );

  const value = useMemo(
    () => ({ settings, loaded, updateSettings, updateScanFilters, updateOrganizeFilters, updateAnalysisFilters }),
    [settings, loaded, updateSettings, updateScanFilters, updateOrganizeFilters, updateAnalysisFilters]
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used inside SettingsProvider');
  return ctx;
}
