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
