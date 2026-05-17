import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

interface LogEntry {
  timestampMs: number;
  level: string;
  source: string;
  message: string;
}

interface ParseResult {
  input: string;
  stem: string | null;
  parsedMs: number | null;
  formattedUtc: string | null;
}

const EXAMPLES = [
  '2018-10-07 00_32_48 +0000.gif',
  '2025-02-11.jpg',
  'IMG_20240315_143015.jpg',
  'screenshot-2025-02-11-at-3pm.png',
  'vacation.jpg',
];

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function levelStyle(level: string): string {
  switch (level) {
    case 'error':
      return 'text-[#c45c5c] bg-[#c45c5c]/10 border-[#c45c5c]/30';
    case 'warn':
      return 'text-[#f5c542] bg-[#f5c542]/10 border-[#f5c542]/30';
    case 'info':
    default:
      return 'text-white/70 bg-white/5 border-white/10';
  }
}

export default function DebugView() {
  // ── Filename-date parser tester ─────────────────────────────────────
  const [input, setInput] = useState<string>(EXAMPLES[0]);
  const [result, setResult] = useState<ParseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<number | null>(null);

  // Debounced: as the user types, ask the Rust backend to parse. Cheap,
  // pure function — no I/O — so 120ms keeps it snappy without firing on
  // every keystroke.
  useEffect(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
    }
    if (!input) {
      setResult(null);
      setError(null);
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      invoke<ParseResult>('parse_filename_date_test', { filename: input })
        .then((r) => {
          setResult(r);
          setError(null);
        })
        .catch((err) => {
          setError(String(err));
          setResult(null);
        });
    }, 120);
    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
      }
    };
  }, [input]);

  // ── Log feed ───────────────────────────────────────────────────────
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [levelFilter, setLevelFilter] = useState<'all' | 'info' | 'warn' | 'error'>('all');

  const refreshLogs = useCallback(async () => {
    try {
      const list = await invoke<LogEntry[]>('get_logs');
      setLogs(list);
    } catch (err) {
      console.error('get_logs failed', err);
    }
  }, []);

  useEffect(() => {
    void refreshLogs();
    let unlisten: UnlistenFn | null = null;
    void listen<LogEntry>('log://new', (e) => {
      setLogs((prev) => {
        const next = [...prev, e.payload];
        // Match backend cap of 500 so UI doesn't grow without bound either.
        return next.length > 500 ? next.slice(next.length - 500) : next;
      });
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, [refreshLogs]);

  const clearLogs = useCallback(async () => {
    try {
      await invoke('clear_logs');
      setLogs([]);
    } catch (err) {
      console.error('clear_logs failed', err);
    }
  }, []);

  const filteredLogs = useMemo(() => {
    const sorted = [...logs].sort((a, b) => b.timestampMs - a.timestampMs);
    if (levelFilter === 'all') return sorted;
    return sorted.filter((l) => l.level === levelFilter);
  }, [logs, levelFilter]);

  return (
    <div className="min-h-full flex flex-col max-w-5xl mx-auto">
      <header className="mb-6">
        <h1 className="text-white text-2xl font-bold flex items-center gap-3">
          <i className="ri-bug-line text-[#f5c542]"></i>
          Debug
        </h1>
        <p className="text-white/40 text-sm mt-1">
          Test the filename-date parser and inspect recent log events.
        </p>
      </header>

      {/* Filename-date parser tester */}
      <section className="bg-[#3d2418] rounded-2xl border border-white/10 p-5 mb-6">
        <p className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-3">
          Filename-Date Parser
        </p>

        <label htmlFor="debug-parser-input" className="block text-white/60 text-xs mb-2">
          Filename (including extension)
        </label>
        <input
          id="debug-parser-input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. 2018-10-07 00_32_48 +0000.gif"
          className="w-full bg-[#2c1810] border border-white/10 rounded-xl px-4 py-3 text-white text-sm font-mono placeholder:text-white/30 focus:outline-none focus:border-[#f5c542]/50"
        />

        <div className="mt-3 flex flex-wrap gap-2">
          <span className="text-white/30 text-xs self-center mr-1">Examples:</span>
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setInput(ex)}
              className="text-[11px] font-mono px-2.5 py-1 rounded-full border border-white/10 text-white/60 hover:text-white hover:border-white/30 cursor-pointer transition-all"
            >
              {ex}
            </button>
          ))}
        </div>

        <div className="mt-4 rounded-xl bg-[#2c1810] border border-white/5 p-4">
          <p className="text-white/30 text-[10px] font-semibold uppercase tracking-wider mb-2">
            Parser output
          </p>
          {error ? (
            <p className="text-[#c45c5c] text-sm font-mono">{error}</p>
          ) : !result ? (
            <p className="text-white/40 text-xs italic">Enter a filename above to test.</p>
          ) : (
            <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-white/40 text-xs">input</dt>
              <dd className="text-white/80 font-mono break-all">{result.input}</dd>
              <dt className="text-white/40 text-xs">stem</dt>
              <dd className="text-white/80 font-mono break-all">
                {result.stem ?? <span className="text-white/30 italic">none</span>}
              </dd>
              <dt className="text-white/40 text-xs">parsed ms</dt>
              <dd
                className={`font-mono ${result.parsedMs === null ? 'text-[#c45c5c]' : 'text-[#f5c542]'}`}
              >
                {result.parsedMs === null ? 'null (no date found)' : result.parsedMs.toLocaleString()}
              </dd>
              <dt className="text-white/40 text-xs">UTC</dt>
              <dd
                className={`font-mono ${result.formattedUtc === null ? 'text-white/30 italic' : 'text-white/90'}`}
              >
                {result.formattedUtc ?? '—'}
              </dd>
            </dl>
          )}
        </div>

        <p className="text-white/30 text-[11px] mt-3 leading-relaxed">
          Calls{' '}
          <code className="text-white/50 font-mono">media_date::read_filename_date_ms</code>{' '}
          directly — the same function Organize uses to pick a date when EXIF /
          MP4 metadata is absent. No file I/O is performed.
        </p>
      </section>

      {/* Log feed */}
      <section className="bg-[#3d2418] rounded-2xl border border-white/10 p-5 mb-6">
        <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
          <p className="text-white/30 text-xs font-semibold uppercase tracking-wider">
            Logs ({filteredLogs.length})
          </p>
          <div className="flex items-center gap-2">
            {(['all', 'info', 'warn', 'error'] as const).map((lvl) => (
              <button
                key={lvl}
                type="button"
                onClick={() => setLevelFilter(lvl)}
                className={`text-[11px] font-medium px-2.5 py-1 rounded-full border transition-all cursor-pointer ${
                  levelFilter === lvl
                    ? 'border-[#f5c542] bg-[#f5c542]/15 text-[#f5c542]'
                    : 'border-white/10 text-white/50 hover:border-white/20'
                }`}
              >
                {lvl}
              </button>
            ))}
            <button
              type="button"
              onClick={() => void refreshLogs()}
              className="text-[11px] font-medium px-2.5 py-1 rounded-full border border-white/10 text-white/50 hover:text-white hover:border-white/30 cursor-pointer"
              title="Reload from backend"
            >
              <i className="ri-refresh-line mr-1"></i>
              Refresh
            </button>
            <button
              type="button"
              onClick={() => void clearLogs()}
              className="text-[11px] font-medium px-2.5 py-1 rounded-full border border-[#c45c5c]/30 text-[#c45c5c] hover:bg-[#c45c5c]/10 cursor-pointer"
            >
              <i className="ri-delete-bin-line mr-1"></i>
              Clear
            </button>
          </div>
        </div>

        {filteredLogs.length === 0 ? (
          <p className="text-white/40 text-xs italic px-1 py-4">
            No log events {levelFilter === 'all' ? 'yet' : `at level "${levelFilter}"`}.
          </p>
        ) : (
          <ul className="space-y-1.5 max-h-[28rem] overflow-y-auto pr-1">
            {filteredLogs.map((log, i) => (
              <li
                key={`${log.timestampMs}-${i}`}
                className="bg-[#2c1810] border border-white/5 rounded-lg p-3 flex gap-3 items-start"
              >
                <span
                  className={`shrink-0 text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded border ${levelStyle(log.level)}`}
                >
                  {log.level}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 mb-0.5">
                    <span className="text-white/40 text-[11px] font-mono">
                      {formatTimestamp(log.timestampMs)}
                    </span>
                    <span className="text-[#f5c542]/80 text-[11px] font-medium">
                      {log.source}
                    </span>
                  </div>
                  <p className="text-white/80 text-sm font-mono break-words whitespace-pre-wrap">
                    {log.message}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
