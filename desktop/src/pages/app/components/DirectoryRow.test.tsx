import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DirectoryRow from './DirectoryRow';

const baseProps = {
  name: '/home/me/Photos',
  files: 1234,
  progress: 0,
  scanned: false,
  scanning: false,
  onRemove: vi.fn(),
};

describe('DirectoryRow', () => {
  it('shows the remove button when idle', () => {
    render(<DirectoryRow {...baseProps} />);
    expect(screen.getByRole('button', { name: /remove/i })).toBeInTheDocument();
  });

  it('keeps the remove button visible after a scan completes', () => {
    // Regression: previously the remove button was swapped out for a check
    // icon when scanned=true, leaving no way to clear a directory before the
    // next scan.
    render(<DirectoryRow {...baseProps} scanned progress={100} />);
    expect(screen.getByRole('button', { name: /remove/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/scanned/i)).toBeInTheDocument();
  });

  it('hides the remove button while scanning is in progress', () => {
    render(<DirectoryRow {...baseProps} scanning progress={42} />);
    expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
  });

  it('calls onRemove when the remove button is clicked', () => {
    const onRemove = vi.fn();
    render(<DirectoryRow {...baseProps} scanned onRemove={onRemove} />);
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
