import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OrganizeProgressModal from './OrganizeProgressModal';
import { OrganizeContext, type OrganizeContextValue } from '../../../organize/OrganizeContext';

function ctx(overrides: Partial<OrganizeContextValue>): OrganizeContextValue {
  return {
    running: false,
    progress: 0,
    phase: null,
    processed: 0,
    total: 0,
    currentPath: null,
    op: null,
    speedBytesPerSec: null,
    currentFileBytes: null,
    currentFileTotal: null,
    startOrganize: vi.fn(async () => null),
    cancelOrganize: vi.fn(async () => undefined),
    onProgress: vi.fn(() => () => undefined),
    onComplete: vi.fn(() => () => undefined),
    onCollision: vi.fn(() => () => undefined),
    ...overrides,
  };
}

function withCtx(value: OrganizeContextValue) {
  return (
    <OrganizeContext.Provider value={value}>
      <OrganizeProgressModal />
    </OrganizeContext.Provider>
  );
}

describe('OrganizeProgressModal', () => {
  it('renders nothing when not running', () => {
    render(withCtx(ctx({ running: false })));
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
  });

  it('shows phase title, percent, and Cancel when running', () => {
    render(
      withCtx(
        ctx({
          running: true,
          progress: 42,
          phase: 'organizing',
          op: 'copy',
          processed: 4,
          total: 10,
          currentPath: '/x/y',
        })
      )
    );
    expect(screen.getByText('Copying files')).toBeInTheDocument();
    expect(screen.getByText('/x/y')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });

  it('shows human-readable transfer speed during organizing phase', () => {
    render(
      withCtx(
        ctx({
          running: true,
          progress: 50,
          phase: 'organizing',
          op: 'copy',
          processed: 5,
          total: 10,
          speedBytesPerSec: 1.5 * 1024 * 1024,
        })
      )
    );
    expect(screen.getByText('1.50 MB/s')).toBeInTheDocument();
  });

  it('hides speed during walking phase', () => {
    render(
      withCtx(
        ctx({
          running: true,
          progress: 5,
          phase: 'walking',
          op: 'copy',
          processed: 100,
          total: 0,
          speedBytesPerSec: 1.5 * 1024 * 1024,
        })
      )
    );
    expect(screen.queryByText(/MB\/s/)).toBeNull();
  });

  it('renders a current-file bar plus overall bar when currentFileTotal is set', () => {
    render(
      withCtx(
        ctx({
          running: true,
          progress: 50,
          phase: 'organizing',
          op: 'copy',
          processed: 1,
          total: 10,
          currentFileBytes: 2_500_000,
          currentFileTotal: 10_000_000,
        })
      )
    );
    const bars = screen.getAllByRole('progressbar');
    expect(bars).toHaveLength(2);
    const fileBar = screen.getByRole('progressbar', { name: /current file/i });
    expect(fileBar).toHaveAttribute('aria-valuenow', '25');
    const overall = screen.getByRole('progressbar', { name: /overall/i });
    expect(overall).toHaveAttribute('aria-valuenow', '50');
  });

  it('hides current-file bar during walking or when currentFileTotal is missing', () => {
    render(
      withCtx(
        ctx({
          running: true,
          progress: 5,
          phase: 'walking',
          op: 'copy',
          processed: 100,
          total: 0,
        })
      )
    );
    const bars = screen.getAllByRole('progressbar');
    expect(bars).toHaveLength(1);
    expect(bars[0]).toHaveAttribute('aria-label', 'overall progress');
  });

  it('Cancel button calls cancelOrganize once', async () => {
    const cancelOrganize = vi.fn(async () => undefined);
    render(
      withCtx(
        ctx({ running: true, progress: 10, phase: 'walking', op: 'copy', cancelOrganize })
      )
    );
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(cancelOrganize).toHaveBeenCalledTimes(1);
  });
});
