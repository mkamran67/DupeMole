import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});
