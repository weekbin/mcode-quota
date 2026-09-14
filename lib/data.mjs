// lib/data.mjs — data collection for the native (custom-command) status line.
//
// mcode 0.4.0 hands a `custom-command` status item a JSON line on stdin
// describing the current session, and renders up to 5 lines of the command's
// stdout below (or above) the built-in status row. That gives us the session
// id and model without patching anything — but the live runtime objects are
// out of reach, so every figure has to come from disk.
//
// Sources, and why:
//   session tokens / 输入 / 输出 / 缓存 / 轮数
//       SUM over local_runtime_token_usage for the session id.
//   context used / window
//       the session's newest assistant row carries context_usage.usedTokens
//       and context_usage.contextWindowTokens — the window mcode ACTUALLY
//       resolved for that turn. Reading limit.context out of config.yaml is
//       not equivalent: the user's config says 512000 while the live window
//       on later turns is 1000000 (they switched to the 1M option), so a
//       config-derived percentage was wrong by 2x.
//   今日 按模型
//       message rows carry the model name; token_usage carries the totals,
//       joined on turn_id.
//   5h / 周
//       `mmx quota show`, cached on disk so a 10 s status tick does not spawn
//       mmx six times a minute.
//
// Everything here is best-effort: a missing table, a schema change or a dead
// mmx degrades a single row, never the whole line.

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";

export const DEFAULT_DB = (process.env.HOME || "~") + "/.minimax/v2/sqlite/runtime-state.sqlite";
export const CACHE_DIR = (process.env.MCODEX_CACHE_DIR || (process.env.XDG_CACHE_HOME || (process.env.HOME || "~") + "/.cache") + "/mcodex");

const QUOTA_TTL_MS = Number(process.env.MCODE_QUOTA_TTL_MS || 60_000);
const MMX_TIMEOUT_MS = Number(process.env.MCODE_QUOTA_MMX_TIMEOUT_MS || 20_000);
const TODAY_STATE_TTL_MS = Number(process.env.MCODE_QUOTA_TODAY_TTL_MS || 60_000);

// ---------------------------------------------------------------------------
// cache helpers
// ---------------------------------------------------------------------------
function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

