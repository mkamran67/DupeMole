import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ResultsProvider, useResults } from '../results/ResultsContext';
import { ScanProvider, useScan } from './ScanContext';

type ProgressHandler = (e: { payload: unknown }) => void;
type CompleteHandler = (e: { payload: unknown }) => void;

let progressHandler: ProgressHandler | null = null;
let completeHandler: CompleteHandler | null = null;

beforeEach(() => {
  progressHandler = null;
  completeHandler = null;
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === 'get_last_scan') return null;
    if (cmd === 'start_scan') return 'ok';
    if (cmd === 'cancel_scan') return undefined;
    return undefined;
  });
  vi.mocked(listen).mockImplementation(async (event: string, cb: ProgressHandler) => {
    if (event === 'scan://progress') progressHandler = cb;
    if (event === 'scan://complete') completeHandler = cb as CompleteHandler;
    return () => undefined;
  });
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      'scan-id-1' as `${string}-${string}-${string}-${string}-${string}`
    );
  }
});

function Probe() {
  const s = useScan();
  const r = useResults();
  return (
    <div>
      <div data-testid="scanning">{String(s.scanning)}</div>
      <div data-testid="progress">{s.progress.toFixed(2)}</div>
      <div data-testid="phase">{s.phase ?? 'null'}</div>
      <div data-testid="currentPath">{s.currentPath ?? 'null'}</div>
      <div data-testid="phaseProcessed">{s.phaseProcessed}</div>
      <div data-testid="phaseTotal">{s.phaseTotal}</div>
      <div data-testid="latest">{r.latestScan ? 'set' : 'null'}</div>
      <button onClick={() => s.startScan(['/a'])}>start</button>
      <button onClick={() => s.cancelScan()}>cancel</button>
    </div>
  );
}

function renderProbe() {
  return render(
    <ResultsProvider>
      <ScanProvider>
        <Probe />
      </ScanProvider>
    </ResultsProvider>
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ScanContext', () => {
  it('startScan invokes start_scan and sets scanning=true', async () => {
    renderProbe();
    await flush();
    await act(async () => {
      screen.getByText('start').click();
    });
    await flush();
    expect(screen.getByTestId('scanning').textContent).toBe('true');
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('start_scan', {
      paths: ['/a'],
      scanId: 'scan-id-1',
    });
  });

  it('hashing progress maps to weighted 30–80% band', async () => {
    renderProbe();
    await flush();
    await act(async () => {
      screen.getByText('start').click();
    });
    await flush();
    await act(async () => {
      progressHandler?.({
        payload: {
          scanId: 'scan-id-1',
          progress: {
            processed: 50,
            total: 100,
            currentPath: '/x/y',
            phase: 'hashing',
          },
        },
      });
    });
    expect(screen.getByTestId('phase').textContent).toBe('hashing');
    expect(screen.getByTestId('currentPath').textContent).toBe('/x/y');
    const pct = Number(screen.getByTestId('progress').textContent);
    expect(pct).toBeGreaterThanOrEqual(54);
    expect(pct).toBeLessThanOrEqual(56);
  });

  it('discovery phase stays in 0–30% band', async () => {
    renderProbe();
    await flush();
    await act(async () => {
      screen.getByText('start').click();
    });
    await flush();
    await act(async () => {
      progressHandler?.({
        payload: {
          scanId: 'scan-id-1',
          progress: {
            processed: 100,
            total: 0,
            currentPath: '/a/b',
            phase: 'discovery',
            folderIndex: 0,
            folderTotal: 1,
          },
        },
      });
    });
    const pct = Number(screen.getByTestId('progress').textContent);
    expect(pct).toBeGreaterThanOrEqual(0);
    expect(pct).toBeLessThanOrEqual(30);
  });

  it('cancelScan with no active scan does not call invoke', async () => {
    renderProbe();
    await flush();
    vi.mocked(invoke).mockClear();
    await act(async () => {
      screen.getByText('cancel').click();
    });
    await flush();
    expect(
      vi.mocked(invoke).mock.calls.find((c) => c[0] === 'cancel_scan')
    ).toBeUndefined();
  });

  it('cancelScan after start invokes cancel_scan with scanId', async () => {
    renderProbe();
    await flush();
    await act(async () => {
      screen.getByText('start').click();
    });
    await flush();
    await act(async () => {
      screen.getByText('cancel').click();
    });
    await flush();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('cancel_scan', {
      scanId: 'scan-id-1',
    });
  });

  it('scan://complete clears scanning and sets latestScan', async () => {
    renderProbe();
    await flush();
    await act(async () => {
      screen.getByText('start').click();
    });
    await flush();
    await act(async () => {
      completeHandler?.({
        payload: {
          scanId: 'scan-id-1',
          result: {
            groups: [],
            totalFiles: 10,
            duplicateFiles: 0,
            wastedBytes: 0,
            extensionCounts: {},
          },
        },
      });
    });
    await flush();
    expect(screen.getByTestId('scanning').textContent).toBe('false');
    expect(screen.getByTestId('latest').textContent).toBe('set');
  });
});
