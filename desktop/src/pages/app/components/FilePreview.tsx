import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { UiFile } from '../../../results/adapter';
import { useThumbnail } from '../../../results/useThumbnail';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

interface FilePreviewProps {
  file: UiFile;
  onOpen: (path: string) => void;
}

export default function FilePreview({ file, onOpen }: FilePreviewProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const [pdfFailed, setPdfFailed] = useState(false);
  const [pdfReady, setPdfReady] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { url: thumbUrl, failed: thumbFailed, skipped: thumbSkipped } = useThumbnail(file);

  useEffect(() => {
    if (file.bucket !== 'PDFs') return;
    let cancelled = false;
    let pdfDoc: { destroy: () => void } | null = null;

    (async () => {
      try {
        const loadingTask = pdfjsLib.getDocument({ url: file.assetUrl });
        const pdf = await loadingTask.promise;
        pdfDoc = pdf;
        if (cancelled) {
          pdf.destroy();
          return;
        }
        const page = await pdf.getPage(1);
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;

        const containerWidth = canvas.parentElement?.clientWidth ?? 240;
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = Math.min(2, Math.max(0.5, containerWidth / baseViewport.width));
        const viewport = page.getViewport({ scale });
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          setPdfFailed(true);
          return;
        }
        ctx.scale(dpr, dpr);
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        if (!cancelled) setPdfReady(true);
      } catch (err) {
        console.error('PDF preview failed:', err);
        if (!cancelled) setPdfFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      if (pdfDoc) pdfDoc.destroy();
    };
  }, [file.assetUrl, file.bucket]);

  const fallback = (label: string) => (
    <div className="w-full h-32 rounded-lg bg-black/30 border border-white/10 flex flex-col items-center justify-center gap-2">
      <i className={`${file.icon} text-white/30 text-2xl`}></i>
      <span className="text-white/40 text-[10px] uppercase tracking-wider">{label}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onOpen(file.path);
        }}
        className="mt-1 inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 rounded-md border border-white/20 text-white/70 hover:text-white hover:border-white/40 hover:bg-white/5 transition-colors duration-200 cursor-pointer"
      >
        <i className="ri-external-link-line"></i>
        Open
      </button>
    </div>
  );

  if (file.bucket === 'Images') {
    // Decision: skipped (non-thumbnailable format) → load original directly;
    // otherwise prefer the cached thumbnail. On any failure (thumb gen error,
    // <img> load error) fall through to the file-type icon — NEVER show the
    // "Preview unavailable" panel for images, and never fall back to the
    // original (it'd reintroduce the slow path or fail for formats the
    // WebView can't decode).
    const src = imgFailed || thumbFailed
      ? null
      : thumbSkipped
        ? file.assetUrl
        : thumbUrl;
    return (
      <div className="w-full h-32 rounded-lg bg-black/30 border border-white/10 overflow-hidden flex items-center justify-center">
        {src ? (
          <img
            src={src}
            alt={file.name}
            decoding="async"
            className="max-w-full max-h-full object-contain"
            onError={() => {
              console.error('[FilePreview] <img> failed to load', { src, path: file.path });
              setImgFailed(true);
            }}
          />
        ) : (
          <i className={`${file.icon} text-white/25 text-xl`}></i>
        )}
      </div>
    );
  }

  if (file.bucket === 'Videos' && !videoFailed) {
    return (
      <div className="relative w-full h-32 rounded-lg bg-black/30 border border-white/10 overflow-hidden flex items-center justify-center">
        <video
          src={`${file.assetUrl}#t=0.5`}
          preload="metadata"
          muted
          playsInline
          className="max-w-full max-h-full object-contain"
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (isFinite(v.duration)) setDuration(v.duration);
          }}
          onError={() => setVideoFailed(true)}
        />
        {duration !== null && (
          <span className="absolute bottom-1.5 right-1.5 text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-black/70 text-white">
            {formatDuration(duration)}
          </span>
        )}
        <span className="absolute top-1.5 left-1.5 w-6 h-6 rounded-full bg-black/60 flex items-center justify-center">
          <i className="ri-play-fill text-white text-sm"></i>
        </span>
      </div>
    );
  }

  if (file.bucket === 'PDFs' && !pdfFailed) {
    return (
      <div className="relative w-full h-32 rounded-lg bg-white/5 border border-white/10 overflow-hidden flex items-center justify-center">
        {!pdfReady && (
          <div className="absolute inset-0 flex items-center justify-center">
            <i className="ri-loader-4-line animate-spin text-white/30 text-xl"></i>
          </div>
        )}
        <canvas
          ref={canvasRef}
          className="max-w-full max-h-full object-contain bg-white"
        />
      </div>
    );
  }

  if (imgFailed) return fallback('Preview unavailable');
  if (videoFailed) return fallback('Video');
  if (pdfFailed) return fallback('PDF');
  return fallback(file.bucket);
}
