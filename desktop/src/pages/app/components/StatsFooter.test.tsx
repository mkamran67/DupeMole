import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import StatsFooter from './StatsFooter';
import type { LifetimeStats } from '../../../stats/StatsContext';

vi.mock('../../../stats/StatsContext', async () => {
  return {
    useStats: vi.fn(),
  };
});

import { useStats } from '../../../stats/StatsContext';
const mockUseStats = vi.mocked(useStats);

const setStats = (stats: LifetimeStats) => {
  mockUseStats.mockReturnValue({ stats, refresh: vi.fn() });
};

describe('StatsFooter', () => {
  it('shows the empty-state message when no scans have been run', () => {
    setStats({ totalBytesFreed: 0, totalFilesDeleted: 0, totalScansRun: 0 });
    render(<StatsFooter />);
    expect(screen.getByText(/run your first scan/i)).toBeInTheDocument();
  });

  it('shows lifetime stats once at least one scan has run', () => {
    setStats({ totalBytesFreed: 2048, totalFilesDeleted: 5, totalScansRun: 3 });
    render(<StatsFooter />);
    expect(screen.getByText(/all time/i)).toBeInTheDocument();
    expect(screen.getByText('2.00 KB')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('uses singular noun when exactly one duplicate was removed', () => {
    setStats({ totalBytesFreed: 100, totalFilesDeleted: 1, totalScansRun: 1 });
    render(<StatsFooter />);
    expect(screen.getByText(/duplicate removed/i)).toBeInTheDocument();
    expect(screen.getByText(/scan run/i)).toBeInTheDocument();
  });

  it('uses plural noun when multiple files were removed', () => {
    setStats({ totalBytesFreed: 100, totalFilesDeleted: 7, totalScansRun: 4 });
    render(<StatsFooter />);
    expect(screen.getByText(/duplicates removed/i)).toBeInTheDocument();
    expect(screen.getByText(/scans run/i)).toBeInTheDocument();
  });

  it('still renders when files were deleted but no scans tracked (legacy state)', () => {
    setStats({ totalBytesFreed: 50, totalFilesDeleted: 2, totalScansRun: 0 });
    render(<StatsFooter />);
    expect(screen.getByText(/all time/i)).toBeInTheDocument();
  });
});
