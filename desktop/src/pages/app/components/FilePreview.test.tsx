import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import FilePreview from './FilePreview';
import type { UiFile } from '../../../results/adapter';

// pdfjs-dist pulls a worker URL via Vite's ?url plugin; stub it so importing
// FilePreview doesn't try to resolve the worker module under Vitest.
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(() => ({ promise: Promise.reject(new Error('not used')) })),
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

const baseImage: UiFile = {
  path: '/photos/IMG_001.jpg',
  name: 'IMG_001.jpg',
  dir: '/photos/',
  sizeBytes: 2_000_000,
  modifiedMs: 0,
  formattedSize: '2 MB',
  formattedDate: '',
  icon: 'ri-image-line',
  assetUrl: 'asset:///photos/IMG_001.jpg',
  bucket: 'Images',
  ext: 'jpg',
};

describe('FilePreview — Images branch', () => {
  it('does not render <img> for RAW formats the WebView cannot decode', () => {
    // ARW (Sony RAW) is in the Images bucket but neither the Rust thumbnailer
    // nor the WebView can decode it. Falling back to assetUrl makes the
    // WebView stream tens of MB before failing — drop the <img> entirely
    // and let the icon show.
    const arw: UiFile = {
      ...baseImage,
      name: 'DSC_001.arw',
      path: '/photos/DSC_001.arw',
      ext: 'arw',
      assetUrl: 'asset:///photos/DSC_001.arw',
    };
    const { container } = render(<FilePreview file={arw} onOpen={vi.fn()} />);
    expect(container.querySelector('img')).toBeNull();
  });

  it('still falls back to assetUrl for natively-renderable formats (SVG)', () => {
    const svg: UiFile = {
      ...baseImage,
      name: 'icon.svg',
      path: '/x/icon.svg',
      ext: 'svg',
      assetUrl: 'asset:///x/icon.svg',
    };
    const { container } = render(<FilePreview file={svg} onOpen={vi.fn()} />);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('asset:///x/icon.svg');
  });
});
