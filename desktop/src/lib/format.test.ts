import { describe, it, expect } from 'vitest';
import { formatBytes, basename, dirname, formatDate, formatRate } from './format';

describe('formatBytes', () => {
  it('renders sub-KB values in bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('switches to KB at 1024', () => {
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(2048)).toBe('2.00 KB');
  });

  it('uses MB / GB / TB for larger values', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB');
    expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe('1.00 TB');
  });

  it('caps the unit at TB even for absurdly large values', () => {
    const huge = 1024 ** 5; // would be PB if we kept going
    expect(formatBytes(huge).endsWith('TB')).toBe(true);
  });

  it('uses one decimal place when the value is >= 10', () => {
    expect(formatBytes(15 * 1024)).toBe('15.0 KB');
    expect(formatBytes(100 * 1024)).toBe('100.0 KB');
  });
});

describe('basename', () => {
  it('returns the last segment of a posix path', () => {
    expect(basename('/a/b/c.txt')).toBe('c.txt');
    expect(basename('/single')).toBe('single');
  });

  it('returns the last segment of a windows path', () => {
    expect(basename('C:\\Users\\me\\file.png')).toBe('file.png');
  });

  it('handles trailing slashes by ignoring empty segments', () => {
    expect(basename('/a/b/')).toBe('b');
  });

  it('falls back to the input when there are no separators', () => {
    expect(basename('only')).toBe('only');
  });

  it('handles mixed separators', () => {
    expect(basename('/a/b\\c/d.txt')).toBe('d.txt');
  });
});

describe('dirname', () => {
  it('returns directory portion with trailing separator', () => {
    expect(dirname('/a/b/c.txt')).toBe('/a/b/');
  });

  it('returns directory portion for windows paths', () => {
    expect(dirname('C:\\Users\\me\\file.png')).toBe('C:\\Users\\me\\');
  });

  it('returns empty string when no separator is present', () => {
    expect(dirname('file.txt')).toBe('');
    expect(dirname('')).toBe('');
  });
});

describe('formatRate', () => {
  it('returns empty string for null / NaN / negative / non-finite', () => {
    expect(formatRate(null)).toBe('');
    expect(formatRate(NaN)).toBe('');
    expect(formatRate(-1)).toBe('');
    expect(formatRate(Infinity)).toBe('');
  });

  it('formats 0 B/s', () => {
    expect(formatRate(0)).toBe('0 B/s');
  });

  it('formats sub-KB rates', () => {
    expect(formatRate(512)).toBe('512 B/s');
  });

  it('formats MB/s rates', () => {
    expect(formatRate(1.5 * 1024 * 1024)).toBe('1.50 MB/s');
  });

  it('formats very large rates with /s suffix', () => {
    expect(formatRate(5 * 1024 * 1024 * 1024).endsWith('GB/s')).toBe(true);
  });
});

describe('formatDate', () => {
  it('returns empty string for null / undefined / zero', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
    expect(formatDate(0)).toBe('');
  });

  it('formats a known timestamp into a non-empty locale string', () => {
    const ms = Date.UTC(2024, 2, 15, 12, 0, 0);
    const result = formatDate(ms);
    expect(result).not.toBe('');
    expect(typeof result).toBe('string');
  });
});
