import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CustomFileTypeModal from './CustomFileTypeModal';

describe('CustomFileTypeModal', () => {
  it('Create button is disabled until name AND at least one extension are present', () => {
    render(<CustomFileTypeModal onClose={vi.fn()} onCreate={vi.fn()} />);
    const create = screen.getByRole('button', { name: 'Create' });
    expect(create).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Logs' } });
    expect(create).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Extensions'), { target: { value: '.log' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(create).toBeEnabled();
  });

  it('strips leading dots and lowercases extensions, dedupes, accepts comma lists', () => {
    const onCreate = vi.fn();
    render(<CustomFileTypeModal onClose={vi.fn()} onCreate={onCreate} />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Logs' } });
    fireEvent.change(screen.getByLabelText('Extensions'), { target: { value: '.LOG, BAK, log' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith('Logs', ['log', 'bak']);
  });

  it('Esc key closes the modal', () => {
    const onClose = vi.fn();
    render(<CustomFileTypeModal onClose={onClose} onCreate={vi.fn()} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('clicking the X (Close) button calls onClose', () => {
    const onClose = vi.fn();
    render(<CustomFileTypeModal onClose={onClose} onCreate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('allows removing extensions before submitting', () => {
    const onCreate = vi.fn();
    render(<CustomFileTypeModal onClose={vi.fn()} onCreate={onCreate} />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText('Extensions'), { target: { value: '.a, .b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove .a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(onCreate).toHaveBeenCalledWith('X', ['b']);
  });
});
