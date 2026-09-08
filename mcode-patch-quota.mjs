#!/usr/bin/env node
// mcode-patch-quota.mjs
//
// Universal mcode status-bar quota patcher. Idempotent. No hardcoded
// obfuscated short names — anchors are discovered by structural matching.
//
// What it does:
//   1. Resolves the current mcode launcher from $MCODE_CODE_ROOT (or
//      ~/.minimax-code). Refuses to run if launcher missing.
//   2. Backs up the launcher on first touch (one backup per release).
//   3. If the launcher is already patched (differs from backup), exits 0.
//   4. Calls mcode-find-anchors.mjs to locate:
//        - WIDGET class (extends status renderer base)
//        - WIDGET_BODY_END (position of the class's closing `}`)
//        - CTOR_END      (position of the constructor's closing `}`)
//   5. Edits the launcher in two places, byte-exact:
//        a) right after CTOR_END: insert a `static { ... }` block
//           (ES2022 class field; the only construct that allows arbitrary
//           statements at the class body's top level) that calls
//           __mcodeQuotaStart with this.requestRender as the update cb.
//        b) right before WIDGET_BODY_END: insert a `render()` method
//           that wraps super.render() and appends sidecar-rendered lines.
//   6. Writes the mcode-quota-fetcher sidecar into the launcher chunks dir.
//   7. Verifies the patched launcher with `node --check`; rolls back on failure.

import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIND_ANCHORS = join(__dirname, "mcode-find-anchors.mjs");

// ============================================================================
// Sidecar body (kept inline to make the patcher self-contained).
// Inlined as a const so we can `writeFileSync` it after splicing the launcher.
// ============================================================================
const SIDECAR_BODY = `import { spawn } from "node:child_process";
const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

let raw = { valid: false, dRem: null, dReset: "", wRem: null, wReset: "", fetchedAt: 0 };
let onUpdateCb = null;

const C_SUCCESS = "38;2;60;160;90";
const C_WARNING = "38;2;200;150;40";
const C_ERROR   = "38;2;200;80;80";
const C_MUTED   = "38;2;140;140;140";
const C_RESET   = "0";
const C_LABEL   = "38;2;180;180;180";

const MAX_BAR_WIDTH = 20;
const MIN_BAR_WIDTH = 12;

const pct = (n) =>
  typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;

const fmtReset = (ms) => {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "";
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (d > 0) return \`\${d}d \${h}h\`;
  if (h > 0) return \`\${h}h \${m}m\`;
  if (m > 0) return \`\${m}m\`;
  return \`\${totalSec}s\`;
};

const colorFor = (rem) =>
  rem == null ? C_MUTED : rem <= 10 ? C_ERROR : rem <= 30 ? C_WARNING : C_SUCCESS;

const buildBar = (rem, width) => {
  const w = Math.max(MIN_BAR_WIDTH, Math.min(MAX_BAR_WIDTH, width | 0));
  if (rem == null) return { text: "░".repeat(w), colored: false };
  const c = colorFor(rem);
  const filled = Math.max(0, Math.min(w, Math.round((rem / 100) * w)));
  const empty = w - filled;
  const filledSeq = "\\x1b[" + c + "m" + "█".repeat(filled) + "\\x1b[" + C_RESET + "m";
  const emptySeq  = "\\x1b[" + C_MUTED + "m" + "░".repeat(empty) + "\\x1b[" + C_RESET + "m";
  return { text: filledSeq + emptySeq, colored: true };
};

const pickGeneral = (rows) =>
  Array.isArray(rows) ? (rows.find((r) => r?.model_name === "general") || rows[0] || null) : null;

function renderOne(label, rem, reset, barWidth) {
  if (rem == null) {
    return "\\x1b[" + C_MUTED + "m" + label + "\\x1b[" + C_RESET + "m" + "  (no data)";
  }
  const c = colorFor(rem);
  const labelSeq = "\\x1b[" + C_LABEL + "m" + label + "\\x1b[" + C_RESET + "m";
  const barSeq = buildBar(rem, barWidth).text;
  const pctSeq = "\\x1b[" + c + "m" + rem + "% left\\x1b[" + C_RESET + "m";
  const tail = reset
    ? "  \\x1b[" + C_MUTED + "m· resets in " + reset + "\\x1b[" + C_RESET + "m"
    : "";
  return labelSeq + " [" + barSeq + "] " + pctSeq + tail;
}

const HORIZ_MIN_WIDTH = 88;

globalThis.__mcodeQuotaRender = function (width) {
  if (!raw.valid) return [];
  if (width == null || width < 0) width = 0;
  if (width >= HORIZ_MIN_WIDTH) {
    const barWidth = Math.max(12, Math.floor((width - 40) / 2));
    const line1 = renderOne("5-hour", raw.dRem, "", barWidth);
    const line2 = renderOne("Weekly", raw.wRem, "", barWidth);
    const sep = "  \\x1b[" + C_MUTED + "m·\\x1b[" + C_RESET + "m  ";
    return [line1 + sep + line2];
  }
  const barWidth = Math.max(12, width - 38);
  return [
    renderOne("5-hour", raw.dRem, raw.dReset, barWidth),
    renderOne("Weekly", raw.wRem, raw.wReset, barWidth),
  ];
};

globalThis.__mcodeQuotaStart = function (onUpdate) {
  onUpdateCb = onUpdate;
  const tick = async () => {
    if (Date.now() - raw.fetchedAt > CACHE_TTL_MS) {
      await fetchOnce();
    } else {
      onUpdateCb?.();
    }
  };
  tick();
  const id = setInterval(tick, CACHE_TTL_MS);
  if (typeof id.unref === "function") id.unref();
  return id;
};

const runMmx = () =>
  new Promise((resolve, reject) => {
    const proc = spawn("mmx", ["quota", "show", "--output", "json", "--quiet"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    proc.stdout.on("data", (b) => { out += b.toString("utf8"); });
    proc.stderr.on("data", (b) => { err += b.toString("utf8"); });
    const killTimer = setTimeout(() => proc.kill("SIGKILL"), FETCH_TIMEOUT_MS);
    proc.on("error", (e) => { clearTimeout(killTimer); reject(e); });
    proc.on("close", (code) => {
      clearTimeout(killTimer);
      if (code !== 0) return reject(new Error(\`mmx exited \${code}: \${err.trim()}\`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });

const fetchOnce = async () => {
  try {
    const payload = await runMmx();
    const g = pickGeneral(payload?.model_remains);
    raw = {
      valid: !!g,
      dRem: pct(g?.current_interval_remaining_percent),
      dReset: fmtReset(g?.remains_time),
      wRem: pct(g?.current_weekly_remaining_percent),
      wReset: fmtReset(g?.weekly_remains_time),
      fetchedAt: Date.now(),
    };
  } catch {
    raw = { ...raw, fetchedAt: Date.now() };
  } finally {
    onUpdateCb?.();
  }
};
`;

