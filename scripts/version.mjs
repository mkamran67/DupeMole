// Shared version helpers used by build.mjs and release.mjs.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const VERSION_FILES = [
  { path: join(ROOT, "package.json"), kind: "json" },
  { path: join(ROOT, "desktop", "package.json"), kind: "json" },
  { path: join(ROOT, "src-tauri", "tauri.conf.json"), kind: "json" },
  { path: join(ROOT, "src-tauri", "Cargo.toml"), kind: "cargo" },
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
  // Cargo.toml: only rewrite the first `version = "..."` line under [package].
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
}

export { ROOT };
