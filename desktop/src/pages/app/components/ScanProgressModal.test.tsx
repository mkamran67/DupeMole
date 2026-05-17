import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ScanProgressModal from './ScanProgressModal';
import { ScanContext, type ScanContextValue } from '../../../scan/ScanContext';

function ctx(overrides: Partial<ScanContextValue>): ScanContextValue {
  return {
    scanning: false,
    progress: 0,
    phase: null,
    phaseProcessed: 0,
    phaseTotal: 0,
    currentPath: null,
    etaSeconds: null,
    folderIndex: null,
    folderTotal: null,
    startScan: vi.fn(async () => null),
    cancelScan: vi.fn(async () => undefined),
    onProgress: vi.fn(() => () => undefined),
    onComplete: vi.fn(() => () => undefined),
    ...overrides,
  };
}

function withCtx(value: ScanContextValue) {
  return (
    <ScanContext.Provider value={value}>
      <ScanProgressModal />
    </ScanContext.Provider>
  );
}

describe('ScanProgressModal', () => {
  it('renders nothing when not scanning', () => {
    render(withCtx(ctx({ scanning: false })));
    expect(screen.queryByText(/Hashing|Discovering|Verifying|Reading metadata/)).toBeNull();
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
  });

  it('renders progress bar, phase title, and current path when scanning', () => {
    render(
      withCtx(
        ctx({
          scanning: true,
          progress: 42,
          phase: 'hashing',
          currentPath: '/x/y',
          phaseProcessed: 50,
          phaseTotal: 100,
        })
      )
    );
    expect(screen.getByText('Hashing')).toBeInTheDocument();
    expect(screen.getByText('/x/y')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });

  it('clicking Cancel calls cancelScan once', async () => {
    const cancelScan = vi.fn(async () => undefined);
    render(withCtx(ctx({ scanning: true, progress: 10, phase: 'discovery', cancelScan })));
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(cancelScan).toHaveBeenCalledTimes(1);
  });
});
