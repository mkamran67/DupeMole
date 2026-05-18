// Shared version helpers used by build.mjs and release.mjs.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const VERSION_FILES = [
  { path: join(ROOT, "package.json"), kind: "json" },
  { path: join(ROOT, "desktop", "package.json"), kind: "json" },
  { path: join(ROOT, "desktop", "package-lock.json"), kind: "package-lock" },
  { path: join(ROOT, "src-tauri", "tauri.conf.json"), kind: "json" },
  { path: join(ROOT, "src-tauri", "Cargo.toml"), kind: "cargo" },
  { path: join(ROOT, "src-tauri", "Cargo.lock"), kind: "cargo-lock" },
  { path: join(ROOT, "README.md"), kind: "readme" },
];

export function readVersion() {
  const pkg = JSON.parse(readFileSync(VERSION_FILES[0].path, "utf8"));
  if (typeof pkg.version !== "string") {
    throw new Error("root package.json missing version");
  }
  return pkg.version;
}

export function bumpVersion(v, kind) {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!m) throw new Error(`cannot parse semver: ${v}`);
  let [, maj, min, pat, suffix] = m;
  let [a, b, c] = [Number(maj), Number(min), Number(pat)];
  if (kind === "major") { a += 1; b = 0; c = 0; }
  else if (kind === "minor") { b += 1; c = 0; }
  else if (kind === "patch") { c += 1; }
  return `${a}.${b}.${c}${suffix}`;
}

export function writeVersion(file, next) {
  const text = readFileSync(file.path, "utf8");
  if (file.kind === "json") {
    const obj = JSON.parse(text);
    obj.version = next;
    writeFileSync(file.path, JSON.stringify(obj, null, 2) + "\n");
    return;
  }
  if (file.kind === "package-lock") {
    const obj = JSON.parse(text);
    obj.version = next;
    if (obj.packages?.[""]) obj.packages[""].version = next;
    writeFileSync(file.path, JSON.stringify(obj, null, 2) + "\n");
    return;
  }
  // Cargo.toml: only rewrite the first `version = "..."` line under [package].
  if (file.kind === "cargo") {
    let inPackage = false;
    let replaced = false;
    const lines = text.split("\n").map((line) => {
      if (/^\s*\[/.test(line)) inPackage = /^\s*\[package\]\s*$/.test(line);
      if (inPackage && !replaced && /^\s*version\s*=\s*".*"\s*$/.test(line)) {
        replaced = true;
        return line.replace(/".*"/, `"${next}"`);
      }
      return line;
    });
    if (!replaced) throw new Error(`could not find [package] version in ${file.path}`);
    writeFileSync(file.path, lines.join("\n"));
    return;
  }
  if (file.kind === "cargo-lock") {
    let inDupemole = false;
    let replaced = false;
    const lines = text.split("\n").map((line) => {
      if (/^\[\[package\]\]\s*$/.test(line)) inDupemole = false;
      if (/^name\s*=\s*"dupemole"\s*$/.test(line)) inDupemole = true;
      if (inDupemole && !replaced && /^version\s*=\s*".*"\s*$/.test(line)) {
        replaced = true;
        return line.replace(/".*"/, `"${next}"`);
      }
      return line;
    });
    if (!replaced) throw new Error(`could not find dupemole package version in ${file.path}`);
    writeFileSync(file.path, lines.join("\n"));
    return;
  }
  if (file.kind === "readme") {
    const versionPattern = "\\d+\\.\\d+\\.\\d+(?:[-+][A-Za-z0-9.-]+)?";
    const updated = text
      .replace(new RegExp(`version-${versionPattern}-blue`, "g"), `version-${next}-blue`)
      .replace(new RegExp(`DupeMole_${versionPattern}_amd64`, "g"), `DupeMole_${next}_amd64`);
    if (updated === text) throw new Error(`could not find README version references in ${file.path}`);
    writeFileSync(file.path, updated);
    return;
  }
  throw new Error(`unknown version file kind: ${file.kind}`);
}

export { ROOT };
