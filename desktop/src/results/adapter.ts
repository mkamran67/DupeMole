import { convertFileSrc } from '@tauri-apps/api/core';
import { FILTER_TYPE_PRESETS } from '../settings/filterPresets';
import { basename, dirname, formatBytes, formatDate } from '../lib/format';
import type { BackendDuplicateGroup, BackendDuplicateFile } from './types';

export type BucketType = 'Images' | 'Videos' | 'PDFs' | 'Audio' | 'Docs' | 'Archives' | 'Other';

const PRESET_BY_LABEL = new Map(FILTER_TYPE_PRESETS.map((p) => [p.label, p] as const));

function fileExtension(path: string): string {
  const name = basename(path);
  const idx = name.lastIndexOf('.');
  if (idx <= 0 || idx === name.length - 1) return '';
  return name.slice(idx + 1).toLowerCase();
}

export function extensionToBucket(ext: string): { type: BucketType; icon: string } {
  for (const preset of FILTER_TYPE_PRESETS) {
    if (preset.formats.some((f) => f.toLowerCase() === ext.toLowerCase())) {
      return { type: preset.label as BucketType, icon: preset.icon };
    }
  }
  return { type: 'Other', icon: 'ri-file-line' };
}

export interface UiFile {
  path: string;
  name: string;
  dir: string;
  sizeBytes: number;
  modifiedMs: number | null;
  formattedSize: string;
  formattedDate: string;
  icon: string;
  assetUrl: string;
  bucket: BucketType;
  ext: string;
}

export interface UiGroup {
  id: string;
  type: BucketType;
  icon: string;
  count: number;
  sizeBytes: number;
  wastedBytes: number;
  formattedWasted: string;
  files: UiFile[];
}

function adaptFile(f: BackendDuplicateFile): UiFile {
  const ext = fileExtension(f.path);
  const { icon, type } = extensionToBucket(ext);
  return {
    path: f.path,
    name: basename(f.path),
    dir: dirname(f.path),
    sizeBytes: f.size,
    modifiedMs: f.modifiedMs,
    formattedSize: formatBytes(f.size),
    formattedDate: formatDate(f.modifiedMs),
    icon,
    assetUrl: convertFileSrc(f.path),
    bucket: type,
    ext,
  };
}

function dominantBucket(files: BackendDuplicateFile[]): { type: BucketType; icon: string } {
  const counts = new Map<BucketType, { count: number; icon: string }>();
  for (const f of files) {
    const ext = fileExtension(f.path);
    const { type, icon } = extensionToBucket(ext);
    const cur = counts.get(type);
    if (cur) cur.count += 1;
    else counts.set(type, { count: 1, icon });
  }
  let best: BucketType = 'Other';
  let bestIcon = 'ri-file-line';
  let bestCount = -1;
  for (const [type, { count, icon }] of counts) {
    if (count > bestCount) {
      best = type;
      bestIcon = icon;
      bestCount = count;
    }
  }
  return { type: best, icon: bestIcon };
}

export function toUiGroup(group: BackendDuplicateGroup): UiGroup {
  // Sort files oldest-first so files[0] is the "original".
  // Files with unknown mtime sink to the bottom.
  const sorted = [...group.files].sort((a, b) => {
    const am = a.modifiedMs ?? Number.MAX_SAFE_INTEGER;
    const bm = b.modifiedMs ?? Number.MAX_SAFE_INTEGER;
    return am - bm;
  });
  const { type, icon } = dominantBucket(sorted);
  const count = sorted.length;
  const wastedBytes = group.size * Math.max(0, count - 1);
  return {
    id: group.id,
    type,
    icon,
    count,
    sizeBytes: group.size,
    wastedBytes,
    formattedWasted: formatBytes(wastedBytes),
    files: sorted.map(adaptFile),
  };
}

export function presetIconForType(type: BucketType): string {
  const preset = PRESET_BY_LABEL.get(type);
  return preset?.icon ?? 'ri-file-line';
}
