import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SizeRangeSlider, { SIZE_STOPS } from './SizeRangeSlider';

describe('SizeRangeSlider', () => {
  it('renders min and max handles', () => {
    render(<SizeRangeSlider minSize={null} maxSize={null} onChange={() => {}} />);
    expect(screen.getByLabelText('Minimum size')).toBeInTheDocument();
    expect(screen.getByLabelText('Maximum size')).toBeInTheDocument();
  });

  it('SIZE_STOPS starts at 0 and ends at a >= 1 GB value', () => {
    expect(SIZE_STOPS[0]).toBe(0);
    expect(SIZE_STOPS[SIZE_STOPS.length - 1]).toBeGreaterThanOrEqual(
      1024 * 1024 * 1024
    );
  });

  it('moving the min handle calls onChange with the matching stop (null at index 0)', () => {
    const onChange = vi.fn();
    render(<SizeRangeSlider minSize={null} maxSize={null} onChange={onChange} />);
    const minSlider = screen.getByLabelText('Minimum size') as HTMLInputElement;
    fireEvent.change(minSlider, { target: { value: '3' } });
    expect(onChange).toHaveBeenCalledWith({
      minSize: SIZE_STOPS[3],
      maxSize: null,
    });
  });

  it('moving the max handle below current min clamps min', () => {
    const onChange = vi.fn();
    const midIdx = 5;
    render(
      <SizeRangeSlider
        minSize={SIZE_STOPS[midIdx]}
        maxSize={null}
        onChange={onChange}
      />
    );
    const maxSlider = screen.getByLabelText('Maximum size') as HTMLInputElement;
    fireEvent.change(maxSlider, { target: { value: '2' } });
    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(last.maxSize).toBe(SIZE_STOPS[2]);
    expect(last.minSize).toBe(SIZE_STOPS[2]);
  });

  it('sliding max to the last index emits null (no upper bound)', () => {
    const onChange = vi.fn();
    render(
      <SizeRangeSlider minSize={null} maxSize={1024 * 1024} onChange={onChange} />
    );
    const maxSlider = screen.getByLabelText('Maximum size') as HTMLInputElement;
    fireEvent.change(maxSlider, {
      target: { value: String(SIZE_STOPS.length - 1) },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      minSize: null,
      maxSize: null,
    });
  });

  it('renders human-readable min and max labels', () => {
    render(
      <SizeRangeSlider
        minSize={1024}
        maxSize={1024 * 1024}
        onChange={() => {}}
      />
    );
    expect(screen.getByText(/1 KB/i)).toBeInTheDocument();
    expect(screen.getByText(/1 MB/i)).toBeInTheDocument();
  });
});
