#!/usr/bin/env node
// patches/_loader.mjs — version-aware dispatcher for the mcode-hub patcher.
//
// Why a loader: each mcode release may have a different status-bar widget
// structure. We keep a per-version patches/<version>/ directory so that:
//   1. when mcode changes its widget, we can add patches/<new>/ without
//      touching the old directory (old users on the old mcode still get a
//      working install);
//   2. when troubleshooting, the exact patcher code that ran for a given
//      mcode version is recoverable from git history and the directory name.
//
// Resolution rules:
//   1. If patches/<requested>/ exists, use it.
//   2. Else pick the highest patches/<v>/ such that v <= requested
//      (lexicographic over X.Y.Z, which matches mcode's version scheme).
//   3. Else fail loudly with the list of supported versions.
//
// The loader forwards the entire argv to the chosen patcher, so all
// existing flags (--src, --fork-base, --sidecar, --current, --offline)
// keep working unchanged. mcode-hub-install just calls this file instead of
// mcode-patch-quota.mjs directly.

import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// fileURLToPath (not URL.pathname) so a project path containing spaces or
// other percent-encoded characters resolves to the real directory.
const PATCHES_DIR = dirname(fileURLToPath(import.meta.url));

const argValue = (flag) => {
  for (const a of process.argv) {
    if (a === flag) return true;
    if (a.startsWith(flag + "=")) return a.slice(flag.length + 1);
  }
  return null;
};

const requested = argValue("--current");
if (!requested) {
  console.error("loader: --current=<version> is required (mcode-hub-install should pass it)");
  process.exit(2);
}

const listVersions = () =>
  readdirSync(PATCHES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d+\.\d+\.\d+$/.test(d.name))
    .map((d) => d.name)
    .sort()
    .reverse();  // newest first

const cmpVersion = (a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
};

const available = listVersions();
if (available.length === 0) {
  console.error("loader: no versioned patch directories under patches/");
  console.error("  expected patches/<x.y.z>/mcode-patch-quota.mjs");
  process.exit(2);
}

let chosen = null;
if (available.includes(requested)) {
  chosen = requested;
} else {
  // Highest version <= requested
  const lower = available
    .filter((v) => cmpVersion(v, requested) <= 0)
    .sort((a, b) => cmpVersion(b, a));
  if (lower.length > 0) chosen = lower[0];
}

if (!chosen) {
  console.error(`loader: mcode ${requested} is older than every supported patch.`);
  console.error(`  available: ${available.join(", ")}`);
  console.error(`  no patches/<v>/ with v <= ${requested}.`);
  process.exit(2);
}

const patcher = join(PATCHES_DIR, chosen, "mcode-patch-quota.mjs");
if (!existsSync(patcher)) {
  console.error(`loader: patches/${chosen}/mcode-patch-quota.mjs missing`);
  process.exit(2);
}

if (chosen !== requested) {
  console.error(`[mcode-hub] mcode ${requested} -> using patches/${chosen}/ (closest available <=)`);
}

// Forward argv: the patcher reads process.argv itself, so importing the
// file runs its main() in this process with the original argv intact.
await import(pathToFileURL(patcher).href);
