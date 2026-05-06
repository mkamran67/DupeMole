import { useState, useCallback, useRef, useEffect } from 'react';
import { duplicateGroups } from '@/mocks/scanResults';

interface ScanViewProps {
  onNavigateToResults?: () => void;
}

const mockDirectories = [
  { id: 1, name: '/Users/Photos', files: 4728, progress: 100, scanned: true },
  { id: 2, name: '/Users/Downloads', files: 2103, progress: 65, scanned: false },
  { id: 3, name: '/Users/Documents', files: 891, progress: 32, scanned: false },
];

const fileTypeStats = [
  { icon: 'ri-image-line', label: 'Images', count: '1,240', formats: 'JPG, PNG, WebP, RAW', color: '#f5c542' },
  { icon: 'ri-video-line', label: 'Videos', count: '86', formats: 'MP4, MOV, MKV, AVI', color: '#f5c542' },
  { icon: 'ri-file-pdf-line', label: 'PDFs', count: '402', formats: 'PDF, DOCX, TXT', color: '#f5c542' },
  { icon: 'ri-music-line', label: 'Audio', count: '1,033', formats: 'MP3, FLAC, WAV', color: '#f5c542' },
];

/* ------------------------------------------------------------------ */
/*  MoleScene — mole emerges from / sinks into its burrow hole        */
/* ------------------------------------------------------------------ */
function MoleScene({ scanning, dragActive }: { scanning: boolean; dragActive: boolean }) {
  return (
    <div className="relative w-full h-72 overflow-hidden select-none rounded-2xl">

      {/* ===== SKY / BACKGROUND ===== */}
      <div className="absolute inset-0 bg-gradient-to-b from-[#2c1810] via-[#3d2418] to-[#4a2e22]" />

      {/* Subtle underground texture dots */}
      <div className="absolute top-8 left-[15%] w-1.5 h-1.5 rounded-full bg-[#f5c542]/10" />
      <div className="absolute top-14 right-[20%] w-1 h-1 rounded-full bg-[#f5c542]/10" />
      <div className="absolute top-6 left-[60%] w-1 h-1 rounded-full bg-[#f5c542]/10" />
      <div className="absolute top-20 left-[40%] w-1.5 h-1.5 rounded-full bg-[#f5c542]/10" />

      {/* ===== HOLE DARK INTERIOR (back layer) ===== */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 w-40 h-14 bg-[#140a05] rounded-[100%] z-[1]" />
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 w-36 h-12 bg-[#0a0503] rounded-[100%] z-[1]" />

      {/* ===== GROUND HILLS (behind mole) ===== */}
      <div className="absolute bottom-0 left-0 right-0 h-24 bg-[#5c3a2a] rounded-t-[60%] z-[2]" />
      <div className="absolute bottom-0 left-0 right-0 h-16 bg-[#4a2e22] rounded-t-[50%] z-[2]" />

      {/* ===== IDLE MOLE (upright, peeking out) ===== */}
      {!scanning && (
        <div className="absolute bottom-12 left-1/2 -translate-x-1/2 z-[3]">
          <div className="flex flex-col items-center animate-[moleIdle_3.5s_ease-in-out_infinite]">
            <div className="w-28 h-32 bg-[#8B5E3C] rounded-t-[3rem] relative shadow-lg">
              <div className="absolute top-3 left-1/2 -translate-x-1/2 w-20 h-24 bg-[#a67b5b] rounded-t-[2.5rem] opacity-50" />

              {/* Fluffy ears */}
              <div className="absolute -top-3 -left-1 w-9 h-9 bg-[#8B5E3C] rounded-full" />
              <div className="absolute -top-3 -right-1 w-9 h-9 bg-[#8B5E3C] rounded-full" />
              <div className="absolute -top-1 left-1.5 w-5 h-5 bg-[#e89b9b] rounded-full" />
              <div className="absolute -top-1 right-1.5 w-5 h-5 bg-[#e89b9b] rounded-full" />

              {/* Big cute eyes */}
              <div className="absolute top-6 left-[1.35rem] w-5 h-5 bg-white rounded-full flex items-center justify-center animate-[moleBlink_3.5s_ease-in-out_infinite]">
                <div className="w-2.5 h-2.5 bg-[#1a0e08] rounded-full" />
                <div className="absolute top-1 right-1 w-1.5 h-1.5 bg-white rounded-full" />
              </div>
              <div className="absolute top-6 right-[1.35rem] w-5 h-5 bg-white rounded-full flex items-center justify-center animate-[moleBlink_3.5s_ease-in-out_infinite]">
                <div className="w-2.5 h-2.5 bg-[#1a0e08] rounded-full" />
                <div className="absolute top-1 right-1 w-1.5 h-1.5 bg-white rounded-full" />
              </div>

              {/* Cute curved eyebrows */}
              <div className="absolute top-3.5 left-[1.1rem] w-6 h-1.5 bg-[#5c3a2a] rounded-full rotate-[-15deg]" />
              <div className="absolute top-3.5 right-[1.1rem] w-6 h-1.5 bg-[#5c3a2a] rounded-full rotate-[15deg]" />

              {/* Round snout */}
              <div className="absolute top-[3.2rem] left-1/2 -translate-x-1/2 w-16 h-10 bg-[#c49a6c] rounded-full" />
              {/* Big shiny nose */}
              <div className="absolute top-[3rem] left-1/2 -translate-x-1/2 w-8 h-7 bg-[#e89b9b] rounded-full shadow-sm" />
              <div className="absolute top-[3.2rem] left-[calc(50%-0.6rem)] w-2.5 h-2 bg-white/50 rounded-full" />

              {/* Happy little mouth */}
              <div className="absolute top-[4.6rem] left-1/2 -translate-x-1/2 w-6 h-3 border-b-[3px] border-[#5c3a2a] rounded-b-full" />

              {/* Rosy blush cheeks */}
              <div className="absolute top-[4rem] left-2.5 w-5 h-3.5 bg-[#e89b9b]/50 rounded-full" />
              <div className="absolute top-[4rem] right-2.5 w-5 h-3.5 bg-[#e89b9b]/50 rounded-full" />

              {/* Whiskers */}
              <div className="absolute top-[3.8rem] left-[-0.4rem] w-7 h-px bg-[#5c3a2a]/40 rotate-[12deg]" />
              <div className="absolute top-[4.2rem] left-[-0.2rem] w-6 h-px bg-[#5c3a2a]/40" />
              <div className="absolute top-[4.6rem] left-[-0.1rem] w-7 h-px bg-[#5c3a2a]/40 rotate-[-10deg]" />
              <div className="absolute top-[3.8rem] right-[-0.4rem] w-7 h-px bg-[#5c3a2a]/40 rotate-[-12deg]" />
              <div className="absolute top-[4.2rem] right-[-0.2rem] w-6 h-px bg-[#5c3a2a]/40" />
              <div className="absolute top-[4.6rem] right-[-0.1rem] w-7 h-px bg-[#5c3a2a]/40 rotate-[10deg]" />

              {/* Little pink bow tie */}
              <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 flex items-center">
                <div className="w-3 h-4 bg-[#e89b9b] rounded-sm rotate-[-20deg]" />
                <div className="w-2 h-2 bg-[#d67a7a] rounded-full -mx-0.5" />
                <div className="w-3 h-4 bg-[#e89b9b] rounded-sm rotate-[20deg]" />
              </div>

              {/* Paws / Feet */}
              <div className="absolute -bottom-1 -left-6 w-11 h-11 bg-[#7a4f32] rounded-full shadow-md">
                <div className="absolute top-3 left-2.5 w-px h-4 bg-[#5c3a2a]/40 rotate-[-15deg]" />
                <div className="absolute top-3 left-4.5 w-px h-4 bg-[#5c3a2a]/40" />
                <div className="absolute top-3 left-6.5 w-px h-4 bg-[#5c3a2a]/40 rotate-[15deg]" />
              </div>
              <div className="absolute -bottom-1 -right-6 w-11 h-11 bg-[#7a4f32] rounded-full shadow-md">
                <div className="absolute top-3 right-2.5 w-px h-4 bg-[#5c3a2a]/40 rotate-[15deg]" />
                <div className="absolute top-3 right-4.5 w-px h-4 bg-[#5c3a2a]/40" />
                <div className="absolute top-3 right-6.5 w-px h-4 bg-[#5c3a2a]/40 rotate-[-15deg]" />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ===== SCANNING: upside-down mole — only legs stick out of the hole ===== */}
      {scanning && (
        <>
          {/* Cute little paws poking up from inside the hole (hidden behind dirt mound z-4) */}
          <div className="absolute bottom-[34px] left-1/2 -translate-x-1/2 z-[3] flex items-end gap-2">
            {/* Left paw */}
            <div className="animate-[legWiggleLeft_0.5s_ease-in-out_infinite] origin-bottom">
              <div className="w-12 h-10 bg-[#7a4f32] rounded-t-[2.5rem] relative shadow-md">
                {/* Pink paw pad */}
                <div className="absolute top-1.5 left-1/2 -translate-x-1/2 w-7 h-5 bg-[#e89b9b] rounded-full" />
                {/* Toe beans (3 little circles) */}
                <div className="absolute top-5 left-2 w-2 h-2 bg-[#f5c542]/40 rounded-full" />
                <div className="absolute top-6 left-1/2 -translate-x-1/2 w-2 h-2 bg-[#f5c542]/40 rounded-full" />
                <div className="absolute top-5 right-2 w-2 h-2 bg-[#f5c542]/40 rounded-full" />
              </div>
            </div>
            {/* Right paw */}
            <div className="animate-[legWiggleRight_0.5s_ease-in-out_infinite_0.25s] origin-bottom">
              <div className="w-12 h-10 bg-[#7a4f32] rounded-t-[2.5rem] relative shadow-md">
                <div className="absolute top-1.5 left-1/2 -translate-x-1/2 w-7 h-5 bg-[#e89b9b] rounded-full" />
                <div className="absolute top-5 left-2 w-2 h-2 bg-[#f5c542]/40 rounded-full" />
                <div className="absolute top-6 left-1/2 -translate-x-1/2 w-2 h-2 bg-[#f5c542]/40 rounded-full" />
                <div className="absolute top-5 right-2 w-2 h-2 bg-[#f5c542]/40 rounded-full" />
              </div>
            </div>
          </div>

          {/* Tiny body bump visible at the hole edge (upside down belly, wiggling) */}
          <div className="absolute bottom-10 left-1/2 -translate-x-1/2 z-[3] animate-[bodyWiggle_0.6s_ease-in-out_infinite]">
            <div className="w-20 h-7 bg-[#8B5E3C] rounded-t-full relative">
              <div className="absolute top-0 left-1/2 -translate-x-1/2 w-14 h-5 bg-[#a67b5b] rounded-t-full opacity-50" />
              {/* Bow tie peeking out upside-down */}
              <div className="absolute -top-1 left-1/2 -translate-x-1/2 flex items-center">
                <div className="w-2.5 h-3 bg-[#e89b9b] rounded-sm rotate-[-20deg]" />
                <div className="w-1.5 h-1.5 bg-[#d67a7a] rounded-full -mx-0.5" />
                <div className="w-2.5 h-3 bg-[#e89b9b] rounded-sm rotate-[20deg]" />
              </div>
              {/* Little belly button dot */}
              <div className="absolute top-3 left-1/2 -translate-x-1/2 w-1 h-1 bg-[#5c3a2a]/30 rounded-full" />
            </div>
          </div>
        </>
      )}

      {/* ===== DIRT MOUND FRONT (z-4) ===== */}
      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-60 h-14 bg-[#6b4530] rounded-t-[50%] z-[4] shadow-[0_-4px_20px_rgba(0,0,0,0.3)]" />
      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-52 h-10 bg-[#5c3a2a] rounded-t-[50%] z-[4]" />
      <div className="absolute bottom-10 left-[42%] w-1.5 h-1 rounded-full bg-[#7a5038] z-[4]" />
      <div className="absolute bottom-8 left-[55%] w-1 h-1 rounded-full bg-[#8b5e3c] z-[4]" />
      <div className="absolute bottom-9 right-[40%] w-1.5 h-1 rounded-full bg-[#6b4530] z-[4]" />

      {/* Dirt particles (scanning only) */}
      {scanning && (
        <>
          <span className="absolute bottom-14 left-[45%] w-2 h-2 rounded-full bg-[#8b5e3c] animate-[moleDirtUp_0.6s_ease-out_infinite] z-[5]" />
          <span className="absolute bottom-14 left-[48%] w-1.5 h-1.5 rounded-full bg-[#a07050] animate-[moleDirtUp_0.7s_ease-out_infinite_0.1s] z-[5]" />
          <span className="absolute bottom-14 left-[52%] w-2 h-2 rounded-full bg-[#8b5e3c] animate-[moleDirtUp_0.55s_ease-out_infinite_0.2s] z-[5]" />
          <span className="absolute bottom-14 left-[55%] w-1.5 h-1.5 rounded-full bg-[#6b4530] animate-[moleDirtUp_0.65s_ease-out_infinite_0.05s] z-[5]" />
          <span className="absolute bottom-12 left-[42%] w-1 h-1 rounded-full bg-[#7a5038] animate-[moleDirtUp_0.5s_ease-out_infinite_0.15s] z-[5]" />
          <span className="absolute bottom-12 left-[58%] w-1.5 h-1 rounded-full bg-[#8b5e3c] animate-[moleDirtUp_0.6s_ease-out_infinite_0.25s] z-[5]" />
          <span className="absolute bottom-16 left-[47%] w-1.5 h-1.5 rounded-full bg-[#5c3a2a] animate-[moleDirtUp_0.5s_ease-out_infinite_0.12s] z-[5]" />
          <span className="absolute bottom-16 left-[53%] w-1 h-1 rounded-full bg-[#6b4530] animate-[moleDirtUp_0.55s_ease-out_infinite_0.22s] z-[5]" />
        </>
      )}

      {/* ===== DOCUMENTS (z-6, above everything) ===== */}

      {/* Idle: floating doc stack with hint + cute sparkle */}
      {!scanning && (
        <>
          <div className="absolute bottom-28 right-[14%] flex flex-col items-center z-[6] animate-[docFloat_3.5s_ease-in-out_infinite]">
            <div className="w-14 h-16 bg-[#faf6f1] rounded-md border border-[#e5ddd3] shadow-sm flex flex-col gap-1.5 p-2 rotate-6">
              <div className="h-1.5 w-full bg-[#e5ddd3] rounded-sm" />
              <div className="h-1.5 w-3/4 bg-[#e5ddd3] rounded-sm" />
              <div className="h-1.5 w-full bg-[#e5ddd3] rounded-sm" />
              <div className="h-1.5 w-1/2 bg-[#e5ddd3] rounded-sm" />
            </div>
            <span className="text-[10px] text-white/40 mt-1.5 font-medium">Drop files here</span>
          </div>
          <div className="absolute bottom-36 left-[22%] z-[6] animate-[sparkle_2.5s_ease-in-out_infinite]">
            <i className="ri-heart-3-fill text-[#e89b9b]/60 text-sm"></i>
          </div>
          <div className="absolute bottom-20 left-[18%] z-[6] animate-[sparkle_3s_ease-in-out_infinite_0.8s]">
            <i className="ri-sparkling-fill text-[#f5c542]/40 text-xs"></i>
          </div>
        </>
      )}

      {/* Scanning: docs thrown out of the hole */}
      {scanning && (
        <>
          <div className="absolute bottom-20 left-[22%] flex flex-col items-center z-[6] animate-[docThrowLeft_1.4s_ease-out_infinite]">
            <div className="w-14 h-16 bg-[#faf6f1] rounded-md border-2 border-[#f5c542]/40 shadow-md flex flex-col gap-1.5 p-2">
              <div className="h-1.5 w-full bg-[#d4c4a8] rounded-sm" />
              <div className="h-1.5 w-2/3 bg-[#d4c4a8] rounded-sm" />
              <div className="h-1.5 w-full bg-[#d4c4a8] rounded-sm" />
              <div className="h-1.5 w-1/2 bg-[#d4c4a8] rounded-sm" />
            </div>
            <span className="text-[10px] text-[#f5c542] mt-1.5 font-semibold">Original</span>
          </div>

          <div className="absolute bottom-20 right-[22%] flex flex-col items-center z-[6] animate-[docThrowRight_1.4s_ease-out_infinite_0.7s]">
            <div className="w-14 h-16 bg-[#faf6f1] rounded-md border-2 border-[#c45c5c]/40 shadow-md flex flex-col gap-1.5 p-2">
              <div className="h-1.5 w-full bg-[#d4c4a8] rounded-sm" />
              <div className="h-1.5 w-2/3 bg-[#d4c4a8] rounded-sm" />
              <div className="h-1.5 w-full bg-[#d4c4a8] rounded-sm" />
              <div className="h-1.5 w-1/2 bg-[#d4c4a8] rounded-sm" />
            </div>
            <span className="text-[10px] text-[#c45c5c] mt-1.5 font-semibold">Duplicate</span>
          </div>

          <div className="absolute bottom-28 left-1/2 -translate-x-1/2 w-9 h-9 rounded-full bg-[#f5c542] flex items-center justify-center shadow-lg z-[6] animate-[pulse_1s_ease-in-out_infinite]">
            <i className="ri-arrow-left-right-line text-[#2c1810] text-sm" />
          </div>

          <div className="absolute bottom-24 left-[35%] z-[6] animate-[docThrowSmall_1.2s_ease-out_infinite_0.3s]">
            <div className="w-10 h-12 bg-[#faf6f1]/80 rounded border border-[#e5ddd3] flex flex-col gap-1 p-1.5 rotate-12">
              <div className="h-1 w-full bg-[#d4c4a8]/60 rounded-sm" />
              <div className="h-1 w-2/3 bg-[#d4c4a8]/60 rounded-sm" />
            </div>
          </div>
          <div className="absolute bottom-24 right-[35%] z-[6] animate-[docThrowSmall_1.3s_ease-out_infinite_0.9s]">
            <div className="w-10 h-12 bg-[#faf6f1]/80 rounded border border-[#e5ddd3] flex flex-col gap-1 p-1.5 -rotate-12">
              <div className="h-1 w-full bg-[#d4c4a8]/60 rounded-sm" />
              <div className="h-1 w-2/3 bg-[#d4c4a8]/60 rounded-sm" />
            </div>
          </div>

          <div className="absolute bottom-20 left-[28%] z-[6] animate-[sparkle_0.8s_ease-in-out_infinite]">
            <i className="ri-sparkling-fill text-[#f5c542] text-xs"></i>
          </div>
          <div className="absolute bottom-20 right-[28%] z-[6] animate-[sparkle_0.9s_ease-in-out_infinite_0.4s]">
            <i className="ri-sparkling-fill text-[#e89b9b] text-xs"></i>
          </div>

          <span className="absolute bottom-20 left-[30%] text-[9px] text-[#f5c542]/50 font-mono z-[6] animate-[hashFloat_2.5s_linear_infinite]">a7f3...</span>
          <span className="absolute bottom-20 right-[30%] text-[9px] text-[#c45c5c]/50 font-mono z-[6] animate-[hashFloat_2.5s_linear_infinite_0.8s]">b2e1...</span>
        </>
      )}

      {/* Drag glow overlay */}
      {dragActive && (
        <div className="absolute inset-0 bg-[#f5c542]/5 pointer-events-none z-[7]" />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Scan Complete Modal                                               */
/* ------------------------------------------------------------------ */
function ScanCompleteModal({
  stats,
  onClose,
  onGoToResults,
}: {
  stats: {
    totalFiles: number;
    duplicateGroups: number;
    duplicateFiles: number;
    wastedSize: string;
    scanTime: string;
  };
  onClose: () => void;
  onGoToResults: () => void;
}) {
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div
        ref={modalRef}
        className="bg-[#3d2418] rounded-2xl border border-white/10 w-full max-w-lg shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex flex-col items-center pt-8 pb-4 px-6">
          <div className="w-16 h-16 rounded-full bg-[#f5c542]/15 flex items-center justify-center mb-4">
            <i className="ri-checkbox-circle-line text-[#f5c542] text-3xl"></i>
          </div>
          <h3 className="text-white text-xl font-bold">Scan Complete</h3>
          <p className="text-white/40 text-sm mt-1 text-center">
            Your directories have been fully analyzed and compared.
          </p>
        </div>

        {/* Stats Grid */}
        <div className="px-6 pb-6">
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-[#2c1810] rounded-xl border border-white/10 p-4 text-center">
              <p className="text-white text-2xl font-bold">{stats.totalFiles.toLocaleString()}</p>
              <p className="text-white/40 text-xs mt-1">Files Scanned</p>
            </div>
            <div className="bg-[#2c1810] rounded-xl border border-white/10 p-4 text-center">
              <p className="text-white text-2xl font-bold">{stats.duplicateGroups}</p>
              <p className="text-white/40 text-xs mt-1">Duplicate Groups</p>
            </div>
            <div className="bg-[#2c1810] rounded-xl border border-white/10 p-4 text-center">
              <p className="text-white text-2xl font-bold">{stats.duplicateFiles}</p>
              <p className="text-white/40 text-xs mt-1">Duplicate Files</p>
            </div>
            <div className="bg-[#2c1810] rounded-xl border border-white/10 p-4 text-center">
              <p className="text-[#f5c542] text-2xl font-bold">{stats.wastedSize}</p>
              <p className="text-white/40 text-xs mt-1">Wasted Space</p>
            </div>
          </div>
          <div className="mt-3 bg-[#2c1810] rounded-xl border border-white/10 p-3 text-center">
            <p className="text-white/40 text-xs">
              Scan finished in <span className="text-white font-medium">{stats.scanTime}</span>
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3 px-6 pb-6">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-3 rounded-xl text-white/60 text-sm font-medium hover:text-white hover:bg-white/5 transition-colors duration-200 cursor-pointer whitespace-nowrap"
          >
            Stay Here
          </button>
          <button
            onClick={onGoToResults}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-[#f5c542] text-[#2c1810] text-sm font-semibold hover:bg-[#e0b038] transition-colors duration-200 cursor-pointer whitespace-nowrap"
          >
            <i className="ri-folders-line"></i>
            View Results
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ScanView({ onNavigateToResults }: ScanViewProps) {
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [directories, setDirectories] = useState(mockDirectories);
  const [dragActive, setDragActive] = useState(false);
  const [scanComplete, setScanComplete] = useState(false);
  const [scanStats, setScanStats] = useState({
    totalFiles: 0,
    duplicateGroups: 0,
    duplicateFiles: 0,
    wastedSize: '',
    scanTime: '',
  });
  const scanStartTime = useRef<number>(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addDirectory = (name: string) => {
    setDirectories((prev) => [
      ...prev,
      {
        id: Date.now(),
        name,
        files: Math.floor(Math.random() * 3000) + 500,
        progress: 0,
        scanned: false,
      },
    ]);
  };

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const items = e.dataTransfer.items;
    if (items && items.length > 0) {
      const entry = items[0].webkitGetAsEntry?.();
      if (entry && entry.isDirectory) {
        addDirectory(entry.name);
        return;
      }
    }
    addDirectory('Dropped Folder');
  }, []);

  const handleBrowse = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const firstPath = files[0].webkitRelativePath || '';
    const folderName = firstPath.split('/')[0] || 'Selected Folder';
    addDirectory(folderName);
    e.target.value = '';
  };

  const removeDirectory = (id: number) => {
    setDirectories((prev) => prev.filter((d) => d.id !== id));
  };

  const startScan = useCallback(() => {
    setScanning(true);
    setProgress(0);
    setScanComplete(false);
    setDirectories(mockDirectories.map((d) => ({ ...d, progress: 0, scanned: false })));
    scanStartTime.current = Date.now();

    let p = 0;
    const interval = setInterval(() => {
      p += Math.random() * 4 + 1;
      if (p >= 100) {
        p = 100;
        clearInterval(interval);
        const elapsed = ((Date.now() - scanStartTime.current) / 1000).toFixed(1);
        const totalFiles = directories.reduce((sum, d) => sum + d.files, 0);
        const dupGroups = duplicateGroups.length;
        const dupFiles = duplicateGroups.reduce((sum, g) => sum + g.count, 0);
        setScanStats({
          totalFiles,
          duplicateGroups: dupGroups,
          duplicateFiles: dupFiles,
          wastedSize: '1.26 GB',
          scanTime: `${elapsed}s`,
        });
        setScanComplete(true);
        setScanning(false);
        setDirectories((prev) =>
          prev.map((d) => ({ ...d, progress: 100, scanned: true }))
        );
      }
      setProgress(Math.min(p, 100));
      setDirectories((prev) =>
        prev.map((d, i) => {
          const dirProg = Math.min(Math.max((p - i * 25) * 1.5, 0), 100);
          return { ...d, progress: Math.round(dirProg), scanned: dirProg >= 100 };
        })
      );
    }, 120);
  }, [directories]);

  const handleGoToResults = () => {
    setScanComplete(false);
    onNavigateToResults?.();
  };

  return (
    <div className="min-h-full flex flex-col relative pb-12 md:pb-16">
      <style>{`
        @keyframes moleIdle {
          0%, 100% { transform: translateY(26px) scaleY(0.92); }
          25%      { transform: translateY(12px) scaleY(0.97); }
          50%      { transform: translateY(0px) scaleY(1.00); }
          75%      { transform: translateY(14px) scaleY(0.96); }
        }
        @keyframes moleBlink {
          0%, 45%, 55%, 100% { transform: scaleY(1); }
          50% { transform: scaleY(0.1); }
        }
        @keyframes moleDirtUp {
          0%   { transform: translate(0, 0) scale(1); opacity: 1; }
          100% { transform: translate(var(--dx, 10px), -50px) scale(0.2); opacity: 0; }
        }
        @keyframes bodyWiggle {
          0%, 100% { transform: translateX(-50%) rotate(-3deg) translateY(0); }
          25%      { transform: translateX(-50%) rotate(4deg) translateY(-2px); }
          50%      { transform: translateX(-50%) rotate(-2deg) translateY(-1px); }
          75%      { transform: translateX(-50%) rotate(3deg) translateY(-2px); }
        }
        @keyframes legWiggleLeft {
          0%, 100% { transform: rotate(-22deg) translateY(0) scaleY(1); }
          25%      { transform: rotate(10deg) translateY(-4px) scaleY(1.05); }
          50%      { transform: rotate(22deg) translateY(-2px) scaleY(1); }
          75%      { transform: rotate(-8deg) translateY(-5px) scaleY(1.03); }
        }
        @keyframes legWiggleRight {
          0%, 100% { transform: rotate(22deg) translateY(0) scaleY(1); }
          25%      { transform: rotate(-10deg) translateY(-4px) scaleY(1.05); }
          50%      { transform: rotate(-22deg) translateY(-2px) scaleY(1); }
          75%      { transform: rotate(8deg) translateY(-5px) scaleY(1.03); }
        }
        @keyframes docFloat {
          0%, 100% { transform: translateY(0) rotate(6deg); }
          50% { transform: translateY(-10px) rotate(8deg); }
        }
        @keyframes docThrowLeft {
          0%   { transform: translateY(0) translateX(0) scale(0.6) rotate(-10deg); opacity: 0; }
          15%  { transform: translateY(-40px) translateX(-20px) scale(1) rotate(-20deg); opacity: 1; }
          45%  { transform: translateY(-70px) translateX(-35px) scale(1) rotate(-25deg); opacity: 1; }
          75%  { transform: translateY(-55px) translateX(-45px) scale(0.95) rotate(-20deg); opacity: 0.6; }
          100% { transform: translateY(-30px) translateX(-55px) scale(0.85) rotate(-15deg); opacity: 0; }
        }
        @keyframes docThrowRight {
          0%   { transform: translateY(0) translateX(0) scale(0.6) rotate(10deg); opacity: 0; }
          15%  { transform: translateY(-40px) translateX(20px) scale(1) rotate(20deg); opacity: 1; }
          45%  { transform: translateY(-70px) translateX(35px) scale(1) rotate(25deg); opacity: 1; }
          75%  { transform: translateY(-55px) translateX(45px) scale(0.95) rotate(20deg); opacity: 0.6; }
          100% { transform: translateY(-30px) translateX(55px) scale(0.85) rotate(15deg); opacity: 0; }
        }
        @keyframes docThrowSmall {
          0%   { transform: translateY(0) scale(0.5); opacity: 0; }
          20%  { transform: translateY(-35px) scale(1); opacity: 0.8; }
          60%  { transform: translateY(-60px) scale(0.95); opacity: 0.5; }
          100% { transform: translateY(-20px) scale(0.8); opacity: 0; }
        }
        @keyframes hashFloat {
          0%   { transform: translateY(0); opacity: 0.6; }
          100% { transform: translateY(-30px); opacity: 0; }
        }
        @keyframes sparkle {
          0%, 100% { transform: scale(1) rotate(0deg); opacity: 0.5; }
          50%      { transform: scale(1.4) rotate(15deg); opacity: 1; }
        }
      `}</style>

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-white text-2xl font-bold tracking-tight">Scan</h2>
          <p className="text-white/40 text-sm mt-1">Select directories to scan for duplicate files</p>
        </div>
        <button
          onClick={startScan}
          disabled={scanning || directories.length === 0}
          className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 cursor-pointer whitespace-nowrap ${
            scanning || directories.length === 0
              ? 'bg-white/10 text-white/30 cursor-not-allowed'
              : 'bg-[#f5c542] text-[#2c1810] hover:bg-[#e0b038]'
          }`}
        >
          {scanning ? <i className="ri-loader-4-line animate-spin"></i> : <i className="ri-search-line"></i>}
          {scanning ? 'Scanning...' : 'Start Scan'}
        </button>
      </div>

      {/* Mole Drop Zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleBrowse}
        className={`relative mb-6 rounded-2xl border-2 border-dashed cursor-pointer min-h-[288px] overflow-hidden transition-colors duration-300 ${
          dragActive
            ? 'border-[#f5c542] bg-[#f5c542]/10'
            : 'border-white/15 bg-white/[0.03] hover:border-white/30 hover:bg-white/[0.05]'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          webkitdirectory=""
          directory=""
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />

        <MoleScene scanning={scanning} dragActive={dragActive} />

        {/* Browse hint overlay */}
        <div className="absolute bottom-3 left-0 right-0 text-center pointer-events-none">
          <p className="text-white/30 text-xs">
            {dragActive ? 'Release to add folder' : 'Drag a folder here or click to browse'}
          </p>
        </div>
      </div>

      {/* Directories List */}
      <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-5 mb-6">
        <p className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-4">Selected Directories</p>
        {directories.length === 0 ? (
          <div className="text-center py-10 text-white/30 text-sm">No directories selected. Drag a folder or browse to begin.</div>
        ) : (
          <div className="space-y-3 pb-2">
            {directories.map((dir) => (
              <div key={dir.id} className="flex items-center gap-4 p-4 rounded-xl bg-white/5 border border-white/5">
                <div className="w-10 h-10 rounded-lg bg-[#f5c542]/10 flex items-center justify-center shrink-0">
                  <i className="ri-folder-line text-[#f5c542] text-base"></i>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-white text-sm font-medium font-mono truncate">{dir.name}</span>
                    <span className="text-white/40 text-xs font-mono">{dir.files.toLocaleString()} files</span>
                  </div>
                  <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full bg-[#f5c542] transition-all duration-300"
                      style={{ width: `${dir.progress}%` }}
                    />
                  </div>
                </div>
                {dir.scanned ? (
                  <div className="w-8 h-8 rounded-full bg-[#f5c542]/20 flex items-center justify-center shrink-0">
                    <i className="ri-check-line text-[#f5c542] text-sm"></i>
                  </div>
                ) : (
                  <button
                    onClick={() => removeDirectory(dir.id)}
                    className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/30 hover:text-white/60 transition-colors duration-200 cursor-pointer shrink-0"
                  >
                    <i className="ri-close-line text-sm"></i>
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Overall Progress */}
      {scanning && (
        <div className="bg-[#3d2418] rounded-2xl border border-white/10 p-5 mb-6">
          <div className="flex items-center justify-between mb-3">
            <span className="text-white text-sm font-medium">Overall Progress</span>
            <span className="text-[#f5c542] text-sm font-semibold">{Math.round(progress)}%</span>
          </div>
          <div className="h-3 bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full bg-[#f5c542] transition-all duration-150"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-white/30 text-xs mt-3 font-mono">Scanning recursively with SHA-256 hash comparison...</p>
        </div>
      )}

      {/* File Type Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        {fileTypeStats.map((ft) => (
          <div
            key={ft.label}
            className="bg-[#3d2418] rounded-2xl p-5 border border-white/10 hover:border-[#f5c542]/30 transition-colors duration-200"
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="w-9 h-9 rounded-lg bg-[#f5c542]/10 flex items-center justify-center">
                <i className={`${ft.icon} text-[#f5c542] text-sm`}></i>
              </div>
              <span className="text-white text-sm font-medium">{ft.label}</span>
            </div>
            <p className="text-white text-xl font-bold">{ft.count}</p>
            <p className="text-white/30 text-xs mt-1">{ft.formats}</p>
          </div>
        ))}
      </div>

      {/* Scan Complete Modal */}
      {scanComplete && (
        <ScanCompleteModal
          stats={scanStats}
          onClose={() => setScanComplete(false)}
          onGoToResults={handleGoToResults}
        />
      )}
    </div>
  );
}