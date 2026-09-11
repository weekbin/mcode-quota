#!/usr/bin/env node
// tests/parity.mjs — byte-for-byte parity between the two render paths.
//
// mcodex has two implementations of the same status block:
//   * legacy  — the frozen sidecar injected into the mcode 0.3.x fork
//               (sidecar/mcode-quota-fetcher-9f8a7b.mjs)
//   * native  — lib/render.mjs, driven by the 0.4.0 `custom-command` config
//
// The user's requirement is that the native path display EXACTLY what the fork
// used to display. Duplicated formatting logic drifts silently, so this test
// feeds both the same synthetic inputs and compares the output bytes.
//
// How both sides are driven:
//   legacy — runs in-process against a synthetic sqlite file and a fake `mmx`
//            on PATH, with a hand-set shellState for the context figures
//   native — buildStatusLines() called with the equivalent plain state object
//
// Widths swept: 40..260 plus the responsive breakpoints that select different
// candidate rows (the 4-chunk detail/compact switch, the 5h/周 combined vs
// stacked switch, the today top-N switch).

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { buildStatusLines, stripAnsi } from "../lib/render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const LEGACY_SIDECAR = join(ROOT, "sidecar/mcode-quota-fetcher-9f8a7b.mjs");

let pass = 0, fail = 0;
const check = (ok, name, detail) => {
  if (ok) { pass++; console.log(`  PASS: ${name}`); }
  else { fail++; console.log(`  FAIL: ${name}${detail ? "  -- " + detail : ""}`); }
};

// ---------------------------------------------------------------------------
// Synthetic fixtures — deterministic, chosen to exercise every branch.
// ---------------------------------------------------------------------------
const NOW = new Date();
const DAY_START = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate()).getTime();
const SESSION_ID = "mvs_parity000000000000000000000001";
// The today-by-model rows live under a DIFFERENT session so they do not pollute
// the per-session aggregate we compare against. The today query is global
// (turn_id -> model across all sessions), so this is the realistic shape too.
const TODAY_SESSION_ID = "mvs_paritytoday00000000000000000001";

// Quota: 5h = 41% left / 3h 1m, week = 92% left / 3d 7h.
const MOCK_QUOTA = {
  model_remains: [{
    model_name: "general",
    current_interval_remaining_percent: 41,
    remains_time: (3 * 3600 + 1 * 60) * 1000,
    current_weekly_remaining_percent: 92,
    weekly_remains_time: (3 * 86400 + 7 * 3600) * 1000,
  }],
};

// Session: 152.3M total, 1.3M in / 366.2K out / 150.6M cache, 984 turns.
const S_IN = 1_300_000, S_OUT = 366_200, S_CACHE = 150_600_000;
const S_TURNS = 984;              // rows written by the session aggregate loop
// The today/stale rows live under todaySessionId, so the session aggregate
// sees exactly the rows written by the loop above.
const sTurnsTotal = () => S_TURNS;
// Context: 145.0K used of 512.0K.
const CTX_USED = 145_000, CTX_WINDOW = 512_000;

// Today: two models, one long GGUF name to exercise middle-ellipsis.
const TODAY_MODELS = [
  { model: "MiniMax-M3", total: 864_550_000, turns: 12 },
  { model: "Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf", total: 2_600_000, turns: 1 },
];

function buildFixtureDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE local_runtime_message_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      msg_id TEXT NOT NULL, role TEXT, turn_id TEXT, created_at_ms INTEGER NOT NULL,
      data_json TEXT NOT NULL, UNIQUE(session_id, msg_id));
    CREATE TABLE local_runtime_token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, turn_id TEXT,
      ts INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER);
  `);

  const insMsg = db.prepare(
    "INSERT INTO local_runtime_message_rows (session_id,msg_id,role,turn_id,created_at_ms,data_json) VALUES (?,?,?,?,?,?)");
  const insTok = db.prepare(
    "INSERT INTO local_runtime_token_usage (session_id,turn_id,ts,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens) VALUES (?,?,?,?,?,?,?,?)");

  // The session's own aggregate: split across a few turns so SUM/COUNT work.
  const perTurn = {
    in: Math.floor(S_IN / S_TURNS), out: Math.floor(S_OUT / S_TURNS),
    cache: Math.floor(S_CACHE / S_TURNS),
  };
  let remIn = S_IN, remOut = S_OUT, remCache = S_CACHE;
  for (let i = 0; i < S_TURNS; i++) {
    const last = i === S_TURNS - 1;
    const ti = last ? remIn : perTurn.in;
    const to = last ? remOut : perTurn.out;
    const tc = last ? remCache : perTurn.cache;
    remIn -= ti; remOut -= to; remCache -= tc;
    insTok.run(SESSION_ID, `turn-${i}`, DAY_START + 1000 * (i + 1), ti, to, tc, 0, 0);
  }

  // Today-by-model: one assistant row per model, carrying the model name, plus
  // token_usage rows keyed by the same turn_id.
  for (const m of TODAY_MODELS) {
    const tid = `today-${m.model}`;
    insMsg.run(TODAY_SESSION_ID, `msg-${m.model}`, "assistant", tid, DAY_START + 5000,
      JSON.stringify({ context_usage_telemetry: { model: m.model, localTokens: CTX_USED } }));
    insTok.run(TODAY_SESSION_ID, tid, DAY_START + 5000, m.total, 0, 0, 0, 0);
  }
  // A yesterday row that must NOT be counted by the today query.
  insMsg.run(TODAY_SESSION_ID, "msg-old", "assistant", "old-turn", DAY_START - 3600_000,
    JSON.stringify({ context_usage_telemetry: { model: "must-not-appear" } }));
  insTok.run(TODAY_SESSION_ID, "old-turn", DAY_START - 3600_000, 999_999_999, 0, 0, 0, 0);

  db.close();
}

// ---------------------------------------------------------------------------
// Drive the legacy sidecar in a child process.
// ---------------------------------------------------------------------------
function runLegacy({ dbPath, binDir, widths }) {
  const harness = `