function writeJsonAtomic(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = path + ".tmp" + process.pid;
    writeFileSync(tmp, JSON.stringify(value), "utf-8");
    renameSync(tmp, path);      // atomic: a concurrent reader never sees a half file
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// sqlite
// ---------------------------------------------------------------------------
let sqliteModP = null;
export async function openDb(dbPath) {
  if (!sqliteModP) sqliteModP = import("node:sqlite");
  const { DatabaseSync } = await sqliteModP;
  if (!existsSync(dbPath)) return null;
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

const tryGet = (db, sql, params) => {
  try { return db.prepare(sql).get(...params); } catch { return null; }
};
const tryAll = (db, sql, params) => {
  try { return db.prepare(sql).all(...params); } catch { return []; }
};

// Session totals. SUM, not bare columns: a bare column alongside COUNT() makes
// SQLite treat the query as an aggregate and return ONE ARBITRARY ROW's value,
// which under-reports the session by orders of magnitude.
export function fetchSessionTotals(db, sessionId) {
  if (!db || !sessionId) return null;
  const row = tryGet(db,
    "SELECT COALESCE(SUM(input_tokens),0) AS inputTokens, " +
    "COALESCE(SUM(output_tokens),0) AS outputTokens, " +
    "COALESCE(SUM(reasoning_tokens),0) AS reasoningTokens, " +
    "COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens, " +
    "COALESCE(SUM(cache_write_tokens),0) AS cacheWriteTokens, " +
    "COUNT(DISTINCT turn_id) AS turns " +
    "FROM local_runtime_token_usage WHERE session_id = ?", [sessionId]);
  if (!row) return null;
  const input = Number(row.inputTokens ?? 0);
  const output = Number(row.outputTokens ?? 0);
  const cache = Number(row.cacheReadTokens ?? 0);
  const reasoning = Number(row.reasoningTokens ?? 0);
  const turns = Number(row.turns ?? 0);
  if (input + output + cache <= 0) return null;
  const hitDenom = cache + input;
  return {
    valid: true,
    total: input + output + cache,
    input, output, cache, reasoning, turns,
    cacheHit: hitDenom > 0 ? cache / hitDenom : null,
    source: "sqlite",
  };
}

// Context: the newest assistant row for the session that carries a snapshot.
// Both figures come from the same row so used/window are always consistent.
export function fetchContext(db, sessionId) {
  if (!db || !sessionId) return null;
  const row = tryGet(db,
    "SELECT json_extract(data_json,'$.context_usage.usedTokens') AS used, " +
    "json_extract(data_json,'$.context_usage.contextWindowTokens') AS win, " +
    "json_extract(data_json,'$.context_usage_telemetry.localTokens') AS localTok " +
    "FROM local_runtime_message_rows " +
    "WHERE session_id = ? AND role = 'assistant' " +
      "AND json_extract(data_json,'$.context_usage') IS NOT NULL " +
    "ORDER BY id DESC LIMIT 1", [sessionId]);
  if (!row) return null;
  const win = Number(row.win);
  const used = Number(row.used ?? row.localTok);
  if (!Number.isFinite(win) || win <= 0 || !Number.isFinite(used)) return null;
  return { used, window: win };
}

// 今日 按模型. Message rows hold the model name, token_usage holds the totals;
// they join on turn_id (local_runtime_token_usage.model is always NULL).
//
// The time-filtered scan has no usable index (no created_at_ms index, ~5 KB of
// data_json per row), so it costs ~90 ms on a large install. That is fine here
// — we are a short-lived subprocess, not the TUI event loop — but we still
// keep a per-day cache so a 10 s tick does not repeat it.
export function fetchTodayByModel(db, cacheDir = CACHE_DIR) {
  if (!db) return null;
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayEnd = dayStart + 86400 * 1000;
  const cachePath = join(cacheDir, "today-by-model.json");

  let state = readJson(cachePath);
  if (!state || state.dayStartMs !== dayStart || !Array.isArray(state.items)) {
    state = { dayStartMs: dayStart, fetchedAt: 0, items: [], lastId: 0, warmed: false };
  }
  const lastId = Number(state.lastId) || 0;

  // Schema probe: the incremental path needs a monotonic `id`.
  const cols = tryAll(db, "PRAGMA table_info(local_runtime_message_rows)", []);
  const hasRowId = cols.some((c) => c.name === "id" && (c.pk === 1 || c.pk === "1"));

  const MODEL_EXPR = "json_extract(data_json, '$.context_usage_telemetry.model')";
  let rows = [];
  let newLastId = lastId;
  if (state.warmed && hasRowId) {
    // Incremental: `id` is INTEGER PRIMARY KEY AUTOINCREMENT, so ids are
    // strictly monotonic and "new rows" == "id > lastId". SQLite serves this
    // as a primary-key range SEARCH instead of a table SCAN.
    rows = tryAll(db,
      "SELECT id, turn_id, " + MODEL_EXPR + " AS model " +
      "FROM local_runtime_message_rows " +
      "WHERE id > ? AND role='assistant' AND turn_id IS NOT NULL " +
        "AND " + MODEL_EXPR + " IS NOT NULL", [lastId]);

    // TTL early-return: if no new rows AND the cached items are still within
    // TODAY_STATE_TTL_MS, skip the full-day token re-aggregation and the
    // cache rewrite entirely. mcode 0.4.x's customStatus runner fires this
    // every `intervalSeconds` (default 10s), so a statusline that does
    // ~58K-row scan + atomic JSON write on every call is the difference
    // between "instant" and "noticeable lag" on the picker / welcome screen
    // — especially after the v3.3.3 fix that made `collect` run even when
    // `!sessionId` (so this code path now fires on every pick-screen tick,
    // not just inside active sessions).
    if (rows.length === 0 &&
        state.fetchedAt && Date.now() - state.fetchedAt < TODAY_STATE_TTL_MS &&
        Array.isArray(state.items) && state.items.length > 0) {
      return state.items;
    }
  } else if (state.fetchedAt && Date.now() - state.fetchedAt < TODAY_STATE_TTL_MS && state.items.length) {
    // Fresh enough and we already have a full picture for today.
    return state.items;
  } else {
    rows = tryAll(db,
      "SELECT turn_id, " + MODEL_EXPR + " AS model " +
      "FROM local_runtime_message_rows " +
      "WHERE role='assistant' AND turn_id IS NOT NULL " +
        "AND created_at_ms >= ? AND created_at_ms < ? " +
        "AND " + MODEL_EXPR + " IS NOT NULL", [dayStart, dayEnd]);
  }

  const turnToModel = new Map(state.turnToModel ? Object.entries(state.turnToModel) : []);
  for (const r of rows) {
    if (typeof r.id === "number" && r.id > newLastId) newLastId = r.id;
    if (r.turn_id && r.model) turnToModel.set(r.turn_id, r.model);
  }
  if (hasRowId && !state.warmed) {
    const mx = tryGet(db, "SELECT MAX(id) AS m FROM local_runtime_message_rows", []);
    newLastId = Number(mx && mx.m) || 0;
  }

  const tokRows = tryAll(db,
    "SELECT turn_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens " +
    "FROM local_runtime_token_usage WHERE ts >= ? AND ts < ?", [dayStart, dayEnd]);

  const agg = new Map();
  for (const r of tokRows) {
    const model = (r.turn_id && turnToModel.get(r.turn_id)) || "<unknown>";
    const t = (r.input_tokens || 0) + (r.output_tokens || 0) +
              (r.cache_read_tokens || 0) + (r.cache_write_tokens || 0);
    agg.set(model, (agg.get(model) || 0) + t);
  }
  const items = [...agg.entries()]
    .map(([model, total]) => ({ model, total }))
    .sort((a, b) => b.total - a.total);

  writeJsonAtomic(cachePath, {
    dayStartMs: dayStart,
    fetchedAt: Date.now(),
    items,
    lastId: newLastId,
    warmed: true,
    turnToModel: Object.fromEntries(turnToModel),
  });
  return items;
}

// ---------------------------------------------------------------------------
// mmx quota (cached on disk)
// ---------------------------------------------------------------------------
const pickGeneral = (rows) =>
  Array.isArray(rows) ? (rows.find((r) => r?.model_name === "general") || rows[0] || null) : null;

const pct = (n) =>
  typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;

export const fmtReset = (ms) => {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "";
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (d > 0) return String(d) + "d " + h + "h";
  if (h > 0) return h + "h " + m + "m";
  if (m > 0) return m + "m";
  return totalSec + "s";
};

function runMmx() {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn("mmx", ["quota", "show", "--output", "json", "--quiet"], {
        stdio: ["ignore", "pipe", "pipe"], detached: true,
      });
    } catch (e) { reject(e); return; }
    let out = "", err = "", killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { process.kill(-proc.pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch {} }
    }, MMX_TIMEOUT_MS);
    proc.stdout.on("data", (b) => { out += b.toString("utf8"); });
    proc.stderr.on("data", (b) => { err += b.toString("utf8"); });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error("mmx timed out"));
      if (code !== 0) return reject(new Error("mmx exited " + code + ": " + err.slice(0, 200)));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

