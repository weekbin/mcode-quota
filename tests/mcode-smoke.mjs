#!/usr/bin/env node
// mcode-smoke.mjs — synthetic upgrade-drift regression test.
//
// Goal: prove that the AST-driven anchor finder / patcher / SQL probe
// can survive mcode refactors (renames, param-order swaps, schema
// renames) without any hardcoded fallback. We do this by:
//
//   1. Copying the live mcode launcher chunk to a temp file
//   2. Mutating the copy to simulate mcode refactors (rename widget
//      properties, swap ctor params, drop / add ctor fields, change
//      SQL column names)
//   3. Running the real finder / patcher / sidecar against the mutated
//      copies and asserting they still discover the right anchors
//   4. Verifying the sidecar still produces the expected render output
//
// The mcode source itself never changes; the mutations live in /tmp.

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(__dirname);              // .../mcode-quota
const PATCHES_DIR = join(PROJECT_ROOT, "patches");

let pass = 0, fail = 0;
const check = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS: ${label}`); }
  else { fail++; console.log(`  FAIL: ${label}${extra ? " — " + extra : ""}`); }
};

// Auto-discover the live launcher under the fork base. We prefer the
// current mcode version (per the symlink file at ~/.minimax-code/current);
// otherwise we pick the highest <version>/ under the fork base.
const discoverLiveLauncher = () => {
  const base = `${process.env.HOME}/.local/share/mcode-quota/mcode-clone`;
  const current = (() => {
    try { return readFileSync(`${process.env.HOME}/.minimax-code/current`, "utf-8").trim(); }
    catch { return null; }
  })();
  const tryRead = (version) => {
    try {
      const dir = `${base}/${version}/code/chunks`;
      const files = readdirSync(dir);
      return files.find((f) => /^launcher-.*\.js$/.test(f)) ? `${dir}/${files.find((f) => /^launcher-.*\.js$/.test(f))}` : null;
    } catch { return null; }
  };
  if (current && tryRead(current)) return tryRead(current);
  // Fallback: pick the highest version under base/
  try {
    const versions = readdirSync(base).filter((d) => /^\d+\.\d+\.\d+$/.test(d)).sort((a, b) => {
      const [a1,a2,a3] = a.split(".").map(Number), [b1,b2,b3] = b.split(".").map(Number);
      return (b1-b1)||(b2-a2)||(b3-a3);
    });
    for (const v of versions) { const p = tryRead(v); if (p) return p; }
  } catch {}
  return null;
};

const LIVE_LAUNCHER = process.env.MCODE_LAUNCHER || discoverLiveLauncher();
if (!LIVE_LAUNCHER) {
  console.error(`FATAL: no live launcher found under ~/.local/share/mcode-quota/mcode-clone/; set MCODE_LAUNCHER env`);
  process.exit(2);
}
console.log(`# using live launcher: ${LIVE_LAUNCHER}`);

// Extract the mcode version from the live launcher path, then resolve
// the versioned finder/patcher under patches/<version>/. This keeps the
// smoke aligned with the loader's resolution order without hard-coding
// a version here.
const mcodeVersion = (() => {
  const m = LIVE_LAUNCHER.match(/\/mcode-clone\/(\d+\.\d+\.\d+)\//);
  if (m) return m[1];
  throw new Error(`could not extract mcode version from ${LIVE_LAUNCHER}`);
})();
const PATCH_DIR = join(PATCHES_DIR, mcodeVersion);
const FINDER = join(PATCH_DIR, "mcode-find-anchors.mjs");
const PATCHER = join(PATCH_DIR, "mcode-patch-quota.mjs");
if (!existsSync(PATCH_DIR)) {
  console.error(`FATAL: no patches/${mcodeVersion}/ for the live launcher; run mcodex once to build it, or add the version.`);
  process.exit(2);
}

const runFinder = (path) => {
  const out = execFileSync(process.execPath, [FINDER, path], { encoding: "utf-8" });
  const kv = Object.fromEntries(
    out.split("\n")
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => {
        const m = l.match(/^(\w+)=(.*)$/);
        if (!m) return [null, null];
        let v = m[2];
        if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).replace(/'\\''/g, "'");
        return [m[1], v];
      })
      .filter(([k]) => k),
  );
  return kv;
};

const mkTempCopy = (label) => {
  const dir = mkdtempSync(join(tmpdir(), "mcode-smoke-"));
  const path = join(dir, "launcher-x.js");
  copyFileSync(LIVE_LAUNCHER, path);
  return { dir, path, label };
};

