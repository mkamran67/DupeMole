export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

export function formatRate(bytesPerSec: number | null | undefined): string {
  if (
    bytesPerSec === null ||
    bytesPerSec === undefined ||
    !Number.isFinite(bytesPerSec) ||
    bytesPerSec < 0
  ) {
    return '';
  }
  return `${formatBytes(bytesPerSec)}/s`;
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function dirname(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx === -1 ? '' : p.slice(0, idx + 1);
}

export function formatDate(ms: number | null | undefined): string {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '';
  }
}
