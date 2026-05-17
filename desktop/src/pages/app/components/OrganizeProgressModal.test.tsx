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