// ============================================================================
// Step 1: resolve launcher
// ============================================================================
const CODE_ROOT = process.env.MCODE_CODE_ROOT || `${process.env.HOME}/.minimax-code`;
const CURRENT_FILE = join(CODE_ROOT, "current");
if (!existsSync(CURRENT_FILE)) {
  process.stderr.write(`mcode current pointer not found: ${CURRENT_FILE}\n`);
  process.exit(1);
}
const CURRENT_VERSION = readFileSync(CURRENT_FILE, "utf-8").trim();
const CHUNKS_DIR = join(CODE_ROOT, "releases", CURRENT_VERSION, "lib", "node_modules", "@minimax-ai", "code", "chunks");
if (!existsSync(CHUNKS_DIR)) {
  process.stderr.write(`chunks dir not found: ${CHUNKS_DIR}\n`);
  process.exit(1);
}
const launcherCandidates = readdirSync(CHUNKS_DIR).filter((f) => /^launcher-.*\.js$/.test(f));
if (launcherCandidates.length === 0) {
  process.stderr.write(`no launcher-*.js found in ${CHUNKS_DIR}\n`);
  process.exit(1);
}
const LAUNCHER = join(CHUNKS_DIR, launcherCandidates[0]);
const BACKUP = `${LAUNCHER}.unpatched.bak`;

// ============================================================================
// Step 2: backup
// ============================================================================
if (!existsSync(BACKUP)) {
  copyFileSync(LAUNCHER, BACKUP);
}

// ============================================================================
// Step 3: skip if already patched
// ============================================================================
// We can't just diff against backup — mcode updates may legitimately change
// the launcher without changing it back. So we look for the actual patch
// marker (__mcodeQuotaStart / __mcodeQuotaRender) — if found, assume patched.
const current = readFileSync(LAUNCHER, "utf-8");
if (current.includes("__mcodeQuotaStart") && current.includes("__mcodeQuotaRender")) {
  process.stderr.write(`[mcode-quota] already patched for ${CURRENT_VERSION} (${LAUNCHER})\n`);
  // Re-write sidecar in case the old one is from before this patcher.
  const SIDECAR = join(CHUNKS_DIR, "mcode-quota-fetcher-9f8a7b.mjs");
  writeFileSync(SIDECAR, SIDECAR_BODY, "utf-8");
  process.exit(0);
}

