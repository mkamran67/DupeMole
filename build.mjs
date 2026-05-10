#!/usr/bin/env node
// Build script for DupeMole.
//
//   node build.mjs              build for the host OS
//   node build.mjs --minor      bump minor version, then build
//   node build.mjs --major      bump major version, then build
//
// Also runnable with `bun build.mjs`.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { ROOT, VERSION_FILES, readVersion, bumpVersion, writeVersion } from "./scripts/version.mjs";

function parseArgs(argv) {
  const flags = new Set(argv.slice(2));
  const major = flags.delete("--major");
  const minor = flags.delete("--minor");
  const patch = flags.delete("--patch");
  if (flags.size > 0) {
    fail(`unknown args: ${[...flags].join(" ")}`);
  }
  if ([major, minor, patch].filter(Boolean).length > 1) {
    fail("pick at most one of --major / --minor / --patch");
  }
  return { bump: major ? "major" : minor ? "minor" : patch ? "patch" : null };
}

function fail(msg) {
  console.error(`build.mjs: ${msg}`);
  process.exit(1);
}

function run(cmd, args) {
  const isWin = process.platform === "win32";
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", shell: isWin });
  if (r.status !== 0) fail(`${cmd} exited with ${r.status}`);
}

function bundleHints() {
  switch (process.platform) {
    case "darwin": return "src-tauri/target/release/bundle/{macos,dmg}/";
    case "linux":  return "src-tauri/target/release/bundle/{appimage,deb,rpm}/";
    case "win32":  return "src-tauri/target/release/bundle/{msi,nsis}/";
    default:       return "src-tauri/target/release/bundle/";
  }
}

const { bump } = parseArgs(process.argv);
let current;
try { current = readVersion(); } catch (e) { fail(e.message); }
const next = bump ? bumpVersion(current, bump) : current;

if (bump) {
  console.log(`bumping ${bump}: ${current} -> ${next}`);
  for (const f of VERSION_FILES) {
    try { writeVersion(f, next); } catch (e) { fail(e.message); }
  }
}

console.log(`building DupeMole ${next} for ${process.platform}/${process.arch}`);
run("cargo", ["tauri", "build"]);
console.log(`\ndone. bundles in ${resolve(ROOT, bundleHints())}`);
