import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import FilterPanel from './FilterPanel';
import { DEFAULT_ANALYSIS_FILTERS } from '../../../settings/SettingsContext';

vi.mock('../../../settings/SettingsContext', async () => {
  const actual = await vi.importActual<typeof import('../../../settings/SettingsContext')>(
    '../../../settings/SettingsContext'
  );
  return {
    ...actual,
    useSettings: vi.fn(),
  };
});

import { useSettings } from '../../../settings/SettingsContext';
const mockUseSettings = vi.mocked(useSettings);

beforeEach(() => {
  mockUseSettings.mockReturnValue({
    settings: {
      confirmDelete: true,
      scanThreads: 'Auto' as const,
      notifications: true,
      ignoreHidden: false,
      autoScan: false,
      minimizeTray: true,
      language: 'English',
      scanFilters: { ...DEFAULT_ANALYSIS_FILTERS, ignoreHidden: undefined },
      organizeFilters: { ...DEFAULT_ANALYSIS_FILTERS, ignoreHidden: undefined },
      analysisFilters: DEFAULT_ANALYSIS_FILTERS,
      customFileTypes: [],
    },
    loaded: true,
    updateSettings: vi.fn(),
    updateScanFilters: vi.fn(),
    updateOrganizeFilters: vi.fn(),
    updateAnalysisFilters: vi.fn(),
  });
});

describe('FilterPanel — File Size section', () => {
  for (const kind of ['scan', 'organize', 'analysis'] as const) {
    it(`on ${kind} page: renders the size slider and does NOT render the bucket pill buttons`, () => {
      render(<FilterPanel kind={kind} />);
      expect(screen.getByLabelText('Minimum size')).toBeInTheDocument();
      expect(screen.getByLabelText('Maximum size')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '< 1 MB' })).toBeNull();
      expect(screen.queryByRole('button', { name: '1 - 10 MB' })).toBeNull();
      expect(screen.queryByRole('button', { name: '10 - 100 MB' })).toBeNull();
      expect(screen.queryByRole('button', { name: '> 100 MB' })).toBeNull();
    });
  }
});