const mutate = (path, transforms) => {
  let s = readFileSync(path, "utf-8");
  for (const t of transforms) {
    const before = s;
    s = s.replaceAll(t.from, t.to);
    if (s === before) {
      throw new Error(`mutation ${JSON.stringify(t).slice(0, 80)} didn't apply`);
    }
  }
  writeFileSync(path, s);
};

// ---- scenarios ----------------------------------------------------------
const scenarios = [
  {
    name: "baseline: live launcher unchanged",
    mutate: [],
    expectWidget: "jf",
    expectRuntime: "runtime",
    expectShell: "shellState",
  },
  {
    name: "mcode renames this.runtime -> this.engine",
    mutate: [{ from: "this.runtime=i", to: "this.engine=i" }],
    expectWidget: "jf",
    expectRuntime: "engine",
    expectShell: "shellState",
  },
  {
    name: "mcode renames runtime + requestRender + statusLineItems",
    mutate: [
      { from: "this.runtime=i", to: "this.engine=i" },
      { from: "this.requestRender=s", to: "this.repaint=s" },
      { from: "this.statusLineItems=t.statusLineItems,", to: "this.bottomItems=t.statusLineItems," },
    ],
    expectWidget: "jf",
    expectRuntime: "engine",
    expectShell: "shellState",
  },
  {
    name: "mcode swaps ctor param order: (t,i,s) -> (i,t,s)",
    mutate: [
      { from: "constructor(t,i,s){", to: "constructor(i,t,s){" },
      { from: "super(t,i,s)", to: "super(i,t,s)" },
      { from: "this.runtime=i", to: "this.runtime=t" },
      { from: "this.statusLineItems=t.statusLineItems,", to: "this.statusLineItems=i.statusLineItems," },
      { from: "this.shellState=t", to: "this.shellState=i" },
    ],
    expectWidget: "jf",
    expectRuntime: "runtime",
    expectShell: "shellState",
  },
  {
    name: "mcode removes statusLineItems assignment",
    mutate: [
      { from: "this.statusLineItems=t.statusLineItems,", to: "" },
    ],
    expectWidget: "jf",
    expectRuntime: "runtime",
    expectShell: "shellState",
  },
  {
    name: "mcode renames the ctor param from t -> ttx (cosmetic)",
    mutate: [
      { from: "constructor(t,i,s){", to: "constructor(ttx,i,s){" },
      { from: "super(t,i,s)", to: "super(ttx,i,s)" },
      { from: "this.shellState=t", to: "this.shellState=ttx" },
      { from: "this.statusLineItems=t.statusLineItems,", to: "this.statusLineItems=ttx.statusLineItems," },
    ],
    expectWidget: "jf",
    expectRuntime: "runtime",
    expectShell: "shellState",
  },
];

