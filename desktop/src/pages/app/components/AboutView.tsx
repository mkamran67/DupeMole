export default function AboutView() {
  return (
    <div className="max-w-2xl mx-auto py-10">
      <div className="flex items-center gap-4 mb-8">
        <img
          src="/logo.png"
          alt="DupeMole"
          className="w-16 h-16 rounded-2xl object-contain bg-[#2c1810] p-2"
        />
        <div>
          <h1 className="text-3xl font-bold text-white tracking-tight">DupeMole</h1>
          <p className="text-white/50 text-sm">Find duplicate files. Fast.</p>
        </div>
      </div>

      <div className="space-y-6 text-white/70 text-sm leading-relaxed">
        <section>
          <h2 className="text-white font-semibold text-base mb-2">About</h2>
          <p>
            DupeMole is a sleek cross-platform desktop app for macOS and Linux that
            finds and safely removes duplicate files with intelligent scanning and
            beautiful previews.
          </p>
        </section>

        <section>
          <h2 className="text-white font-semibold text-base mb-2">Version</h2>
          <p className="font-mono text-white/60">0.0.0</p>
        </section>

        <section>
          <h2 className="text-white font-semibold text-base mb-2">Built with</h2>
          <ul className="space-y-1 text-white/60">
            <li>Tauri 2 — native shell</li>
            <li>React 19 + Vite — UI</li>
            <li>Tailwind CSS — styling</li>
          </ul>
        </section>

        <section className="pt-4 border-t border-white/10 text-white/40 text-xs">
          © DupeMole. Released under the MIT License.
        </section>
      </div>
    </div>
  );
}
