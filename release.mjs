#!/usr/bin/env node
// Production release script for DupeMole.
//
//   node release.mjs                       build a release for the host OS
//   node release.mjs --patch               bump patch version, then release
//   node release.mjs --skip-notarize       (macOS) sign but do not notarize
//   node release.mjs --targets=appimage    override default bundle targets
//
// macOS: signs with Developer ID and notarizes via Apple's notary service,
// emitting a .dmg. Reads APPLE_* credentials from .env.release at the repo
// root (gitignored). See release.env.example.
//
// Linux: emits AppImage and .deb. No credentials required.
//
// Also runnable with `bun release.mjs`.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { ROOT, VERSION_FILES, readVersion, bumpVersion, writeVersion } from "./scripts/version.mjs";

function fail(msg) {
  console.error(`release.mjs: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  let bump = null;
  let skipNotarize = false;
  let targets = null;
  for (const arg of argv.slice(2)) {
    if (arg === "--major" || arg === "--minor" || arg === "--patch") {
      if (bump) fail("pick at most one of --major / --minor / --patch");
      bump = arg.slice(2);
    } else if (arg === "--skip-notarize") {
      skipNotarize = true;
    } else if (arg.startsWith("--targets=")) {
      targets = arg.slice("--targets=".length);
      if (!targets) fail("--targets requires a value");
    } else {
      fail(`unknown arg: ${arg}`);
    }
  }
  return { bump, skipNotarize, targets };
}

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let rest = line.slice(eq + 1).trimStart();
    let value;
    if (rest.startsWith('"') || rest.startsWith("'")) {
      // Quoted: value runs until the matching closing quote; anything after
      // (typically a # comment) is ignored.
      const quote = rest[0];
      const end = rest.indexOf(quote, 1);
      if (end === -1) fail(`unterminated quoted value for ${key} in .env.release`);
      value = rest.slice(1, end);
    } else {
      // Unquoted: a # preceded by whitespace (or at the start) begins a comment.
      const m = rest.match(/(?:^|\s)#/);
      value = (m ? rest.slice(0, m.index) : rest).trimEnd();
    }
    process.env[key] = value;
  }
}

function requireEnv(keys) {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    fail(
      `missing required env vars: ${missing.join(", ")}\n` +
      `  populate .env.release at the repo root (see release.env.example)`,
    );
  }
}

function defaultTargets(platform, skipNotarize) {
  switch (platform) {
    case "darwin": return skipNotarize ? "app,dmg" : "app,dmg";
    case "linux":  return "appimage,deb";
    default:       return null;
  }
}

function run(cmd, args) {
  const isWin = process.platform === "win32";
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", shell: isWin });
  if (r.status !== 0) fail(`${cmd} exited with ${r.status}`);
}

const { bump, skipNotarize, targets: targetsArg } = parseArgs(process.argv);

loadEnvFile(join(ROOT, ".env.release"));

const platform = process.platform;
if (platform !== "darwin" && platform !== "linux") {
  fail(`production builds for ${platform} are not configured yet`);
}

if (platform === "darwin") {
  if (skipNotarize) {
    requireEnv(["APPLE_SIGNING_IDENTITY"]);
    // Tauri's bundler skips notarization automatically when APPLE_ID is unset.
    delete process.env.APPLE_ID;
    delete process.env.APPLE_PASSWORD;
    delete process.env.APPLE_TEAM_ID;
    console.log("--skip-notarize: signing only, notarization step will be skipped");
  } else {
    requireEnv(["APPLE_SIGNING_IDENTITY", "APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"]);
  }
}

const targets = targetsArg ?? defaultTargets(platform, skipNotarize);

let current;
try { current = readVersion(); } catch (e) { fail(e.message); }
const next = bump ? bumpVersion(current, bump) : current;

if (bump) {
  console.log(`bumping ${bump}: ${current} -> ${next}`);
  for (const f of VERSION_FILES) {
    try { writeVersion(f, next); } catch (e) { fail(e.message); }
  }
}

console.log(
  `releasing DupeMole ${next} for ${platform}/${process.arch} ` +
  `(targets: ${targets}${platform === "darwin" && !skipNotarize ? ", notarized" : ""})`,
);

run("cargo", ["tauri", "build", "--bundles", targets]);

const bundleDir = resolve(ROOT, "src-tauri/target/release/bundle");
const releasesDir = join(ROOT, "releases");
mkdirSync(releasesDir, { recursive: true });

const artifactSpec = platform === "darwin"
  ? [{ subdir: "dmg", ext: ".dmg" }]
  : [
      { subdir: "appimage", ext: ".AppImage" },
      { subdir: "deb", ext: ".deb" },
    ];

const moved = [];
for (const { subdir, ext } of artifactSpec) {
  const dir = join(bundleDir, subdir);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    if (!name.toLowerCase().endsWith(ext.toLowerCase())) continue;
    const src = join(dir, name);
    const dest = join(releasesDir, basename(name));
    renameSync(src, dest);
    moved.push(dest);
  }
}

console.log(`\ndone. ${moved.length} artifact${moved.length === 1 ? "" : "s"} in ${releasesDir}/`);
for (const p of moved) console.log(`  ${p}`);