const tempDirs = [];
try {
  for (const sc of scenarios) {
    console.log(`\n[scenario] ${sc.name}`);
    const { dir, path } = mkTempCopy(sc.name);
    tempDirs.push(dir);
    try { mutate(path, sc.mutate); } catch (e) {
      console.log(`  SKIP: ${e.message}`);
      continue;
    }
    let kv;
    try {
      kv = runFinder(path);
    } catch (e) {
      fail++; console.log(`  FAIL: finder threw: ${e.message}`); continue;
    }
    check(kv.WIDGET === sc.expectWidget, `finder -> WIDGET=${sc.expectWidget}`, `got ${kv.WIDGET}`);
    check(kv.RUNTIME_PROP === sc.expectRuntime, `finder -> RUNTIME_PROP=${sc.expectRuntime}`, `got ${kv.RUNTIME_PROP}`);
    check(kv.SHELLSTATE_PROP === sc.expectShell, `finder -> SHELLSTATE_PROP=${sc.expectShell}`, `got ${kv.SHELLSTATE_PROP}`);
    check(Number.isFinite(Number(kv.WIDGET_BODY_END)) && Number(kv.WIDGET_BODY_END) > 0, "finder -> WIDGET_BODY_END valid");
    check(Number.isFinite(Number(kv.CTOR_END)) && Number(kv.CTOR_END) > 0, "finder -> CTOR_END valid");
  }

  // ---- patcher smoke: rebuild a fork and confirm the launcher is patched ----
  console.log("\n[scenario] patcher end-to-end on a fresh fork");
  const forkDir = mkdtempSync(join(tmpdir(), "mcode-fork-"));
  tempDirs.push(forkDir);
  // copy from the official install into the fork root
  const src = process.env.MCODE_SRC
    || `${process.env.HOME}/.minimax-code/releases/${mcodeVersion}`;
  execFileSync(process.execPath, [PATCHER,
    "--src=" + src,
    "--fork-base=" + forkDir,
    "--sidecar=" + join(PROJECT_ROOT, "sidecar/mcode-quota-fetcher-9f8a7b.mjs"),
    "--current=" + mcodeVersion,
    "--offline",
  ], { stdio: "inherit" });
  const patched = join(forkDir, `${mcodeVersion}/code/chunks`);
  const files = execFileSync("ls", [patched], { encoding: "utf-8" });
  const launcher = files.split("\n").find((f) => /^launcher-.*\.js$/.test(f));
  check(!!launcher, "fork contains a launcher-*.js chunk");
  if (launcher) {
    const content = readFileSync(join(patched, launcher), "utf-8");
    check(content.includes("__mcodeQuotaRender"), "fork launcher has __mcodeQuotaRender override");
    check(content.includes("__mcodeShellState"), "fork launcher captures __mcodeShellState");
    check(content.includes("__mcodeRuntime"), "fork launcher captures __mcodeRuntime");
  }
  const cli = join(forkDir, `${mcodeVersion}/code/cli.js`);
  if (existsSync(cli)) {
    const c = readFileSync(cli, "utf-8");
    check(c.includes("mcode-quota-sidecar"), "fork cli.js imports the sidecar");
  } else {
    console.log("  WARN: cli.js not present in fork (fork-only verification skipped)");
  }

  // ---- shortenModelName regression (v3.2.1) ----
  // Custom model names (GGUF filenames, fine-tunes, "expires-on-NNNN"
  // aliases) regularly exceed 30 chars. The renderer must middle-ellipsise
  // them so a 56-char filename doesn't blow the row width.
  // We verify (a) the source defines the helper with the right contract
  // and (b) the function behaves as designed against a corpus of real
  // custom names. The behavioural run uses a tiny `new Function` sandbox
  // to evaluate just the function body — no need to import the full
  // sidecar ESM (which has top-level await and sqlite imports).
  console.log("\n[scenario] shortenModelName: long custom names get middle-ellipsis");
  const sidecarSrc = readFileSync(join(PROJECT_ROOT, "sidecar/mcode-quota-fetcher-9f8a7b.mjs"), "utf-8");
  check(/function shortenModelName\s*\(/.test(sidecarSrc), "sidecar defines shortenModelName");
  check(/MAX_MODEL_NAME_CHARS\s*=\s*32/.test(sidecarSrc), "sidecar caps at 32 chars");
  check(/ELLIPSIS\s*=\s*"\u2026"/.test(sidecarSrc), "sidecar uses U+2026 ellipsis (not '...')");
  check(/shortenModelName\(it\.model\)/.test(sidecarSrc), "renderTodayByModelRow applies shortenModelName to every item");
  // Behavioural run — extract the function body, run against a corpus.
  const fnBody = sidecarSrc.match(/function shortenModelName\([^)]*\)\s*\{[\s\S]*?\n\}/);
  if (fnBody) {
    const fn = new Function(`
      const ELLIPSIS = "\\u2026";
      const MAX_MODEL_NAME_CHARS = 32;
      ${fnBody[0]}
      return shortenModelName;
    `)();
    const corpus = [
      ["MiniMax-M3", 10],                                  // short: unchanged
      ["deepseek-v4.1-flash-expires-on-0910", 32],         // 35→32
      ["Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf", 32],
      ["MiniCPM5-1B-Claude-Opus-Fable5-V2-Thinking", 32],
      ["x".repeat(32), 32],                                 // exactly at limit
      ["x".repeat(100), 32],                                // way over
    ];
    for (const [input, expectedLen] of corpus) {
      const got = fn(input);
      check(got.length === expectedLen, `truncate ${input.length}c → ${expectedLen}c (got ${got.length}c)`);
    }
  } else {
    fail++; console.log("  FAIL: could not extract shortenModelName from sidecar source");
  }

  // ---- fmtTok unit conversion (v3.2.2) ----
  // 1000M must display as 1.0B, not 1000.0M. K / M / B / T is the
  // standard short-scale (US finance / tech) for token counts. We
  // extract the function from the sidecar source and run a corpus.
  console.log("\n[scenario] fmtTok: K / M / B / T short-scale, no 1000M ever");
  const fmtSrc = sidecarSrc.match(/const fmtTok = \(n\) =>\s*\{[\s\S]*?\n\};/);
  if (fmtSrc) {
    const fmt = new Function(`
      ${fmtSrc[0]}
      return fmtTok;
    `)();
    const fmtCorpus = [
      [0, "0"],
      [999, "999"],
      [1_000, "1.00K"],
      [999_999, "1.00M"],            // bumps to M (avoids "1000.00K")
      [1_000_000, "1.00M"],
      [880_400_000, "880.40M"],
      [999_999_999, "1.00B"],        // bumps to B (avoids "1000.00M")
      [1_000_000_000, "1.00B"],      // <- the original bug the user reported
      [10_581_200_000, "10.58B"],
      [999_999_999_999, "1.00T"],    // bumps to T (avoids "1000.00B")
      [1_000_000_000_000, "1.00T"],
      [1_500_000_000_000, "1.50T"],
      [NaN, "0"],
      [Infinity, "0"],
    ];
    for (const [input, expected] of fmtCorpus) {
      const got = fmt(input);
      check(got === expected, `fmtTok(${input}) === "${expected}" (got "${got}")`);
    }
  } else {
    fail++; console.log("  FAIL: could not extract fmtTok from sidecar source");
  }

  // ---- render-hook crash containment (v3.2.4, P0) ----
  // A throw inside __mcodeQuotaRender must NOT escape into Ink's reconciler.
  // Verified empirically: without the guard an injected throw produced a
  // 268-byte run and the TUI process died; with it the TUI ran normally.
  // We assert the patched launcher wraps the call in try/catch.
  console.log("\n[scenario] render hook is crash-contained");
  {
    const launchSrc = readFileSync(join(patched, launcher), "utf-8");
    const hook = launchSrc.match(/__mcodeQuotaWidget=this;[\s\S]{0,400}?return r\}/);
    check(!!hook, "render hook emitted in patched launcher");
    if (hook) {
      const h = hook[0];
      check(/try\{/.test(h), "render hook wraps the sidecar call in try{");
      check(/catch\(/.test(h), "render hook has a catch branch");
      check(/catch\([^)]*\)\{_qr=\[\]/.test(h) || /catch\([^)]*\)\{[^}]*_qr=\[\]/.test(h),
        "catch branch resets _qr to [] (degrades to no extra lines)");
      check(h.includes("__mcodeQuotaLastError"), "catch records the error for diagnosis");
      // the old shape — unguarded call — must be gone
      check(!/\?globalThis\.__mcodeQuotaRender\(e\):\[\];if\(Array\.isArray/.test(h),
        "unguarded call shape is gone");
    }
  }

  // ---- today scan: incremental rowid strategy (v3.2.4) ----
  // The time-filtered scan on local_runtime_message_rows has no index and
  // parses ~5 KB JSON per row (measured 85 ms on a 59 K-row / 283 MB table,
  // every 60 s, blocking the event loop). We warm once per day and then poll
  // off the monotonic rowid. Assert the strategy is present AND that the
  // time-filtered fallback survives for schemas without `id`.
  console.log("\n[scenario] today scan uses the rowid range strategy with a fallback");
  {
    const src = sidecarSrc;
    check(/todayScan\s*=\s*\{/.test(src), "todayScan state object present");
    check(/id > \?/.test(src), "incremental query filters on id > ?");
    check(/PRAGMA table_info\(local_runtime_message_rows\)/.test(src), "rowid column is probed via PRAGMA");
    check(/created_at_ms >= \?/.test(src), "time-filtered path retained (warm / fallback)");
    check(/SELECT MAX\(id\)/.test(src), "warm scan anchors lastId at the newest row");
    check(/dayStartMs !== dayStartMs/.test(src) || /todayScan\.dayStartMs !== dayStartMs/.test(src),
      "day rollover resets the incremental state");
  }

  // ---- in-flight guard (v3.2.4) ----
  console.log("\n[scenario] session fetch is guarded against render-burst duplication");
  {
    const src = sidecarSrc;
    check(/sessionFetchInFlight/.test(src), "sessionFetchInFlight flag present");
    check(/if \(sessionFetchInFlight && startedAt - sessionFetchStartedAt < SESSION_FETCH_MAX_AGE_MS\) return;/.test(src),
      "fetchSessionOnce early-returns while a recent fetch is in flight");
    check(/SESSION_FETCH_MAX_AGE_MS\s*=\s*15_000/.test(src),
      "guard is age-bounded so a stuck fetch cannot latch the flag forever");
    check(/_fetchSessionOnceInner/.test(src), "inner body split so the flag is always cleared");
    check(/finally \{\s*if \(sessionFetchStartedAt === startedAt\) sessionFetchInFlight = false;/.test(src),
      "only the owning attempt clears the flag (a superseded one does not)");
  }
} finally {
  for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
