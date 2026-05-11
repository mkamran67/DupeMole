import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildExtensionAllowlist,
  deriveActiveTypeIds,
  mergePresets,
  sizePresetLabel,
  datePresetLabel,
  datePresetToAfterMs,
  FILTER_TYPE_PRESETS,
} from './filterPresets';

describe('buildExtensionAllowlist', () => {
  it('returns null when no presets and no custom extensions', () => {
    expect(buildExtensionAllowlist([], '')).toBeNull();
  });

  it('returns lowercased extensions for selected presets', () => {
    const result = buildExtensionAllowlist(['images'], '');
    expect(result).not.toBeNull();
    expect(result).toContain('jpg');
    expect(result).toContain('png');
    // No uppercase entries.
    expect(result!.every((e) => e === e.toLowerCase())).toBe(true);
  });

  it('merges custom extensions, trimming dots and whitespace', () => {
    const result = buildExtensionAllowlist([], '.txt, MD ,csv');
    expect(result).toEqual(expect.arrayContaining(['txt', 'md', 'csv']));
    expect(result).toHaveLength(3);
  });

  it('deduplicates between presets and customs', () => {
    const result = buildExtensionAllowlist(['images'], 'jpg, JPG');
    const jpgCount = result!.filter((e) => e === 'jpg').length;
    expect(jpgCount).toBe(1);
  });

  it('ignores empty custom segments from trailing commas', () => {
    const result = buildExtensionAllowlist([], 'txt,,');
    expect(result).toEqual(['txt']);
  });

  it('skips unknown preset ids silently', () => {
    const result = buildExtensionAllowlist(['nope', 'images'], '');
    expect(result).toContain('jpg');
  });
});

describe('deriveActiveTypeIds', () => {
  it('returns all preset ids when extensions is null', () => {
    const ids = deriveActiveTypeIds(null);
    expect(ids).toEqual(FILTER_TYPE_PRESETS.map((p) => p.id));
  });

  it('returns all preset ids when extensions is undefined', () => {
    expect(deriveActiveTypeIds(undefined)).toEqual(FILTER_TYPE_PRESETS.map((p) => p.id));
  });

  it('returns only fully-covered presets', () => {
    const imagesPreset = FILTER_TYPE_PRESETS.find((p) => p.id === 'images')!;
    const ids = deriveActiveTypeIds(imagesPreset.formats.map((f) => f.toLowerCase()));
    expect(ids).toContain('images');
    expect(ids).not.toContain('videos');
  });

  it('does not consider a preset active if any format is missing', () => {
    const imagesPreset = FILTER_TYPE_PRESETS.find((p) => p.id === 'images')!;
    const partial = imagesPreset.formats.slice(0, -1).map((f) => f.toLowerCase());
    const ids = deriveActiveTypeIds(partial);
    expect(ids).not.toContain('images');
  });

  it('is case-insensitive on input extensions', () => {
    const imagesPreset = FILTER_TYPE_PRESETS.find((p) => p.id === 'images')!;
    const upper = imagesPreset.formats.map((f) => f.toUpperCase());
    expect(deriveActiveTypeIds(upper)).toContain('images');
  });

  it('returns empty array for an unrelated extension list', () => {
    expect(deriveActiveTypeIds(['xyz'])).toEqual([]);
  });
});

describe('mergePresets', () => {
  it('returns built-in presets when no customs are passed', () => {
    expect(mergePresets([])).toEqual(FILTER_TYPE_PRESETS);
  });

  it('appends custom types with a "custom:" id prefix so they never clash', () => {
    const merged = mergePresets([{ id: 'logs', label: 'Logs', formats: ['log', 'bak'] }]);
    const custom = merged.find((p) => p.id === 'custom:logs');
    expect(custom).toBeDefined();
    expect(custom!.label).toBe('Logs');
    expect(custom!.formats).toEqual(['log', 'bak']);
    expect(custom!.icon).toBeTruthy();
  });

  it('preserves order: built-ins first, customs in declared order', () => {
    const merged = mergePresets([
      { id: 'a', label: 'A', formats: ['a'] },
      { id: 'b', label: 'B', formats: ['b'] },
    ]);
    const builtInCount = FILTER_TYPE_PRESETS.length;
    expect(merged[builtInCount].id).toBe('custom:a');
    expect(merged[builtInCount + 1].id).toBe('custom:b');
  });
});

describe('deriveActiveTypeIds with custom presets', () => {
  it('recognizes a custom preset as active when all its formats are in the allowlist', () => {
    const merged = mergePresets([{ id: 'logs', label: 'Logs', formats: ['log', 'bak'] }]);
    const ids = deriveActiveTypeIds(['log', 'bak'], merged);
    expect(ids).toContain('custom:logs');
  });

  it('does not flip on a custom preset when only some of its formats are present', () => {
    const merged = mergePresets([{ id: 'logs', label: 'Logs', formats: ['log', 'bak'] }]);
    expect(deriveActiveTypeIds(['log'], merged)).not.toContain('custom:logs');
  });

  it('skips zero-format presets (regression: an empty custom type must not auto-activate)', () => {
    const merged = mergePresets([{ id: 'empty', label: 'Empty', formats: [] }]);
    expect(deriveActiveTypeIds(['jpg'], merged)).not.toContain('custom:empty');
  });
});

describe('buildExtensionAllowlist with custom presets', () => {
  it('merges extensions from a custom preset when its id is active', () => {
    const merged = mergePresets([{ id: 'logs', label: 'Logs', formats: ['log', 'bak'] }]);
    const list = buildExtensionAllowlist(['custom:logs'], '', merged);
    expect(list).toEqual(expect.arrayContaining(['log', 'bak']));
  });

  it('allows enabling ONLY a custom preset with no built-ins selected', () => {
    // Pins the user-facing requirement: deselect all built-ins, use a
    // custom preset, and still get a non-null allowlist.
    const merged = mergePresets([{ id: 'logs', label: 'Logs', formats: ['log'] }]);
    const list = buildExtensionAllowlist(['custom:logs'], '', merged);
    expect(list).toEqual(['log']);
  });
});

describe('sizePresetLabel', () => {
  it('returns "Any" for null inputs', () => {
    expect(sizePresetLabel(null, null)).toBe('Any');
    expect(sizePresetLabel()).toBe('Any');
  });

  it('matches a known preset by min/max', () => {
    expect(sizePresetLabel(1024 * 1024, 10 * 1024 * 1024)).toBe('1 - 10 MB');
  });

  it('returns "Any" for non-matching custom range', () => {
    expect(sizePresetLabel(123, 456)).toBe('Any');
  });

  it('matches the unbounded-min preset', () => {
    expect(sizePresetLabel(undefined, 1024 * 1024 - 1)).toBe('< 1 MB');
  });
});

describe('datePresetLabel / datePresetToAfterMs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-07T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "Any time" when afterMs is undefined', () => {
    expect(datePresetLabel()).toBe('Any time');
    expect(datePresetLabel(null)).toBe('Any time');
    expect(datePresetLabel(0)).toBe('Any time');
  });

  it('round-trips via datePresetToAfterMs', () => {
    const ms = datePresetToAfterMs('This week');
    expect(ms).toBeDefined();
    expect(datePresetLabel(ms)).toBe('This week');
  });

  it('returns "Any time" for unrecognized labels', () => {
    expect(datePresetToAfterMs('Never')).toBeUndefined();
  });

  it('returns "Any time" for "Any time" label', () => {
    expect(datePresetToAfterMs('Any time')).toBeUndefined();
  });
});
