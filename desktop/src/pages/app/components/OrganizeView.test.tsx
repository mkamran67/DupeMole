import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import OrganizeView from './OrganizeView';
import { OrganizeProvider } from '../../../organize/OrganizeContext';
import { DEFAULT_FILTERS } from '../../../settings/SettingsContext';

function renderView() {
  return render(
    <OrganizeProvider>
      <OrganizeView />
    </OrganizeProvider>
  );
}

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

function settingsWith(
  writeFilenameDateMetadata: boolean | undefined,
  skipImagesWithExistingDate?: boolean | undefined
) {
  return {
    confirmDelete: true,
    scanThreads: 'Auto' as const,
    notifications: true,
    ignoreHidden: false,
    autoScan: false,
    minimizeTray: true,
    language: 'English',
    scanFilters: DEFAULT_FILTERS,
    organizeFilters: {
      ...DEFAULT_FILTERS,
      writeFilenameDateMetadata,
      skipImagesWithExistingDate,
    },
    analysisFilters: DEFAULT_FILTERS,
    customFileTypes: [],
  };
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue('organize-id-1');
  vi.mocked(openDialog).mockResolvedValue('/tmp/some/folder');
  vi.mocked(listen).mockImplementation(async () => () => undefined);
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      'organize-id-1' as `${string}-${string}-${string}-${string}-${string}`
    );
  }
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function pickSourceAndTarget() {
  const user = userEvent.setup();
  // Add source
  await user.click(screen.getByRole('button', { name: /add sources?/i }));
  await flush();
  // Pick target
  await user.click(screen.getByRole('button', { name: /set target|target folder|choose target/i }));
  await flush();
}

describe('OrganizeView — write-filename-date toggle', () => {
  it('renders the date metadata section', () => {
    mockUseSettings.mockReturnValue({
      settings: settingsWith(undefined),
      loaded: true,
      updateSettings: vi.fn(),
      updateScanFilters: vi.fn(),
      updateOrganizeFilters: vi.fn(),
      updateAnalysisFilters: vi.fn(),
    });
    renderView();
    expect(screen.getByText(/date metadata/i)).toBeInTheDocument();
    expect(
      screen.getByText(/write parsed filename date into image & video metadata/i)
    ).toBeInTheDocument();
  });

  it('toggle reflects settings.organizeFilters.writeFilenameDateMetadata', () => {
    mockUseSettings.mockReturnValue({
      settings: settingsWith(true),
      loaded: true,
      updateSettings: vi.fn(),
      updateScanFilters: vi.fn(),
      updateOrganizeFilters: vi.fn(),
      updateAnalysisFilters: vi.fn(),
    });
    renderView();
    const cb = screen.getByRole('checkbox', {
      name: /write parsed filename date/i,
    });
    expect(cb).toHaveAttribute('aria-checked', 'true');
  });

  it('clicking the toggle calls updateOrganizeFilters with inverted value', async () => {
    const updateOrganizeFilters = vi.fn(async () => undefined);
    mockUseSettings.mockReturnValue({
      settings: settingsWith(false),
      loaded: true,
      updateSettings: vi.fn(),
      updateScanFilters: vi.fn(),
      updateOrganizeFilters,
      updateAnalysisFilters: vi.fn(),
    });
    renderView();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole('checkbox', { name: /write parsed filename date/i })
    );
    expect(updateOrganizeFilters).toHaveBeenCalledWith({
      writeFilenameDateMetadata: true,
    });
  });
});

describe('OrganizeView — skip-images-with-existing-date sub-toggle', () => {
  it('does not render sub-toggle when parent toggle is off', () => {
    mockUseSettings.mockReturnValue({
      settings: settingsWith(false, undefined),
      loaded: true,
      updateSettings: vi.fn(),
      updateScanFilters: vi.fn(),
      updateOrganizeFilters: vi.fn(),
      updateAnalysisFilters: vi.fn(),
    });
    renderView();
    expect(
      screen.queryByRole('checkbox', { name: /only process images without date metadata/i })
    ).not.toBeInTheDocument();
  });

  it('renders sub-toggle reflecting stored value when parent toggle is on', () => {
    mockUseSettings.mockReturnValue({
      settings: settingsWith(true, true),
      loaded: true,
      updateSettings: vi.fn(),
      updateScanFilters: vi.fn(),
      updateOrganizeFilters: vi.fn(),
      updateAnalysisFilters: vi.fn(),
    });
    renderView();
    const cb = screen.getByRole('checkbox', {
      name: /only process images without date metadata/i,
    });
    expect(cb).toHaveAttribute('aria-checked', 'true');
  });

  it('clicking sub-toggle calls updateOrganizeFilters with inverted value', async () => {
    const updateOrganizeFilters = vi.fn(async () => undefined);
    mockUseSettings.mockReturnValue({
      settings: settingsWith(true, false),
      loaded: true,
      updateSettings: vi.fn(),
      updateScanFilters: vi.fn(),
      updateOrganizeFilters,
      updateAnalysisFilters: vi.fn(),
    });
    renderView();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole('checkbox', { name: /only process images without date metadata/i })
    );
    expect(updateOrganizeFilters).toHaveBeenCalledWith({
      skipImagesWithExistingDate: true,
    });
  });
});
