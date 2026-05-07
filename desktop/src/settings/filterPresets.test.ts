import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildExtensionAllowlist,
  deriveActiveTypeIds,
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
