<div align="center">
  <img src="logo.png" alt="DupeMole logo" width="180" />

  # DupeMole

  **Find duplicate files fast. Organize the rest by date.**

  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
  [![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app/)
  [![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
  [![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
  [![Rust](https://img.shields.io/badge/Rust-stable-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)
  [![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey)](#installation)
  [![Version](https://img.shields.io/badge/version-0.3.0-blue)](releases/)
</div>

---

DupeMole is a cross-platform desktop app for locating duplicate files across large directories and tidying what remains. The scanner uses a streaming BLAKE3 hash with a short-circuit on a 64 MB partial hash, so it stays fast even on terabyte-scale photo libraries. Pair it with the Organize page to sort survivors into a clean folder tree by capture date — with full control over collisions, filters, and categorization.

## Features

- **Fast duplicate detection** — parallel scan with BLAKE3 hashing, partial-hash short-circuit for huge files, configurable thread count.
- **Organize by date** — sort copies or moves into year / month / day buckets, with separate folders for photos, videos, RAW formats, documents, and unknown extensions.
- **Collision control** — overwrite, skip, or keep-both on a per-file basis or apply to all; cancellable mid-run with partial output preserved.
- **Quick analysis page** — drop in a single file to inspect its hash, metadata, and capture date without running a full scan.
- **Custom filters** — page-specific filters for Scan and Organize, RAW format support, MacOS metadata noise stripped automatically.
- **Safe deletes** — duplicates go to the system trash, never `rm`.
- **Local-first** — no telemetry, no network calls, no cloud dependency.

## Installation

Pre-built Linux binaries are published in [`releases/`](releases/):

| Format | File |
|---|---|
| AppImage | `DupeMole_0.3.0_amd64.AppImage` |
| Debian / Ubuntu | `DupeMole_0.3.0_amd64.deb` |

**AppImage:**
```bash
chmod +x DupeMole_0.3.0_amd64.AppImage
./DupeMole_0.3.0_amd64.AppImage
```

**Debian / Ubuntu:**
```bash
sudo dpkg -i DupeMole_0.3.0_amd64.deb
```

macOS and Windows builds are not currently published as artifacts — see [Building from source](#building-from-source) below.

## Development

### Prerequisites

- [Rust](https://rustup.rs/) (stable toolchain)
- [Node.js](https://nodejs.org/) 20+
- Platform-specific Tauri prerequisites — follow the [Tauri setup guide](https://tauri.app/start/prerequisites/).

### Clone and install

```bash
git clone https://github.com/mkamran67/DupeMole.git
cd DupeMole
npm --prefix desktop install
```

### Run the dev shell

From the repo root:

```bash
npm run dev
```

This launches the Tauri shell, the Vite dev server on `localhost:1420`, and hot-reloads both the React frontend and Rust backend.

### Tests

The project follows test-driven development — see [`CLAUDE.md`](CLAUDE.md) for the working conventions.

```bash
cd src-tauri && cargo test       # Rust backend
cd desktop  && npm test          # Vitest frontend
cd desktop  && npm run type-check  # TypeScript check
cd desktop  && npm run lint        # ESLint
```

## Building from source

### Build a release bundle for your platform

```bash
npm run build
```

Tauri produces native installers for the host OS under `src-tauri/target/release/bundle/`:

- **Linux** — `.AppImage`, `.deb`, `.rpm`
- **macOS** — `.app`, `.dmg`
- **Windows** — `.msi`, `.exe`

### Versioned release helper

```bash
npm run release
```

The `release.mjs` script builds and stages versioned artifacts into `releases/`.

## Project layout

```
DupeMole/
├── desktop/        # React 19 + TypeScript frontend (Vite, Vitest, Tailwind)
├── src-tauri/      # Rust backend — Tauri commands, scanner, organizer, hashing
├── releases/       # Published binary artifacts
├── scripts/        # Build helpers
├── build.mjs       # Cross-platform build entry
└── release.mjs     # Versioned release packaging
```

## Tech stack

- **Frontend** — React 19, TypeScript, Vite, Tailwind CSS, react-router, react-i18next, react-virtuoso
- **Backend** — Rust, Tauri 2, Rayon (parallelism), BLAKE3 (hashing), walkdir, kamadak-exif, `trash`
- **Tooling** — Vitest, Cargo test, ESLint

## Contributing

Issues and pull requests welcome. Please write a failing test first when fixing a bug or adding a feature — the repo's TDD conventions are documented in [`CLAUDE.md`](CLAUDE.md).

## License

[MIT](LICENSE) © Muhammad Kamran
