import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FileCard from './FileCard';
import type { UiFile } from '../../../results/adapter';

// LazyMount uses an IntersectionObserver — render its children eagerly in tests.
vi.mock('./LazyMount', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// FilePreview tries to load real assets — replace with a stub.
vi.mock('./FilePreview', () => ({
  default: () => <div data-testid="file-preview" />,
}));

const baseFile: UiFile = {
  path: '/photos/IMG_001.jpg',
  name: 'IMG_001.jpg',
  dir: '/photos/',
  sizeBytes: 2048,
  modifiedMs: 1_710_504_000_000,
  formattedSize: '2.00 KB',
  formattedDate: '2024-03-15',
  icon: 'ri-image-line',
  assetUrl: 'asset:///photos/IMG_001.jpg',
  bucket: 'Images',
  ext: 'jpg',
};

function renderCard(overrides: Partial<Parameters<typeof FileCard>[0]> = {}) {
  const props = {
    file: baseFile,
    isSelected: false,
    isOriginal: false,
    onToggle: vi.fn(),
    onOpen: vi.fn(),
    onReveal: vi.fn(),
    revealLabel: 'Show in Files',
    ...overrides,
  };
  render(<FileCard {...props} />);
  return props;
}

describe('FileCard', () => {
  it('renders the filename, formatted size, and directory', () => {
    renderCard();
    expect(screen.getByText('IMG_001.jpg')).toBeInTheDocument();
    expect(screen.getByText('2.00 KB')).toBeInTheDocument();
    expect(screen.getByText('/photos/')).toBeInTheDocument();
  });

  it('renders the formatted date when present', () => {
    renderCard();
    expect(screen.getByText('2024-03-15')).toBeInTheDocument();
  });

  it('omits the date row when formattedDate is empty', () => {
    renderCard({ file: { ...baseFile, formattedDate: '' } });
    expect(screen.queryByText('2024-03-15')).not.toBeInTheDocument();
  });

  it('shows the "Original" badge only when isOriginal is true', () => {
    renderCard({ isOriginal: false });
    expect(screen.queryByText(/original/i)).not.toBeInTheDocument();
    document.body.innerHTML = '';
    renderCard({ isOriginal: true });
    expect(screen.getByText(/original/i)).toBeInTheDocument();
  });

  it('fires onToggle when the card body is clicked', () => {
    const props = renderCard();
    fireEvent.click(screen.getByText('IMG_001.jpg'));
    expect(props.onToggle).toHaveBeenCalledWith('/photos/IMG_001.jpg');
  });

  it('fires onOpen and not onToggle when the Open button is clicked', () => {
    const props = renderCard();
    fireEvent.click(screen.getByRole('button', { name: /open/i }));
    expect(props.onOpen).toHaveBeenCalledWith('/photos/IMG_001.jpg');
    expect(props.onToggle).not.toHaveBeenCalled();
  });

  it('fires onReveal with the reveal-label button', () => {
    const props = renderCard({ revealLabel: 'Reveal in Finder' });
    fireEvent.click(screen.getByRole('button', { name: /reveal in finder/i }));
    expect(props.onReveal).toHaveBeenCalledWith('/photos/IMG_001.jpg');
  });
});
