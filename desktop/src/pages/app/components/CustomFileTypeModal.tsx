import { useEffect, useRef, useState } from 'react';

interface CustomFileTypeModalProps {
  onClose: () => void;
  onCreate: (label: string, formats: string[]) => void | Promise<void>;
}

export default function CustomFileTypeModal({ onClose, onCreate }: CustomFileTypeModalProps) {
  const [label, setLabel] = useState('');
  const [extInput, setExtInput] = useState('');
  const [formats, setFormats] = useState<string[]>([]);
  const labelInputRef = useRef<HTMLInputElement>(null);
  const extInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    labelInputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const addExtension = () => {
    const tokens = extInput
      .split(',')
      .map((s) => s.trim().replace(/^\./, '').toLowerCase())
      .filter(Boolean);
    if (tokens.length === 0) return;
    setFormats((prev) => Array.from(new Set([...prev, ...tokens])));
    setExtInput('');
    setTimeout(() => extInputRef.current?.focus(), 0);
  };

  const removeExtension = (ext: string) => {
    setFormats((prev) => prev.filter((f) => f !== ext));
  };

  const canSubmit = label.trim().length > 0 && formats.length > 0;
  const submit = async () => {
    if (!canSubmit) return;
    await onCreate(label.trim(), formats);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Create a custom file type"
    >
      <div className="w-full max-w-md rounded-2xl bg-[#2a1810] border border-white/15 shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-white/10">
          <div>
            <h3 className="text-white text-lg font-semibold">New File Type</h3>
            <p className="text-white/40 text-xs mt-0.5">
              Give it a name and one or more extensions.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-white/30 hover:text-white/60 hover:bg-white/5 transition-colors duration-200 cursor-pointer"
          >
            <i className="ri-close-line text-lg"></i>
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label htmlFor="custom-type-name" className="block text-white/40 text-xs font-medium mb-1.5">
              Name
            </label>
            <input
              id="custom-type-name"
              ref={labelInputRef}
              type="text"
              placeholder="e.g. Logs, Designs, Resumes"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full text-sm px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-white placeholder-white/30 focus:outline-none focus:border-[#f5c542]/40 transition-colors duration-200"
            />
          </div>

          <div>
            <label htmlFor="custom-type-ext" className="block text-white/40 text-xs font-medium mb-1.5">
              Extensions
            </label>
            <div className="flex gap-2">
              <input
                id="custom-type-ext"
                ref={extInputRef}
                type="text"
                placeholder=".log, .bak, .old"
                value={extInput}
                onChange={(e) => setExtInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addExtension();
                  }
                }}
                className="flex-1 text-sm px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-white placeholder-white/30 focus:outline-none focus:border-[#f5c542]/40 transition-colors duration-200"
              />
              <button
                onClick={addExtension}
                disabled={!extInput.trim()}
                className="px-3 py-2 rounded-lg bg-[#f5c542] text-[#2c1810] text-sm font-semibold hover:bg-[#e0b038] transition-colors duration-200 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Add
              </button>
            </div>
            {formats.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-3">
                {formats.map((f) => (
                  <span
                    key={f}
                    className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border border-[#f5c542]/30 bg-[#f5c542]/10 text-[#f5c542]"
                  >
                    .{f}
                    <button
                      onClick={() => removeExtension(f)}
                      aria-label={`Remove .${f}`}
                      className="w-4 h-4 rounded-full flex items-center justify-center text-[#f5c542]/60 hover:text-[#c45c5c] transition-colors duration-200 cursor-pointer"
                    >
                      <i className="ri-close-line text-[10px]"></i>
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 p-5 border-t border-white/10">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-white/60 text-sm font-medium hover:text-white hover:bg-white/5 transition-colors duration-200 cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="px-5 py-2 rounded-lg bg-[#f5c542] text-[#2c1810] text-sm font-semibold hover:bg-[#e0b038] transition-colors duration-200 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
