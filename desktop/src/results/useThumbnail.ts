import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { UiFile } from './adapter';

// Generous concurrency: thumbnail generation is CPU-bound on the Rust side
// (image::ImageReader + resize), and modern desktops have plenty of cores.
const MAX_CONCURRENT = 8;

const THUMBNAILABLE_EXTS = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff',
]);

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();
const warned = new Set<string>();

let active = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiters.push(() => {
      active += 1;
      resolve();
    });
  });
}

function release() {
  active -= 1;
  const next = waiters.shift();
  if (next) next();
}

function requestThumbnail(path: string, edge: number): Promise<string> {
  const key = `${path}::${edge}`;
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    await acquire();
    try {
      // Returns a "data:image/jpeg;base64,..." URL — bypasses the asset
      // protocol entirely so we don't depend on its scope quirks for the
      // hidden cache directory.
      const dataUrl = await invoke<string>('get_thumbnail', { path, edge });
      cache.set(key, dataUrl);
      return dataUrl;
    } finally {
      release();
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

export interface ThumbnailResult {
  /** Resolved thumbnail URL, or null while pending / when skipped. */
  url: string | null;
  /** Generation failed; caller should render a placeholder, not the original. */
  failed: boolean;
  /** No thumbnail needed (small file, non-image, or unsupported format); use the original. */
  skipped: boolean;
}

export function useThumbnail(file: UiFile, edge = 256): ThumbnailResult {
  const isImage = file.bucket === 'Images';
  const isSupported = THUMBNAILABLE_EXTS.has(file.ext);
  // Always thumbnail every supported image: the WebView decodes originals at
  // their full pixel dimensions regardless of byte size, and a 2 MB JPEG can
  // still be 16 MP — exactly what's killing scroll performance on photo
  // libraries. Cost is amortized: first scroll generates, subsequent are
  // cached on disk.
  const eligible = isImage && isSupported;

  const cacheKey = `${file.path}::${edge}`;
  const initial = eligible ? (cache.get(cacheKey) ?? null) : null;

  const [url, setUrl] = useState<string | null>(initial);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!eligible) {
      setUrl(null);
      setFailed(false);
      return;
    }
    const cached = cache.get(cacheKey);
    if (cached) {
      setUrl(cached);
      setFailed(false);
      return;
    }
    let alive = true;
    setUrl(null);
    setFailed(false);
    requestThumbnail(file.path, edge)
      .then((u) => {
        if (alive) setUrl(u);
      })
      .catch((err) => {
        if (!warned.has(file.path)) {
          warned.add(file.path);
          console.warn('[thumbnail] failed for', file.path, err);
        }
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [eligible, cacheKey, file.path, edge]);

  return { url, failed, skipped: !eligible };
}
