export interface FilterTypePreset {
  id: string;
  icon: string;
  label: string;
  formats: string[];
}

export const FILTER_TYPE_PRESETS: FilterTypePreset[] = [
  {
    id: 'images',
    icon: 'ri-image-line',
    label: 'Images',
    formats: [
      'JPG', 'JPEG', 'PNG', 'WEBP', 'HEIC', 'HEIF', 'BMP', 'TIFF', 'TIF', 'GIF', 'SVG', 'AVIF',
      'DNG', 'CR2', 'CR3', 'CRW', 'NEF', 'NRW', 'ARW', 'ARQ', 'SRF', 'SR2',
      'RW2', 'ORF', 'RAF', 'PEF', '3FR', 'IIQ', 'MEF', 'X3F', 'ERF', 'RAW',
      'DCR', 'KDC', 'MRW', 'RWL',
    ],
  },
  {
    id: 'videos',
    icon: 'ri-video-line',
    label: 'Videos',
    formats: ['MP4', 'MOV', 'QT', 'M4V', '3GP', '3G2', 'MKV', 'AVI', 'WEBM', 'FLV', 'WMV'],
  },
  {
    id: 'pdfs',
    icon: 'ri-file-pdf-line',
    label: 'PDFs',
    formats: ['PDF'],
  },
  {
    id: 'audio',
    icon: 'ri-music-line',
    label: 'Audio',
    formats: ['MP3', 'FLAC', 'WAV', 'AAC', 'OGG', 'M4A', 'WMA', 'AIFF'],
  },
  {
    id: 'docs',
    icon: 'ri-file-text-line',
    label: 'Docs',
    formats: ['DOCX', 'TXT', 'RTF', 'ODT', 'DOC', 'XLSX', 'PPTX', 'CSV'],
  },
  {
    id: 'archives',
    icon: 'ri-archive-line',
    label: 'Archives',
    formats: ['ZIP', 'RAR', '7Z', 'TAR', 'GZ', 'BZ2', 'XZ'],
  },
];

export const SCAN_VIEW_BUCKETS = ['images', 'videos', 'pdfs', 'audio'] as const;

export const SIZE_PRESETS: { label: string; min?: number; max?: number }[] = [
  { label: 'Any' },
  { label: '< 1 MB', max: 1024 * 1024 - 1 },
  { label: '1 - 10 MB', min: 1024 * 1024, max: 10 * 1024 * 1024 },
  { label: '10 - 100 MB', min: 10 * 1024 * 1024, max: 100 * 1024 * 1024 },
  { label: '> 100 MB', min: 100 * 1024 * 1024 },
];

export const DATE_PRESETS: { label: string; days?: number }[] = [
  { label: 'Any time' },
  { label: 'Today', days: 1 },
  { label: 'This week', days: 7 },
  { label: 'This month', days: 30 },
  { label: 'This year', days: 365 },
];

export function sizePresetLabel(min?: number | null, max?: number | null): string {
  for (const p of SIZE_PRESETS) {
    if ((p.min ?? null) === (min ?? null) && (p.max ?? null) === (max ?? null)) {
      return p.label;
    }
  }
  return 'Any';
}

export function datePresetLabel(afterMs?: number | null): string {
  if (!afterMs) return 'Any time';
  const now = Date.now();
  for (const p of DATE_PRESETS) {
    if (!p.days) continue;
    const expected = now - p.days * 24 * 60 * 60 * 1000;
    if (Math.abs(expected - afterMs) < 24 * 60 * 60 * 1000) return p.label;
  }
  return 'Any time';
}

export function datePresetToAfterMs(label: string): number | undefined {
  const p = DATE_PRESETS.find((d) => d.label === label);
  if (!p?.days) return undefined;
  return Date.now() - p.days * 24 * 60 * 60 * 1000;
}

/**
 * Compute the union extension allowlist from active type-preset ids + custom extensions.
 * Returns null when the user wants "all extensions" (no presets selected and no customs) —
 * the caller should map that to `extensions: null` on the backend filter.
 */
export function buildExtensionAllowlist(
  activeTypeIds: string[],
  customExt: string,
  presets: FilterTypePreset[] = FILTER_TYPE_PRESETS,
): string[] | null {
  const set = new Set<string>();
  for (const id of activeTypeIds) {
    const preset = presets.find((p) => p.id === id);
    if (preset) preset.formats.forEach((f) => set.add(f.toLowerCase()));
  }
  customExt
    .split(',')
    .map((s) => s.trim().replace(/^\./, '').toLowerCase())
    .filter(Boolean)
    .forEach((e) => set.add(e));
  if (set.size === 0) return null;
  return [...set];
}

/**
 * Reverse: given a stored allowlist, derive which preset ids it covers fully.
 * A preset is "active" if all its formats are present in the allowlist.
 */
export function deriveActiveTypeIds(
  extensions: string[] | null | undefined,
  presets: FilterTypePreset[] = FILTER_TYPE_PRESETS,
): string[] {
  if (!extensions) return presets.map((p) => p.id);
  const set = new Set(extensions.map((e) => e.toLowerCase()));
  return presets
    .filter((p) => p.formats.length > 0 && p.formats.every((f) => set.has(f.toLowerCase())))
    .map((p) => p.id);
}

/**
 * Merge built-in presets with user-defined custom file types. Custom types
 * appear after built-ins, get the prefix id `custom:` (so they never clash
 * with built-in ids), and use a generic icon.
 */
export function mergePresets(
  customTypes: { id: string; label: string; formats: string[] }[],
): FilterTypePreset[] {
  const customPresets: FilterTypePreset[] = customTypes.map((c) => ({
    id: `custom:${c.id}`,
    label: c.label,
    formats: c.formats,
    icon: 'ri-price-tag-3-line',
  }));
  return [...FILTER_TYPE_PRESETS, ...customPresets];
}
