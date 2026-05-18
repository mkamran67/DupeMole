import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { getVersion } from '@tauri-apps/api/app';
import SettingsView from './SettingsView';
import { SettingsProvider } from '../../../settings/SettingsContext';

function renderView() {
  return render(
    <SettingsProvider>
      <SettingsView />
    </SettingsProvider>
  );
}

describe('SettingsView', () => {
  it('does not show the Ignore Hidden Files toggle', () => {
    renderView();
    expect(screen.queryByText('Ignore Hidden Files')).toBeNull();
  });

  it('still shows other core settings', () => {
    renderView();
    expect(screen.getByText('Notifications')).toBeInTheDocument();
    expect(screen.getByText('Auto Scan on Launch')).toBeInTheDocument();
  });

  it('shows the version returned by Tauri getVersion()', async () => {
    vi.mocked(getVersion).mockResolvedValueOnce('1.2.3');
    renderView();
    await waitFor(() => {
      expect(screen.getByText('Version 1.2.3 • macOS & Linux')).toBeInTheDocument();
    });
  });
});
