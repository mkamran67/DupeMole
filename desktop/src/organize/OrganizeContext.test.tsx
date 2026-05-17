import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { OrganizeProvider, useOrganize } from './OrganizeContext';

type Handler = (e: { payload: unknown }) => void;
let progressHandler: Handler | null = null;
let completeHandler: Handler | null = null;

beforeEach(() => {
  progressHandler = null;
  completeHandler = null;
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === 'start_organize') return 'org-1';
    if (cmd === 'cancel_organize') return undefined;
    return undefined;
  });
  vi.mocked(listen).mockImplementation(async (event: string, cb: Handler) => {
    if (event === 'organize://progress') progressHandler = cb;
    if (event === 'organize://complete') completeHandler = cb;
    return () => undefined;
  });
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      'org-1' as `${string}-${string}-${string}-${string}-${string}`
    );
  }
});

function Probe() {
  const o = useOrganize();
  return (
    <div>
      <div data-testid="running">{String(o.running)}</div>
      <div data-testid="progress">{o.progress.toFixed(2)}</div>
      <div data-testid="phase">{o.phase ?? 'null'}</div>
      <div data-testid="processed">{o.processed}</div>
      <div data-testid="total">{o.total}</div>
      <div data-testid="op">{o.op ?? 'null'}</div>
      <div data-testid="speed">{o.speedBytesPerSec ?? 'null'}</div>
      <div data-testid="cfb">{o.currentFileBytes ?? 'null'}</div>
      <div data-testid="cft">{o.currentFileTotal ?? 'null'}</div>
      <button
        onClick={() =>
          o.startOrganize({
            sources: ['/a'],
            target: '/t',
            op: 'copy',
            granularity: { year: true, month: true, day: false },
            extensions: null,
            minSize: null,
            maxSize: null,
            ignoreMacosFiles: false,
            writeFilenameDate: false,
            skipImagesWithExistingDate: false,
          })
        }
      >
        start
      </button>
      <button onClick={() => o.cancelOrganize()}>cancel</button>
    </div>
  );
}

