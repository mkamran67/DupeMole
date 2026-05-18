import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bumpVersion, writeVersion } from "./version.mjs";

function withTempFile(name, text, fn) {
  const dir = mkdtempSync(join(tmpdir(), "dupemole-version-"));
  const path = join(dir, name);
  writeFileSync(path, text);
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("bumps semantic versions", () => {
  assert.equal(bumpVersion("1.2.3", "patch"), "1.2.4");
  assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0");
  assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
});

test("updates json manifest versions", () => {
  withTempFile("package.json", '{\n  "name": "dupemole",\n  "version": "1.2.3"\n}\n', (path) => {
    writeVersion({ path, kind: "json" }, "1.2.4");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).version, "1.2.4");
  });
});

test("updates package-lock project versions", () => {
  const text = JSON.stringify({
    name: "dupemole-desktop",
    version: "0.0.0",
    packages: {
      "": { name: "dupemole-desktop", version: "0.0.0" },
      "node_modules/example": { version: "9.9.9" },
    },
  }, null, 2);
  withTempFile("package-lock.json", `${text}\n`, (path) => {
    writeVersion({ path, kind: "package-lock" }, "1.2.4");
    const lock = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(lock.version, "1.2.4");
    assert.equal(lock.packages[""].version, "1.2.4");
    assert.equal(lock.packages["node_modules/example"].version, "9.9.9");
  });
});

test("updates Cargo package version only", () => {
  const text = [
    "[package]",
    'name = "dupemole"',
    'version = "1.2.3"',
    "",
    "[dependencies]",
    'serde = { version = "1" }',
    "",
  ].join("\n");
  withTempFile("Cargo.toml", text, (path) => {
    writeVersion({ path, kind: "cargo" }, "1.2.4");
    assert.match(readFileSync(path, "utf8"), /version = "1\.2\.4"/);
    assert.match(readFileSync(path, "utf8"), /serde = \{ version = "1" \}/);
  });
});

test("updates dupemole Cargo.lock package only", () => {
  const text = [
    "[[package]]",
    'name = "dependency"',
    'version = "9.9.9"',
    "",
    "[[package]]",
    'name = "dupemole"',
    'version = "1.2.3"',
    "",
  ].join("\n");
  withTempFile("Cargo.lock", text, (path) => {
    writeVersion({ path, kind: "cargo-lock" }, "1.2.4");
    const updated = readFileSync(path, "utf8");
    assert.match(updated, /name = "dependency"\nversion = "9\.9\.9"/);
    assert.match(updated, /name = "dupemole"\nversion = "1\.2\.4"/);
  });
});

test("updates README badge and Linux artifact examples", () => {
  const text = [
    "[![Version](https://img.shields.io/badge/version-1.2.3-blue)](releases/)",
    "`DupeMole_1.2.3_amd64.AppImage`",
    "chmod +x DupeMole_1.2.3_amd64.AppImage",
    "sudo dpkg -i DupeMole_1.2.3_amd64.deb",
    "",
  ].join("\n");
  withTempFile("README.md", text, (path) => {
    writeVersion({ path, kind: "readme" }, "1.2.4");
    const updated = readFileSync(path, "utf8");
    assert.match(updated, /version-1\.2\.4-blue/);
    assert.doesNotMatch(updated, /DupeMole_1\.2\.3_amd64/);
    assert.match(updated, /DupeMole_1\.2\.4_amd64\.deb/);
  });
});
