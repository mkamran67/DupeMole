import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { basename, dirname, formatBytes } from '../../../lib/format';

// Mirrors the Rust CollisionDecision enum (camelCase via serde).
export type CollisionDecision =
  | 'overwrite'
  | 'skip'
  | 'keepBoth'
  | 'overwriteAll'
  | 'skipAll'
  | 'keepBothAll'
  | 'cancel';

export interface CollisionEvent {
  organizeId: string;
  sourcePath: string;
  desiredPath: string;
  sourceSize: number;
  existingSize: number;
}

interface CollisionPromptModalProps {
  event: CollisionEvent;
  /** Called after a decision has been sent so the parent can clear the modal. */
  onResolved: (decision: CollisionDecision) => void;
}

interface Choice {
  label: string;
  decision: CollisionDecision;
  variant: 'primary' | 'danger' | 'neutral';
}

const CHOICES: Choice[] = [
  { label: 'Overwrite', decision: 'overwrite', variant: 'danger' },
  { label: 'Skip', decision: 'skip', variant: 'neutral' },
  { label: 'Keep Both', decision: 'keepBoth', variant: 'primary' },
  { label: 'Overwrite All', decision: 'overwriteAll', variant: 'danger' },
  { label: 'Skip All', decision: 'skipAll', variant: 'neutral' },
  { label: 'Keep Both All', decision: 'keepBothAll', variant: 'primary' },
];

function variantClasses(variant: Choice['variant']): string {
  if (variant === 'danger') {
    return 'bg-[#c45c5c] hover:bg-[#a84848] text-white border-[#c45c5c]';
  }
  if (variant === 'primary') {
    return 'bg-[#f5c542] hover:bg-[#e0b038] text-[#2c1810] border-[#f5c542]';
  }
  return 'bg-white/5 hover:bg-white/10 text-white border-white/15';
}

export default function CollisionPromptModal({ event, onResolved }: CollisionPromptModalProps) {
  const respond = async (decision: CollisionDecision) => {
    try {
      await invoke('respond_to_collision', {
        organizeId: event.organizeId,
        decision,
      });
    } catch (err) {
      console.error('respond_to_collision failed', err);
    }
    onResolved(decision);
  };

  // Closing via Esc is the same as Cancel — the worker is blocked waiting.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') respond('cancel');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.organizeId]);

  const sourceName = basename(event.sourcePath);
  const desiredDir = dirname(event.desiredPath);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Destination already exists"
    >
      <div className="w-full max-w-lg mx-4 rounded-2xl bg-[#2a1810] border border-white/15 shadow-2xl p-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-[#f5c542]/15 flex items-center justify-center shrink-0">
            <i className="ri-alert-line text-[#f5c542] text-xl"></i>
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-white text-lg font-semibold">
              "{sourceName}" already exists
            </h3>
            <p className="text-white/50 text-xs mt-1 truncate font-mono" title={desiredDir}>
              in {desiredDir}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
            <p className="text-emerald-300 text-[10px] font-semibold uppercase tracking-wider mb-1">
              Incoming
            </p>
            <p className="text-white text-xs font-mono truncate" title={event.sourcePath}>
              {event.sourcePath}
            </p>
            <p className="text-white/40 text-[11px] mt-1">{formatBytes(event.sourceSize)}</p>
          </div>
          <div className="rounded-lg border border-[#c45c5c]/40 bg-[#c45c5c]/5 p-3">
            <p className="text-[#c45c5c] text-[10px] font-semibold uppercase tracking-wider mb-1">
              Existing
            </p>
            <p className="text-white text-xs font-mono truncate" title={event.desiredPath}>
              {event.desiredPath}
            </p>
            <p className="text-white/40 text-[11px] mt-1">{formatBytes(event.existingSize)}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-3">
          {CHOICES.map((c) => (
            <button
              key={c.decision}
              onClick={() => respond(c.decision)}
              className={`text-sm font-semibold px-3 py-2 rounded-lg border transition-colors duration-150 cursor-pointer ${variantClasses(c.variant)}`}
            >
              {c.label}
            </button>
          ))}
        </div>

        <button
          onClick={() => respond('cancel')}
          className="w-full text-xs font-semibold px-3 py-2 rounded-lg border border-white/15 bg-transparent text-white/60 hover:bg-white/5 hover:text-white transition-colors duration-150 cursor-pointer"
        >
          Cancel Organize
        </button>
      </div>
    </div>
  );
}
