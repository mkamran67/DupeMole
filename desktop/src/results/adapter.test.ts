import { describe, it, expect } from 'vitest';
import { extensionToBucket, toUiGroup, presetIconForType } from './adapter';
import type { BackendDuplicateGroup } from './types';

describe('extensionToBucket', () => {
  it('maps known image extensions', () => {
    expect(extensionToBucket('jpg').type).toBe('Images');
    expect(extensionToBucket('png').type).toBe('Images');
    expect(extensionToBucket('webp').type).toBe('Images');
  });

  it('maps known video extensions', () => {
    expect(extensionToBucket('mp4').type).toBe('Videos');
    expect(extensionToBucket('mov').type).toBe('Videos');
  });

  it('maps PDFs and audio', () => {
    expect(extensionToBucket('pdf').type).toBe('PDFs');
    expect(extensionToBucket('mp3').type).toBe('Audio');
  });

  it('falls back to Other for unknown extensions', () => {
    expect(extensionToBucket('xyz').type).toBe('Other');
    expect(extensionToBucket('').type).toBe('Other');
  });

  it('is case-insensitive', () => {
    expect(extensionToBucket('JPG').type).toBe('Images');
    expect(extensionToBucket('Mp4').type).toBe('Videos');
  });

  it('returns an icon string for every bucket', () => {
    expect(extensionToBucket('jpg').icon).toMatch(/^ri-/);
    expect(extensionToBucket('xyz').icon).toMatch(/^ri-/);
  });
});

describe('presetIconForType', () => {
  it('returns the canonical icon for a known type', () => {
    expect(presetIconForType('Images')).toBe('ri-image-line');
    expect(presetIconForType('PDFs')).toBe('ri-file-pdf-line');
  });

  it('falls back to file-line for Other', () => {
    expect(presetIconForType('Other')).toBe('ri-file-line');
  });
});

describe('toUiGroup', () => {
  const makeGroup = (
    files: { path: string; size: number; modifiedMs: number | null }[],
    size = 100,
  ): BackendDuplicateGroup => ({
    id: 'grp-1',
    hash: 'abc',
    size,
    hashKind: 'full',
    files,
  });

  it('computes wasted bytes as size * (count - 1)', () => {
    const g = makeGroup(
      [
        { path: '/a.jpg', size: 100, modifiedMs: 1 },
        { path: '/b.jpg', size: 100, modifiedMs: 2 },
        { path: '/c.jpg', size: 100, modifiedMs: 3 },
      ],
      100,
    );
    const ui = toUiGroup(g);
    expect(ui.wastedBytes).toBe(200);
    expect(ui.count).toBe(3);
  });

  it('returns wastedBytes 0 when only one file is present', () => {
    const g = makeGroup([{ path: '/a.jpg', size: 100, modifiedMs: 1 }], 100);
    const ui = toUiGroup(g);
    expect(ui.wastedBytes).toBe(0);
  });

  it('sorts files oldest-first', () => {
    const g = makeGroup(
      [
        { path: '/c.jpg', size: 10, modifiedMs: 300 },
        { path: '/a.jpg', size: 10, modifiedMs: 100 },
        { path: '/b.jpg', size: 10, modifiedMs: 200 },
      ],
      10,
    );
    const ui = toUiGroup(g);
    expect(ui.files.map((f) => f.path)).toEqual(['/a.jpg', '/b.jpg', '/c.jpg']);
  });

  it('sinks files with null modifiedMs to the bottom', () => {
    const g = makeGroup(
      [
        { path: '/unknown.jpg', size: 10, modifiedMs: null },
        { path: '/old.jpg', size: 10, modifiedMs: 100 },
        { path: '/new.jpg', size: 10, modifiedMs: 200 },
      ],
      10,
    );
    const ui = toUiGroup(g);
    expect(ui.files[ui.files.length - 1].path).toBe('/unknown.jpg');
  });

  it('uses the dominant bucket as the group type', () => {
    const g = makeGroup(
      [
        { path: '/a.jpg', size: 10, modifiedMs: 1 },
        { path: '/b.jpg', size: 10, modifiedMs: 2 },
        { path: '/c.mp4', size: 10, modifiedMs: 3 },
      ],
      10,
    );
    const ui = toUiGroup(g);
    expect(ui.type).toBe('Images');
  });

  it('adapts each file with formatted size and asset URL', () => {
    const g = makeGroup([{ path: '/a.jpg', size: 2048, modifiedMs: 1 }], 2048);
    const ui = toUiGroup(g);
    expect(ui.files[0].formattedSize).toBe('2.00 KB');
    expect(ui.files[0].assetUrl).toBe('asset:///a.jpg');
    expect(ui.files[0].name).toBe('a.jpg');
    expect(ui.files[0].ext).toBe('jpg');
    expect(ui.files[0].bucket).toBe('Images');
  });

  it('handles empty file lists without throwing', () => {
    const g = makeGroup([], 100);
    const ui = toUiGroup(g);
    expect(ui.count).toBe(0);
    expect(ui.wastedBytes).toBe(0);
    expect(ui.files).toEqual([]);
    expect(ui.type).toBe('Other');
  });

  it('does not mutate the input group', () => {
    const original = [
      { path: '/c.jpg', size: 10, modifiedMs: 300 },
      { path: '/a.jpg', size: 10, modifiedMs: 100 },
    ];
    const g = makeGroup([...original], 10);
    toUiGroup(g);
    expect(g.files.map((f) => f.path)).toEqual(['/c.jpg', '/a.jpg']);
  });
});
