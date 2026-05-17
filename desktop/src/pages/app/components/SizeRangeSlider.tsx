import { useCallback } from 'react';

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

export const SIZE_STOPS: number[] = [
  0,
  KB,
  4 * KB,
  16 * KB,
  64 * KB,
  256 * KB,
  MB,
  4 * MB,
  16 * MB,
  64 * MB,
  256 * MB,
  GB,
  4 * GB,
  16 * GB,
];

const LAST_IDX = SIZE_STOPS.length - 1;

function formatSize(bytes: number): string {
  if (bytes === 0) return '0';
  if (bytes >= GB) {
    const v = bytes / GB;
    return `${Number.isInteger(v) ? v : v.toFixed(1)} GB`;
  }
  if (bytes >= MB) {
    const v = bytes / MB;
    return `${Number.isInteger(v) ? v : v.toFixed(1)} MB`;
  }
  if (bytes >= KB) {
    const v = bytes / KB;
    return `${Number.isInteger(v) ? v : v.toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

/** Pick the slider index whose stop is closest to `bytes`. */
function bytesToIndex(bytes: number | null, fallback: number): number {
  if (bytes == null) return fallback;
  let best = 0;
  let bestDelta = Math.abs(SIZE_STOPS[0] - bytes);
  for (let i = 1; i < SIZE_STOPS.length; i++) {
    const d = Math.abs(SIZE_STOPS[i] - bytes);
    if (d < bestDelta) {
      best = i;
      bestDelta = d;
    }
  }
  return best;
}

interface Props {
  minSize: number | null;
  maxSize: number | null;
  onChange: (next: { minSize: number | null; maxSize: number | null }) => void;
}

/**
 * Two-handle size window. Lower handle at index 0 → no minimum (null).
 * Upper handle at the last index → no maximum (null). Handles cannot cross —
 * dragging one past the other pushes the other along with it.
 */
export default function SizeRangeSlider({ minSize, maxSize, onChange }: Props) {
  const minIdx = bytesToIndex(minSize, 0);
  const maxIdx = bytesToIndex(maxSize, LAST_IDX);

  const handleMin = useCallback(
    (raw: string) => {
      const next = Math.max(0, Math.min(LAST_IDX, Number(raw)));
      const clampedMax = Math.max(next, maxIdx);
      onChange({
        minSize: next === 0 ? null : SIZE_STOPS[next],
        maxSize: clampedMax === LAST_IDX ? null : SIZE_STOPS[clampedMax],
      });
    },
    [maxIdx, onChange]
  );

  const handleMax = useCallback(
    (raw: string) => {
      const next = Math.max(0, Math.min(LAST_IDX, Number(raw)));
      const clampedMin = Math.min(next, minIdx);
      onChange({
        minSize: clampedMin === 0 ? null : SIZE_STOPS[clampedMin],
        maxSize: next === LAST_IDX ? null : SIZE_STOPS[next],
      });
    },
    [minIdx, onChange]
  );

  const trackLeft = (minIdx / LAST_IDX) * 100;
  const trackRight = (maxIdx / LAST_IDX) * 100;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-white/50 text-[11px] font-mono">
          {minIdx === 0 ? 'No min' : formatSize(SIZE_STOPS[minIdx])}
        </span>
        <span className="text-white/50 text-[11px] font-mono">
          {maxIdx === LAST_IDX ? 'No max' : formatSize(SIZE_STOPS[maxIdx])}
        </span>
      </div>
      <div className="relative h-8">
        <div className="absolute top-1/2 -translate-y-1/2 left-0 right-0 h-1 bg-white/10 rounded-full" />
        <div
          className="absolute top-1/2 -translate-y-1/2 h-1 bg-[#f5c542] rounded-full"
          style={{ left: `${trackLeft}%`, right: `${100 - trackRight}%` }}
        />
        <input
          aria-label="Minimum size"
          type="range"
          min={0}
          max={LAST_IDX}
          step={1}
          value={minIdx}
          onChange={(e) => handleMin(e.target.value)}
          className="absolute inset-0 w-full h-8 appearance-none bg-transparent pointer-events-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#f5c542] [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-[#f5c542] [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:cursor-pointer"
        />
        <input
          aria-label="Maximum size"
          type="range"
          min={0}
          max={LAST_IDX}
          step={1}
          value={maxIdx}
          onChange={(e) => handleMax(e.target.value)}
          className="absolute inset-0 w-full h-8 appearance-none bg-transparent pointer-events-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#f5c542] [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-[#f5c542] [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:cursor-pointer"
        />
      </div>
    </div>
  );
}
