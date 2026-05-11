import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import PairRow from './PairRow';
import type { UiFile } from '../../../results/adapter';

// FilePreview pulls in pdfjs/Tauri — stub it out for this rendering test.
vi.mock('./FilePreview', () => ({
  default: () => <div data-testid="file-preview" />,
}));

const baseFile: UiFile = {
  path: '/photos/IMG_001.jpg',
  name: 'IMG_001.jpg',
  dir: '/photos/',
  sizeBytes: 2_000_000,
  modifiedMs: 1_710_000_000_000,
  formattedSize: '2 MB',
  formattedDate: '2024-03-15',
  icon: 'ri-image-line',
  assetUrl: 'asset:///photos/IMG_001.jpg',
  bucket: 'Images',
  ext: 'jpg',
};

const duplicate: UiFile = { ...baseFile, path: '/photos/IMG_001_copy.jpg', name: 'IMG_001_copy.jpg' };

describe('PairRow', () => {
  it('does not apply contentVisibility:auto on the row container', () => {
    // contentVisibility:auto inside a Virtuoso-virtualized list double-culls
    // items — Virtuoso mounts them but the browser elides the content,
    // leaving blank rows. The optimization must not be on the outer row.
    const { container } = render(
      <PairRow
        original={baseFile}
        duplicate={duplicate}
        isOriginalSelected={false}
        isDuplicateSelected={false}
        onToggle={vi.fn()}
        onOpen={vi.fn()}
        onReveal={vi.fn()}
      />
    );
    const row = container.firstElementChild as HTMLElement | null;
    expect(row).not.toBeNull();
    // Inline style — what was being set via `style={{ contentVisibility: 'auto' }}`.
    expect(row!.style.contentVisibility).toBe('');
  });

  it('renders the file names so rows are not blank', () => {
    render(
      <PairRow
        original={baseFile}
        duplicate={duplicate}
        isOriginalSelected={false}
        isDuplicateSelected={false}
        onToggle={vi.fn()}
        onOpen={vi.fn()}
        onReveal={vi.fn()}
      />
    );
    expect(screen.getByText('IMG_001.jpg')).toBeInTheDocument();
    expect(screen.getByText('IMG_001_copy.jpg')).toBeInTheDocument();
  });
});