// Returns the quota state, or a stale cached copy if mmx fails. The cache is
// what keeps a 10 s status tick from spawning mmx six times a minute.
export async function fetchQuota(cacheDir = CACHE_DIR) {
  const cachePath = join(cacheDir, "quota.json");
  const cached = readJson(cachePath);
  const fresh = cached && typeof cached.fetchedAt === "number" &&
    Date.now() - cached.fetchedAt < QUOTA_TTL_MS;
  if (fresh) return cached.raw;

  const mmxOnPath = String(process.env.PATH || "").split(":").some((d) => d && existsSync(d + "/mmx"));
  if (!mmxOnPath) return cached ? cached.raw : null;
  try {
    const payload = await runMmx();
    const g = pickGeneral(payload?.model_remains);
    const raw = {
      valid: !!g,
      dRem: pct(g?.current_interval_remaining_percent),
      dReset: fmtReset(g?.remains_time),
      wRem: pct(g?.current_weekly_remaining_percent),
      wReset: fmtReset(g?.weekly_remains_time),
    };
    if (raw.valid) writeJsonAtomic(cachePath, { fetchedAt: Date.now(), raw });
    return raw;
  } catch {
    return cached ? cached.raw : null;
  }
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------
export async function collect({ sessionId, dbPath = DEFAULT_DB, cacheDir = CACHE_DIR }) {
  const db = await openDb(dbPath);
  let session = null, context = null, today = null, quota = null;
  try {
    if (db) {
      session = fetchSessionTotals(db, sessionId);
      context = fetchContext(db, sessionId);
      const items = fetchTodayByModel(db, cacheDir);
      today = { valid: Array.isArray(items) && items.length > 0, items: items || [] };
    }
  } finally {
    try { if (db) db.close(); } catch {}
  }
  try {
    quota = await fetchQuota(cacheDir);
  } catch { quota = null; }

  return {
    quota,
    session,
    context,
    today,
    placeholders: {
      session: !session,
      context: !context,
      today: !(today && today.valid),
    },
    tailMode: (() => {
      const v = String(process.env.MCODE_QUOTA_TAIL || "").toLowerCase();
      return v === "compact" || v === "full" ? v : "auto";
    })(),
  };
}

export { tryGet, tryAll };
