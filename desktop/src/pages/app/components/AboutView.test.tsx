import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { getVersion } from '@tauri-apps/api/app';
import AboutView from './AboutView';

describe('AboutView', () => {
  it('shows the version returned by Tauri getVersion()', async () => {
    vi.mocked(getVersion).mockResolvedValueOnce('1.2.3');
    render(<AboutView />);
    await waitFor(() => {
      expect(screen.getByText('1.2.3')).toBeInTheDocument();
    });
  });

  it('renders a placeholder until the version resolves', async () => {
    let resolveVersion: (v: string) => void = () => {};
    vi.mocked(getVersion).mockImplementationOnce(
      () => new Promise<string>((res) => { resolveVersion = res; }),
    );
    render(<AboutView />);
    expect(screen.getByText('…')).toBeInTheDocument();
    resolveVersion('9.9.9');
    await waitFor(() => {
      expect(screen.getByText('9.9.9')).toBeInTheDocument();
    });
  });
});
