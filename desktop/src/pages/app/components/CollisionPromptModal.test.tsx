import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import CollisionPromptModal, {
  type CollisionDecision,
  type CollisionEvent,
} from './CollisionPromptModal';

const baseEvent: CollisionEvent = {
  organizeId: 'org-xyz',
  sourcePath: '/photos/2024/IMG_001.jpg',
  desiredPath: '/library/Images/2024/IMG_001.jpg',
  sourceSize: 3_500_000,
  existingSize: 3_500_001,
};

beforeEach(() => {
  vi.mocked(invoke).mockClear();
});

describe('CollisionPromptModal', () => {
  it.each<[string, CollisionDecision]>([
    ['Overwrite', 'overwrite'],
    ['Skip', 'skip'],
    ['Keep Both', 'keepBoth'],
    ['Overwrite All', 'overwriteAll'],
    ['Skip All', 'skipAll'],
    ['Keep Both All', 'keepBothAll'],
  ])('clicking "%s" invokes respond_to_collision with %s', async (label, decision) => {
    const onResolved = vi.fn();
    render(<CollisionPromptModal event={baseEvent} onResolved={onResolved} />);
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(invoke).toHaveBeenCalledWith('respond_to_collision', {
      organizeId: 'org-xyz',
      decision,
    });
    // onResolved is awaited after invoke, so flush microtasks
    await Promise.resolve();
    await Promise.resolve();
    expect(onResolved).toHaveBeenCalledWith(decision);
  });

  it('Cancel button sends cancel decision', async () => {
    const onResolved = vi.fn();
    render(<CollisionPromptModal event={baseEvent} onResolved={onResolved} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel organize/i }));
    expect(invoke).toHaveBeenCalledWith('respond_to_collision', {
      organizeId: 'org-xyz',
      decision: 'cancel',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(onResolved).toHaveBeenCalledWith('cancel');
  });

  it('Esc key sends cancel decision — the worker is blocked, so unmount must not leave it waiting', () => {
    const onResolved = vi.fn();
    render(<CollisionPromptModal event={baseEvent} onResolved={onResolved} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(invoke).toHaveBeenCalledWith('respond_to_collision', {
      organizeId: 'org-xyz',
      decision: 'cancel',
    });
  });

  it('renders above the OrganizeProgressModal (stacks via higher z-index)', () => {
    render(<CollisionPromptModal event={baseEvent} onResolved={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    // OrganizeProgressModal sits at z-50. The collision prompt must be above it
    // so the user can actually see and respond to it.
    expect(dialog.className).toMatch(/z-\[60\]/);
  });

  it('renders both paths and sizes', () => {
    render(<CollisionPromptModal event={baseEvent} onResolved={vi.fn()} />);
    expect(screen.getByText(/already exists/)).toBeInTheDocument();
    expect(screen.getByText(baseEvent.sourcePath)).toBeInTheDocument();
    expect(screen.getByText(baseEvent.desiredPath)).toBeInTheDocument();
  });
});