const wrap = () =>
  render(
    <OrganizeProvider>
      <Probe />
    </OrganizeProvider>
  );

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('OrganizeContext', () => {
  it('startOrganize invokes start_organize with given args and flips running=true', async () => {
    wrap();
    await flush();
    await act(async () => {
      screen.getByText('start').click();
    });
    await flush();
    expect(screen.getByTestId('running').textContent).toBe('true');
    expect(screen.getByTestId('op').textContent).toBe('copy');
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      'start_organize',
      expect.objectContaining({ organizeId: 'org-1', sources: ['/a'], target: '/t' })
    );
  });

  it('forwards maxSize to start_organize', async () => {
    wrap();
    await flush();
    await act(async () => {
      screen.getByText('start').click();
    });
    await flush();
    const call = vi
      .mocked(invoke)
      .mock.calls.find((c) => c[0] === 'start_organize');
    expect(call).toBeDefined();
    const payload = call![1] as Record<string, unknown>;
    expect(payload).toHaveProperty('maxSize');
  });

  it('progress events during organizing phase scale 20→100%', async () => {
    wrap();
    await flush();
    await act(async () => {
      screen.getByText('start').click();
    });
    await flush();
    await act(async () => {
      progressHandler?.({
        payload: {
          organizeId: 'org-1',
          progress: {
            processed: 50,
            total: 100,
            currentPath: '/x',
            phase: 'organizing',
          },
        },
      });
    });
    expect(screen.getByTestId('phase').textContent).toBe('organizing');
    const pct = Number(screen.getByTestId('progress').textContent);
    expect(pct).toBeGreaterThanOrEqual(59);
    expect(pct).toBeLessThanOrEqual(61);
  });

  it('derives speedBytesPerSec from byte/elapsed deltas between two organizing samples', async () => {
    wrap();
    await flush();
    await act(async () => {
      screen.getByText('start').click();
    });
    await flush();
    await act(async () => {
      progressHandler?.({
        payload: {
          organizeId: 'org-1',
          progress: {
            processed: 10,
            total: 100,
            currentPath: '/x',
            phase: 'organizing',
            bytesProcessed: 1_000_000,
            elapsedMs: 1000,
          },
        },
      });
    });
    // First sample: no prior → speed null
    expect(screen.getByTestId('speed').textContent).toBe('null');
    await act(async () => {
      progressHandler?.({
        payload: {
          organizeId: 'org-1',
          progress: {
            processed: 20,
            total: 100,
            currentPath: '/y',
            phase: 'organizing',
            bytesProcessed: 3_000_000,
            elapsedMs: 2000,
          },
        },
      });
    });
    // Δbytes = 2_000_000, Δms = 1000 → 2_000_000 B/s
    expect(Number(screen.getByTestId('speed').textContent)).toBe(2_000_000);
  });

  it('resets speedBytesPerSec when phase leaves organizing', async () => {
    wrap();
    await flush();
    await act(async () => {
      screen.getByText('start').click();
    });
    await flush();
    await act(async () => {
      progressHandler?.({
        payload: {
          organizeId: 'org-1',
          progress: {
            processed: 1,
            total: 10,
            currentPath: '/x',
            phase: 'organizing',
            bytesProcessed: 1000,
            elapsedMs: 100,
          },
        },
      });
      progressHandler?.({
        payload: {
          organizeId: 'org-1',
          progress: {
            processed: 2,
            total: 10,
            currentPath: '/y',
            phase: 'organizing',
            bytesProcessed: 2000,
            elapsedMs: 200,
          },
        },
      });
    });
    expect(screen.getByTestId('speed').textContent).not.toBe('null');
    await act(async () => {
      progressHandler?.({
        payload: {
          organizeId: 'org-1',
          progress: {
            processed: 5,
            total: 0,
            currentPath: '/z',
            phase: 'walking',
            bytesProcessed: 0,
            elapsedMs: 0,
          },
        },
      });
    });
    expect(screen.getByTestId('speed').textContent).toBe('null');
  });

  it('exposes currentFileBytes/currentFileTotal from progress events and clears them on complete', async () => {
    wrap();
    await flush();
    await act(async () => {
      screen.getByText('start').click();
    });
    await flush();
    await act(async () => {
      progressHandler?.({
        payload: {
          organizeId: 'org-1',
          progress: {
            processed: 1,
            total: 10,
            currentPath: '/big',
            phase: 'organizing',
            bytesProcessed: 5_000_000,
            elapsedMs: 500,
            currentFileBytes: 4_000_000,
            currentFileTotal: 10_000_000,
          },
        },
      });
    });
    expect(screen.getByTestId('cfb').textContent).toBe('4000000');
    expect(screen.getByTestId('cft').textContent).toBe('10000000');
    await act(async () => {
      completeHandler?.({
        payload: {
          organizeId: 'org-1',
          result: {
            processed: 1,
            copied: 1,
            moved: 0,
            skippedIdentical: 0,
            skippedByUser: 0,
            overwritten: 0,
            renamed: 0,
            metadataWritten: 0,
            metadataWriteFailed: 0,
            errors: [],
            cancelled: false,
            target: '/t',
          },
        },
      });
    });
    await flush();
    expect(screen.getByTestId('cfb').textContent).toBe('null');
    expect(screen.getByTestId('cft').textContent).toBe('null');
  });

  it('sliding-window speed averages across recent samples', async () => {
    wrap();
    await flush();
    await act(async () => {
      screen.getByText('start').click();
    });
    await flush();
    // 3 emits 100ms apart, each adding 1 MB → 1 MB / 100 ms = 10 MB/s.
    for (let i = 1; i <= 3; i++) {
      await act(async () => {
        progressHandler?.({
          payload: {
            organizeId: 'org-1',
            progress: {
              processed: 0,
              total: 10,
              currentPath: '/big',
              phase: 'organizing',
              bytesProcessed: i * 1_000_000,
              elapsedMs: i * 100,
            },
          },
        });
      });
    }
    const speed = Number(screen.getByTestId('speed').textContent);
    // Window spans 100→300ms → (3M - 1M) / (300 - 100) * 1000 = 10_000_000 B/s.
    expect(speed).toBe(10_000_000);
  });

  it('cancel before start does not invoke cancel_organize', async () => {
    wrap();
    await flush();
    vi.mocked(invoke).mockClear();
    await act(async () => {
      screen.getByText('cancel').click();
    });
    await flush();
    expect(
      vi.mocked(invoke).mock.calls.find((c) => c[0] === 'cancel_organize')
    ).toBeUndefined();
  });

  it('complete event clears running', async () => {
    wrap();
    await flush();
    await act(async () => {
      screen.getByText('start').click();
    });
    await flush();
    await act(async () => {
      completeHandler?.({
        payload: {
          organizeId: 'org-1',
          result: {
            processed: 10,
            copied: 10,
            moved: 0,
            skippedIdentical: 0,
            skippedByUser: 0,
            overwritten: 0,
            renamed: 0,
            metadataWritten: 0,
            metadataWriteFailed: 0,
            errors: [],
            cancelled: false,
            target: '/t',
          },
        },
      });
    });
    await flush();
    expect(screen.getByTestId('running').textContent).toBe('false');
  });
});
