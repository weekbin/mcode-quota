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
//           statements at the class body's top level) that:
//              - wraps the prototype's setState to capture the widget's
//                `runtime` and merged `shellState` to globalThis on every
//                call, so the sidecar can use them;
//              - calls globalThis.__mcodeQuotaStart to kick off the
//                background fetchers (mmx quota + session tokens).
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
//
// Data sources:
//   - mmx CLI: `mmx quota show --output json --quiet` → 5h + weekly remaining
//   - mcode runtime: getSessionUsageSummary(agentSessionId) → input / output /
//     cache_read / reasoning tokens for the current mcode session
// Bridge: the patched static block captures the widget's `this.runtime` and
//   the latest setState merge (`shellState`) into globalThis. The sidecar
//   reads them to call the runtime API. No env vars, no IPC — same V8 isolate.
// ============================================================================
const SIDECAR_BODY = `import { spawn } from "node:child_process";
import { createRequire as _mcodeQuotaReq } from "node:module";
import { existsSync } from "node:fs";
const _require = _mcodeQuotaReq(import.meta.url);
const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 20_000;   // mmx can be slow on a busy network
const SESSION_TTL_MS = 10_000;

let raw = { valid: false, dRem: null, dReset: "", wRem: null, wReset: "", fetchedAt: 0 };
let session = { valid: false, total: 0, input: 0, output: 0, cache: 0, reasoning: 0, sessionId: null, fetchedAt: 0 };
let onUpdateCb = null;
let sessionTimer = null;

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
  rem == null ? C_MUTED : rem <= 20 ? C_ERROR : rem <= 50 ? C_WARNING : C_SUCCESS;

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

const fmtTok = (n) => {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + "K";
  return String(n);
};

function renderSessionChunk() {
  if (!session.valid) return null;
  const labelSeq = "\\x1b[" + C_LABEL + "m" + "Session" + "\\x1b[" + C_RESET + "m";
  const totalSeq = "\\x1b[" + C_SUCCESS + "m" + fmtTok(session.total) + "\\x1b[" + C_RESET + "m";
  const dot = "\\x1b[" + C_MUTED + "m·\\x1b[" + C_RESET + "m";
  const detail = " (in " + fmtTok(session.input) + " " + dot + " out " + fmtTok(session.output) + " " + dot + " cache " + fmtTok(session.cache) + ")";
  return labelSeq + " " + totalSeq + detail;
}

const HORIZ_MIN_WIDTH = 110;
const NARROW_MIN_WIDTH = 80;

globalThis.__mcodeQuotaRender = function (width) {
  if (width == null || width < 0) width = 0;
  const sep = "  \\x1b[" + C_MUTED + "m·\\x1b[" + C_RESET + "m  ";
  const sess = renderSessionChunk();
  const lines = [];
  if (raw.valid) {
    if (width >= HORIZ_MIN_WIDTH) {
      const barWidth = Math.max(12, Math.floor((width - (sess ? 65 : 40)) / 2));
      const line1 = renderOne("5-hour", raw.dRem, "", barWidth);
      const line2 = renderOne("Weekly", raw.wRem, "", barWidth);
      lines.push(line1 + sep + line2 + (sess ? sep + sess : ""));
    } else if (width >= NARROW_MIN_WIDTH) {
      const barWidth = Math.max(12, Math.floor((width - (sess ? 55 : 38)) / 2));
      const weeklyBarWidth = Math.max(10, barWidth - (sess ? 6 : 0));
      lines.push(renderOne("5-hour", raw.dRem, raw.dReset, barWidth));
      lines.push(renderOne("Weekly", raw.wRem, raw.wReset, weeklyBarWidth) + (sess ? sep + sess : ""));
    } else {
      const barWidth = Math.max(12, width - 38);
      lines.push(renderOne("5-hour", raw.dRem, raw.dReset, barWidth));
      lines.push(renderOne("Weekly", raw.wRem, raw.wReset, barWidth));
      if (sess) lines.push(sess);
    }
  } else if (sess) {
    lines.push(sess);
  }
  return lines;
};

globalThis.__mcodeQuotaStart = function (onUpdate) {
  onUpdateCb = onUpdate;
  const tick = async () => {
    if (Date.now() - raw.fetchedAt > CACHE_TTL_MS) {
      await fetchQuotaOnce();
    } else {
      onUpdateCb?.();
    }
  };
  tick();
  const id = setInterval(tick, CACHE_TTL_MS);
  if (typeof id.unref === "function") id.unref();
  startSessionPoller();
  return id;
};

// Auto-start polling on import. The previous design required the launcher
// to call __mcodeQuotaStart from a static { } block, but we removed that
// patch payload. The sidecar can run on its own — fetchSessionOnce is a
// no-op when globalThis.__mcodeRuntime / __mcodeShellState are missing,
// and the render() wrapper in the launcher will populate them on the
// first frame.
// We defer to queueMicrotask so the function bodies (fetchQuotaOnce etc.)
// are fully initialized before we trigger the first tick.
queueMicrotask(() => {
  if (typeof globalThis.__mcodeQuotaStart === "function") {
    globalThis.__mcodeQuotaStart(() => {});
  }
});

// ---- mmx invocation: fail-fast, fail-safe -------------------------------
// Critical: the sidecar can be loaded by many mcode CLI processes at once
// (e.g., when the user runs mcode-with-quota in several terminals). If
// mmx hangs or fails, the previous design would SIGKILL after 5s — but
// Node's child_process.spawn with stdio:pipe creates a watcher process
// that can survive SIGKILL and turn into a zombie, multiplying across
// instances. The fix:
//   1. detached: true — child gets its own process group, so we can
//      SIGKILL the whole tree via process.kill(-pid, "SIGKILL").
//   2. isMmxOnPath() probe — short-circuit if mmx isn't installed.
//   3. Failure-count cap (MMX_MAX_FAILURES) — stop trying after N fails.
//   4. The interval is unref()'d so it doesn't keep the Node process
//      alive past the launcher.
let mmxAvailable = null;
let mmxFailureCount = 0;
// Cap is per session. 20s × 10 = 200s of "no quota" if mmx is broken —
// we don't give up too eagerly because mmx is occasionally slow (~5s on
// the user's network). 5 failed ticks covers a 5-minute outage, which is
// the right trade-off: stay quiet during a transient mmx failure but
// re-attempt when the user thinks it's been long enough.
const MMX_MAX_FAILURES = 5;
// After this many seconds since the last success, reset the failure
// counter so a recovered mmx gets a fresh chance. 5 minutes.
const MMX_FAILURE_RESET_MS = 5 * 60_000;

function isMmxOnPath() {
  if (mmxAvailable !== null) return mmxAvailable;
  const PATH = process.env.PATH || "";
  mmxAvailable = PATH.split(":").some((d) => d && existsSync(d + "/mmx"));
  return mmxAvailable;
}

const runMmx = () =>
  new Promise((resolve, reject) => {
    if (!isMmxOnPath()) {
      reject(new Error("mmx CLI not on PATH"));
      return;
    }
    let proc;
    try {
      proc = spawn("mmx", ["quota", "show", "--output", "json", "--quiet"], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });
    } catch (e) {
      reject(e);
      return;
    }
    let out = "", err = "";
    let killed = false;
    let stderrBytes = 0;
    const STDERR_CAP = 64 * 1024;
    proc.stdout.on("data", (b) => { out += b.toString("utf8"); });
    proc.stderr.on("data", (b) => {
      stderrBytes += b.length;
      if (stderrBytes < STDERR_CAP) err += b.toString("utf8");
    });
    const killTimer = setTimeout(() => {
      killed = true;
      try { process.kill(-proc.pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch {} }
    }, FETCH_TIMEOUT_MS);
    proc.on("error", (e) => { clearTimeout(killTimer); reject(e); });
    proc.on("close", (code, signal) => {
      clearTimeout(killTimer);
      if (killed || (signal && signal !== "SIGTERM")) {
        try { process.kill(-proc.pid, "SIGKILL"); } catch {}
      }
      if (killed) return reject(new Error("mmx timed out after " + FETCH_TIMEOUT_MS + "ms"));
      if (code !== 0) return reject(new Error("mmx exited " + code + ": " + err.trim().slice(0, 200)));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });

const fetchQuotaOnce = async () => {
  if (mmxFailureCount >= MMX_MAX_FAILURES) {
    // After a long quiet period, give mmx a fresh chance — it may have
    // recovered from a transient outage.
    if (raw.lastSuccessAt && Date.now() - raw.lastSuccessAt > MMX_FAILURE_RESET_MS) {
      mmxFailureCount = 0;
    } else {
      onUpdateCb?.();
      return;
    }
  }
  try {
    const payload = await runMmx();
    const g = pickGeneral(payload?.model_remains);
    const now = Date.now();
    raw = {
      valid: !!g,
      dRem: pct(g?.current_interval_remaining_percent),
      dReset: fmtReset(g?.remains_time),
      wRem: pct(g?.current_weekly_remaining_percent),
      wReset: fmtReset(g?.weekly_remains_time),
      fetchedAt: now,
      lastSuccessAt: g ? now : (raw.lastSuccessAt || 0),
    };
    mmxFailureCount = 0;
  } catch (e) {
    mmxFailureCount++;
    raw = { ...raw, fetchedAt: Date.now() };
    if (mmxFailureCount >= MMX_MAX_FAILURES) {
      raw = { ...raw, valid: false };
    }
  } finally {
    onUpdateCb?.();
  }
};

// ---- SQLite direct fallback ---------------------------------------------
// mcode's runtime stores per-turn token usage in
// ~/.minimax/v2/sqlite/runtime-state.sqlite, table local_runtime_token_usage.
// This matches the schema that the runtime's own summarizeBySession() reads
// from (see chunk-CTHP2I62.js). If the runtime API ever goes away or
// returns nothing, we can read the same data directly.
let sqliteDb = null;
let sqliteDbPath = null;
const SQLITE_DEFAULT_PATH = (process.env.MCODE_QUOTA_SQLITE
  || (process.env.HOME || "~") + "/.minimax/v2/sqlite/runtime-state.sqlite");
const SQLITE_SESSION_SQL = "SELECT " +
  "COALESCE(SUM(input_tokens), 0) AS inputTokens, " +
  "COALESCE(SUM(output_tokens), 0) AS outputTokens, " +
  "COALESCE(SUM(reasoning_tokens), 0) AS reasoningTokens, " +
  "COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens, " +
  "COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens, " +
  "COALESCE(SUM(cost_usd), 0) AS costUsd, " +
  "COUNT(*) AS turns " +
  "FROM local_runtime_token_usage WHERE session_id = ?";

let _nodeSqlite = null;
async function getNodeSqlite() {
  if (_nodeSqlite) return _nodeSqlite;
  // node:sqlite is a built-in module in Node 22+ (mcode uses Node 24).
  // Dynamic import because the sidecar is itself an ESM module.
  _nodeSqlite = await import("node:sqlite");
  return _nodeSqlite;
}

function openSqlite(path) {
  if (sqliteDb && sqliteDbPath === path) return sqliteDb;
  if (sqliteDb) { try { sqliteDb.close(); } catch {} sqliteDb = null; sqliteDbPath = null; }
  // node:sqlite's DatabaseSync is sync. We use createRequire to load
  // it from CJS so we can use the synchronous API.
  const { createRequire } = _require("node:module");
  const req = createRequire(import.meta.url);
  const { DatabaseSync } = req("node:sqlite");
  sqliteDb = new DatabaseSync(path, { readOnly: true });
  sqliteDbPath = path;
  return sqliteDb;
}

function fetchSessionFromSqlite(sessionId) {
  // Try the default path first, then a few common alternates.
  const candidates = [SQLITE_DEFAULT_PATH];
  // Also accept paths derived from $MCODE_CODE_ROOT if it's a dev layout.
  for (const p of candidates) {
    try {
      const db = openSqlite(p);
      const row = db.prepare(SQLITE_SESSION_SQL).get(sessionId);
      if (!row) return null;
      return {
        inputTokens: Number(row.inputTokens ?? 0),
        outputTokens: Number(row.outputTokens ?? 0),
        reasoningTokens: Number(row.reasoningTokens ?? 0),
        cacheReadTokens: Number(row.cacheReadTokens ?? 0),
        cacheWriteTokens: Number(row.cacheWriteTokens ?? 0),
        costUsd: Number(row.costUsd ?? 0),
        turns: Number(row.turns ?? 0),
      };
    } catch {
      // Try next candidate
    }
  }
  return null;
}

async function fetchSessionOnce() {
  const runtime = globalThis.__mcodeRuntime;
  const shell = globalThis.__mcodeShellState;
  if (!shell) return;
  const sessionId = shell.agentSessionId;
  if (!sessionId) return;
  // Skip if same session is still fresh
  if (session.sessionId === sessionId && Date.now() - session.fetchedAt < SESSION_TTL_MS) return;
  let summary = null;
  let source = "runtime";
  // Path 1: mcode runtime API. Returns the summary object directly.
  // See chunk-CTHP2I62.js: getSessionUsageSummary -> content.getSessionUsageSummary
  //   -> usage.summarizeSession -> store.summarizeBySession (raw row → cE(row))
  // cE returns {inputTokens, outputTokens, reasoningTokens, cacheReadTokens,
  //   cacheWriteTokens, totalTokens, costUsd, turns}.
  try {
    const fn = runtime.getSessionUsageSummary;
    if (typeof fn === "function") {
      const result = await Promise.resolve().then(() => fn.call(runtime, sessionId));
      if (result && typeof result === "object") summary = result;
    }
  } catch {
    // fall through to sqlite
  }
  // Path 2: sqlite fallback. Same schema, no in-process coupling.
  if (!summary) {
    try {
      summary = fetchSessionFromSqlite(sessionId);
      source = summary ? "sqlite" : "none";
    } catch {
      source = "none";
    }
  }
  if (!summary) {
    session = { ...session, sessionId, fetchedAt: Date.now() };
    onUpdateCb?.();
    return;
  }
  const input = Number(summary.inputTokens ?? 0);
  const output = Number(summary.outputTokens ?? 0);
  const cache = Number(summary.cacheReadTokens ?? 0);
  const reasoning = Number(summary.reasoningTokens ?? 0);
  const total = input + output + cache;
  session = {
    valid: true,
    total, input, output, cache, reasoning,
    sessionId,
    turns: Number(summary.turns ?? 0),
    source,
    fetchedAt: Date.now(),
  };
  onUpdateCb?.();
}

function startSessionPoller() {
  if (sessionTimer) return;
  fetchSessionOnce();
  sessionTimer = setInterval(fetchSessionOnce, SESSION_TTL_MS);
  if (typeof sessionTimer.unref === "function") sessionTimer.unref();
}
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
//   The block:
//     - wraps the prototype's setState to capture the widget's
//       `this.runtime` and merged `this.shellState` to globalThis on every
//       setState call. The sidecar reads them to call the runtime API.
//     - calls __mcodeQuotaStart to kick off the background fetchers
//       (mmx quota every 60s + session tokens every 10s).
//
// Patch B: insert a `render()` method right before the widget class body
//   closes. It wraps super.render() and appends the sidecar-rendered lines.
//   Since the widget extends the base status renderer, the inherited
//   render is called via super.render() and the result is augmented.
//
// Two anchors, simpler payloads:
//
// PATCH_AFTER_CTOR (now empty — we no longer need the static block).
// State capture is done inline by the render() wrapper below. The render
// method is on the widget prototype and runs on every render, so it has
// a reliable `this` reference to grab `this.runtime` and `this.shellState`.
//
// PATCH_BEFORE_CLASS_END: the render() method override. It:
//   1. Calls super.render(e) to get the base status line(s)
//   2. Captures runtime + shellState to globalThis (the bridge)
//   3. Calls globalThis.__mcodeQuotaRender(width) to get extra lines
//   4. Spreads everything together
//   The base render IS still called via super.render() (no overwriting).
//   The new render replaces any prior render method on the class.
const PATCH_AFTER_CTOR = "";

const PATCH_BEFORE_CLASS_END = `render(e){let r=super.render(e);if(this&&this.runtime)globalThis.__mcodeRuntime=this.runtime;if(this&&this.shellState)globalThis.__mcodeShellState=this.shellState;if(Array.isArray(r)){let _qr=typeof globalThis.__mcodeQuotaRender==="function"?globalThis.__mcodeQuotaRender(e):[];if(Array.isArray(_qr)&&_qr.length>0)return[...r,..._qr]}return r}`;

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
