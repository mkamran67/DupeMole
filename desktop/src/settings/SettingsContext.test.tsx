import { describe, it, expect } from 'vitest';
import { migrateSettings, DEFAULT_FILTERS } from './SettingsContext';

describe('migrateSettings', () => {
  it('copies legacy filters into both scan and organize filter slots', () => {
    const legacy = {
      filters: {
        ...DEFAULT_FILTERS,
        ignoredFolders: ['node_modules'],
        minSize: 4096,
      },
    } as Parameters<typeof migrateSettings>[0];
    const out = migrateSettings(legacy);
    expect(out.scanFilters.ignoredFolders).toEqual(['node_modules']);
    expect(out.scanFilters.minSize).toBe(4096);
    expect(out.organizeFilters.ignoredFolders).toEqual(['node_modules']);
    expect(out.organizeFilters.minSize).toBe(4096);
  });

  it('uses explicit scanFilters/organizeFilters when present', () => {
    const out = migrateSettings({
      scanFilters: { ...DEFAULT_FILTERS, minSize: 100 },
      organizeFilters: { ...DEFAULT_FILTERS, minSize: 200 },
    } as Parameters<typeof migrateSettings>[0]);
    expect(out.scanFilters.minSize).toBe(100);
    expect(out.organizeFilters.minSize).toBe(200);
  });

  it('uses defaults when neither legacy nor new fields present', () => {
    const out = migrateSettings({} as Parameters<typeof migrateSettings>[0]);
    expect(out.scanFilters).toEqual(DEFAULT_FILTERS);
    expect(out.organizeFilters).toEqual(DEFAULT_FILTERS);
  });

  it('drops the legacy filters key from migrated output', () => {
    const out = migrateSettings({
      filters: { ...DEFAULT_FILTERS, minSize: 1 },
    } as Parameters<typeof migrateSettings>[0]) as unknown as Record<string, unknown>;
    expect(out.filters).toBeUndefined();
  });
});