// ============================================================================
// Step 4: find anchors
// ============================================================================
let anchors;
try {
  anchors = execFileSync(process.execPath, [FIND_ANCHORS, LAUNCHER], { encoding: "utf-8" });
} catch (e) {
  process.stderr.write(`[mcode-quota] anchor finder failed: ${e.stderr ?? e.message}\n`);
  process.exit(2);
}
const kv = Object.fromEntries(
  anchors
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const m = l.match(/^(\w+)=(.*)$/);
      if (!m) return [null, null];
      const v = m[2].replace(/^'/, "").replace(/'$/, "").replace(/'\\''/g, "'");
      return [m[1], v];
    })
    .filter(([k]) => k),
);
const BASE = kv.BASE;
const WIDGET = kv.WIDGET;
const WIDGET_BODY_END = Number(kv.WIDGET_BODY_END);
const CTOR_END = Number(kv.CTOR_END);
if (!BASE || !WIDGET || !Number.isFinite(WIDGET_BODY_END) || !Number.isFinite(CTOR_END)) {
  process.stderr.write(`[mcode-quota] could not parse anchors:\n${anchors}\n`);
  process.exit(2);
}
process.stderr.write(`[mcode-quota] anchors: BASE=${BASE} WIDGET=${WIDGET} CTOR_END=${CTOR_END} WIDGET_BODY_END=${WIDGET_BODY_END}\n`);

// ============================================================================
// Step 5: splice patches
// ============================================================================
//
// Patch A: insert a `static { ... }` block right after the constructor body
//   closes. `static { ... }` is the only way to run arbitrary statements at
//   the class body's top level in ES2022 (it counts as a class field).
//   The block calls __mcodeQuotaStart with this.requestRender as the
//   update callback so fetcher updates trigger an mcode redraw.
//
// Patch B: insert a `render()` method right before the widget class body
//   closes. It wraps super.render() and appends the sidecar-rendered lines.
//   Since the widget extends the base status renderer, the inherited
//   render is called via super.render() and the result is augmented.
//
const PATCH_AFTER_CTOR = `static{;if(typeof globalThis.__mcodeQuotaStart==="function")globalThis.__mcodeQuotaStart(()=>{if(this.requestRender)setTimeout(()=>this.requestRender(),0)})}`;

const PATCH_BEFORE_CLASS_END = `render(e){let r=super.render(e);if(Array.isArray(r)){let _qr=typeof globalThis.__mcodeQuotaRender==="function"?globalThis.__mcodeQuotaRender(e):[];if(Array.isArray(_qr)&&_qr.length>0)return[...r,..._qr]}return r}`;

if (CTOR_END >= WIDGET_BODY_END - 1) {
  process.stderr.write(`[mcode-quota] CTOR_END (${CTOR_END}) must be < WIDGET_BODY_END - 1 (${WIDGET_BODY_END - 1})\n`);
  process.exit(2);
}

// Splice: insert in order. After PATCH_AFTER_CTOR, the WIDGET_BODY_END
// offset shifts by PATCH_AFTER_CTOR.length, so adjust the second splice.
const after = current.slice(0, CTOR_END + 1) + PATCH_AFTER_CTOR + current.slice(CTOR_END + 1);
const newWIDGET_BODY_END = WIDGET_BODY_END + PATCH_AFTER_CTOR.length;
const finalContent =
  after.slice(0, newWIDGET_BODY_END) + PATCH_BEFORE_CLASS_END + after.slice(newWIDGET_BODY_END);

// Write and verify.
writeFileSync(LAUNCHER, finalContent, "utf-8");
try {
  execFileSync(process.execPath, ["--check", LAUNCHER], { stdio: "pipe" });
} catch (e) {
  copyFileSync(BACKUP, LAUNCHER);
  process.stderr.write(
    `[mcode-quota] patched launcher failed node --check; rolled back\n` +
      `stderr: ${e.stderr?.toString() ?? "(none)"}\n` +
      `stdout: ${e.stdout?.toString() ?? "(none)"}\n` +
      `code: ${e.status}\n`,
  );
  process.exit(2);
}

// ============================================================================
// Step 6: write sidecar
// ============================================================================
const SIDECAR = join(CHUNKS_DIR, "mcode-quota-fetcher-9f8a7b.mjs");
writeFileSync(SIDECAR, SIDECAR_BODY, "utf-8");

process.stderr.write(`[mcode-quota] patched launcher for ${CURRENT_VERSION}\n`);
process.stderr.write(`[mcode-quota] sidecar: ${SIDECAR}\n`);
process.stderr.write(`\n`);
process.stderr.write(`Launch mcode with the sidecar preloaded:\n`);
process.stderr.write(`  NODE_OPTIONS="--import=${SIDECAR}" mcode\n`);
process.stderr.write(`\n`);
process.stderr.write(`Or use the wrapper:\n`);
process.stderr.write(`  mcode-with-quota\n`);
