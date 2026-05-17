import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import DebugView from './DebugView';

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(listen).mockReset();
  vi.mocked(listen).mockImplementation(async () => () => undefined);
});

describe('DebugView — filename-date parser tester', () => {
  it("calls parse_filename_date_test with the user's gif example and shows the parsed UTC date", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd === 'get_logs') return [];
      if (cmd === 'parse_filename_date_test') {
        const filename = (args as { filename: string }).filename;
        if (filename === '2018-10-07 00_32_48 +0000.gif') {
          return {
            input: filename,
            stem: '2018-10-07 00_32_48 +0000',
            parsedMs: 1_538_872_368_000,
            formattedUtc: '2018-10-07 00:32:48 UTC',
          };
        }
      }
      return null;
    });

    render(<DebugView />);
    // The default input is preloaded to the example; wait for the debounce
    // and verify the parser command got invoked + the formatted date appears.
    await waitFor(
      () => {
        expect(vi.mocked(invoke)).toHaveBeenCalledWith('parse_filename_date_test', {
          filename: '2018-10-07 00_32_48 +0000.gif',
        });
      },
      { timeout: 1000 }
    );
    expect(await screen.findByText('2018-10-07 00:32:48 UTC')).toBeInTheDocument();
    expect(screen.getByText('2018-10-07 00_32_48 +0000')).toBeInTheDocument();
    expect(screen.getByText('1,538,872,368,000')).toBeInTheDocument();
  });

  it('shows "null (no date found)" when the parser returns no match', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'get_logs') return [];
      if (cmd === 'parse_filename_date_test') {
        return {
          input: 'vacation.jpg',
          stem: 'vacation',
          parsedMs: null,
          formattedUtc: null,
        };
      }
      return null;
    });

    render(<DebugView />);
    const user = userEvent.setup();
    const input = screen.getByLabelText(/filename/i);
    await user.clear(input);
    await user.type(input, 'vacation.jpg');
    // Wait for debounce + invoke to settle
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(await screen.findByText(/null \(no date found\)/i)).toBeInTheDocument();
  });
});

describe('DebugView — log feed', () => {
  it('renders existing log entries from get_logs', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'get_logs') {
        return [
          {
            timestampMs: Date.UTC(2026, 4, 16, 12, 0, 0),
            level: 'error',
            source: 'scan',
            message: 'save_last_scan failed: disk full',
          },
        ];
      }
      if (cmd === 'parse_filename_date_test') {
        return { input: '', stem: null, parsedMs: null, formattedUtc: null };
      }
      return null;
    });

    render(<DebugView />);
    expect(await screen.findByText(/save_last_scan failed: disk full/)).toBeInTheDocument();
    expect(screen.getByText('scan')).toBeInTheDocument();
    // The "error" label appears both as a filter button and as the entry's
    // level chip — confirm the chip is present by querying the spans inside
    // the log row, not the filter buttons.
    const chips = screen
      .getAllByText('error')
      .filter((el) => el.tagName.toLowerCase() === 'span');
    expect(chips.length).toBeGreaterThan(0);
  });

  it('clear button invokes clear_logs and empties the list', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'get_logs') {
        return [
          {
            timestampMs: Date.UTC(2026, 4, 16, 12, 0, 0),
            level: 'info',
            source: 'organize',
            message: 'done',
          },
        ];
      }
      if (cmd === 'clear_logs') return null;
      if (cmd === 'parse_filename_date_test') {
        return { input: '', stem: null, parsedMs: null, formattedUtc: null };
      }
      return null;
    });

    render(<DebugView />);
    expect(await screen.findByText('done')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /clear/i }));

    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith('clear_logs');
    });
    expect(screen.queryByText('done')).not.toBeInTheDocument();
  });
});