import { writeFileSync } from "node:fs";
const widths = ${JSON.stringify(widths)};
await import(${JSON.stringify("file://" + LEGACY_SIDECAR + "?t=" + Date.now())});
globalThis.__mcodeShellState = {
  agentSessionId: ${JSON.stringify(SESSION_ID)},
  contextUsage: { usedTokens: ${CTX_USED}, contextWindowTokens: ${CTX_WINDOW} },
  contextWindowTokens: ${CTX_WINDOW},
  busy: false,
};
globalThis.__mcodeRuntime = undefined;   // force the sqlite path for session data
globalThis.__mcodeQuotaRender(200);      // kick the pollers
await new Promise((r) => setTimeout(r, 7000));
const out = {};
for (const w of widths) out[w] = globalThis.__mcodeQuotaRender(w);
writeFileSync(process.env.OUT_JSON, JSON.stringify(out));
`;
  const tmp = join(dirname(dbPath), "legacy-harness.mjs");
  writeFileSync(tmp, harness, "utf-8");
  const outJson = join(dirname(dbPath), "legacy-out.json");

  execFileSync(process.execPath, [tmp], {
    encoding: "utf-8",
    env: {
      ...process.env,
      // binDir (the DIRECTORY holding the fake mmx), not the file path —
      // a bogus PATH entry silently falls through to the real mmx.
      PATH: binDir + ":" + (process.env.PATH || ""),
      MCODE_QUOTA_SQLITE: dbPath,
      MCODE_QUOTA_TTL_MS: "60000",
      MCODE_QUOTA_TODAY_TTL_MS: "60000",
      OUT_JSON: outJson,
      MQ_PROBE: process.env.MQ_PROBE || "",
    },
    stdio: process.env.MQ_PROBE ? ["ignore", "pipe", "inherit"] : ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });

  return JSON.parse(execFileSync(process.execPath, ["-e",
    `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(outJson)},"utf8"))`,
  ], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }));
}

// ---------------------------------------------------------------------------
// Build the equivalent native state and render it.
// ---------------------------------------------------------------------------
function nativeState() {
  const cacheHitDenom = S_CACHE + S_IN;
  return {
    quota: {
      valid: true,
      dRem: 41,
      dReset: "3h 1m",
      wRem: 92,
      wReset: "3d 7h",
    },
    session: {
      valid: true,
      total: S_IN + S_OUT + S_CACHE,
      input: S_IN, output: S_OUT, cache: S_CACHE, reasoning: 0,
      turns: sTurnsTotal(),
      cacheHit: cacheHitDenom > 0 ? S_CACHE / cacheHitDenom : null,
    },
    context: { used: CTX_USED, window: CTX_WINDOW },
    today: {
      valid: true,
      items: TODAY_MODELS.map((m) => ({ model: m.model, total: m.total }))
        .sort((a, b) => b.total - a.total),
    },
    placeholders: { session: false, context: false, today: false },
    tailMode: process.env.MCODE_QUOTA_TAIL || "auto",
  };
}

// ---------------------------------------------------------------------------
async function main() {
  const work = mkdtempSync(join(tmpdir(), "mcodex-parity-"));
  const dbPath = join(work, "runtime.sqlite");
  const binDir = join(work, "bin");
  execFileSync("mkdir", ["-p", binDir]);

  buildFixtureDb(dbPath);

  // Fake mmx: emits the fixed quota payload regardless of args.
  const mmxPath = join(binDir, "mmx");
  writeFileSync(mmxPath,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(MOCK_QUOTA))});\n`, "utf-8");
  chmodSync(mmxPath, 0o755);

  const widths = [40, 48, 55, 60, 70, 79, 80, 90, 99, 100, 110, 120, 139, 140, 160, 200, 240, 260];
  console.log(`# parity: legacy sidecar vs lib/render.mjs, ${widths.length} widths\n`);

  let legacy;
  try {
    legacy = runLegacy({ dbPath, binDir, widths });
  } catch (e) {
    console.log(`  FAIL: legacy harness errored: ${(e.stderr || e.message || "").toString().slice(0, 500)}`);
    fail++;
    rmSync(work, { recursive: true, force: true });
    console.log(`\n${pass} pass, ${fail} fail`);
    process.exit(1);
  }

  const state = nativeState();
  let mismatches = 0;
  for (const w of widths) {
    const legacyLines = legacy[String(w)] || [];
    const nativeLines = buildStatusLines(state, w);
    const a = legacyLines.map(stripAnsi).join("\n");
    const b = nativeLines.map(stripAnsi).join("\n");
    const samePlain = a === b;
    const sameRaw = JSON.stringify(legacyLines) === JSON.stringify(nativeLines);
    if (sameRaw) {
      check(true, `width ${w}: identical (${legacyLines.length} rows)`);
    } else {
      mismatches++;
      check(false, `width ${w}: MISMATCH`,
        `\n      legacy: ${JSON.stringify(legacyLines.map(stripAnsi))}` +
        `\n      native: ${JSON.stringify(nativeLines.map(stripAnsi))}` +
        `\n      (plain-text equal: ${samePlain})`);
    }
  }

  check(mismatches === 0, "all widths byte-identical");

  rmSync(work, { recursive: true, force: true });
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main();
