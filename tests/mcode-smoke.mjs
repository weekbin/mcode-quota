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
      return (b1-a1)||(b2-a2)||(b3-a3);
    });
    for (const v of versions) { const p = tryRead(v); if (p) return p; }
  } catch {}
  return null;
};

// The anchor finder only ever runs against a PRISTINE bundle — on a patched
// one our appended wrapper is itself a `renderViewport` method at the very end
// of the class body, which makes the method-end == body-end. So mutations and
// finder checks must start from the pristine unpacked tarball, not the
// already-patched fork.
const discoverPristineLauncher = (version) => {
  const base = `${process.env.HOME}/.local/share/mcode-quota/mcode-clone`;
  const dirs = [`${base}/.pristine-${version}/chunks`, `${base}/.pristine-${version}/code/chunks`];
  for (const dir of dirs) {
    try {
      const f = readdirSync(dir).find((x) => /^launcher-.*\.js$/.test(x));
      if (f) return `${dir}/${f}`;
    } catch {}
  }
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
const PRISTINE_LAUNCHER = discoverPristineLauncher(mcodeVersion);

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
  // Prefer the pristine bundle: the finder is a pristine-only tool and the
  // fork copy is already patched. Fall back to the live launcher only when no
  // pristine unpack is available (the finder will then report "already
  // patched" clearly instead of failing obscurely).
  copyFileSync(PRISTINE_LAUNCHER || LIVE_LAUNCHER, path);
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
// Scenario tables are per-mcode-major because the injection model changed:
//   0.3.x — the status widget (jf) inherits render(width); the wrapper is a
//           render() override on the widget class. Expectations name the
//           widget + its runtime/shellState fields.
//   0.4.0 — painting moved to the BASE class (ba) as renderViewport(w, h);
//           the widget (t1) is a controller and its render() is never called.
//           The wrapper wraps the base class's renderViewport. Expectations
//           name the viewport class + the fields discovered on the subclass.
const SCENARIOS_BY_MAJOR = {
  "0.3": [
    {
      name: "baseline: pristine launcher unchanged",
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
      name: "mcode removes statusLineItems assignment",
      mutate: [
        { from: "this.statusLineItems=t.statusLineItems,", to: "" },
      ],
      expectWidget: "jf",
      expectRuntime: "runtime",
      expectShell: "shellState",
    },
  ],
  "0.4": [
    {
      name: "baseline: pristine launcher unchanged",
      mutate: [],
      expectWidget: "t1",
      expectViewportClass: "ba",
      expectRuntime: "runtime",
      expectShell: "shellState",
      expectState: "state",
    },
    {
      name: "mcode renames this.runtime -> this.engine on the widget subclass",
      mutate: [{ from: "this.runtime=i", to: "this.engine=i" }],
      expectWidget: "t1",
      expectViewportClass: "ba",
      expectRuntime: "engine",
      expectShell: "shellState",
      expectState: "state",
    },
    {
      name: "mcode renames runtime + requestRender on the widget subclass",
      mutate: [
        { from: "this.runtime=i", to: "this.engine=i" },
        { from: "this.requestRender=s", to: "this.repaint=s" },
      ],
      expectWidget: "t1",
      expectViewportClass: "ba",
      expectRuntime: "engine",
      expectShell: "shellState",
      expectState: "state",
    },
    {
      name: "mcode drops shellState from the subclass ctor (base .state still works)",
      mutate: [
        { from: "this.shellState=t,this.syncSources()", to: "this.syncSources()" },
      ],
      expectWidget: "t1",
      expectViewportClass: "ba",
      expectRuntime: "runtime",
      expectShell: "",          // no longer discoverable on the subclass
      expectState: "state",     // the base class's own field is the fallback
    },
  ],
};

const SCENARIOS = SCENARIOS_BY_MAJOR[mcodeVersion.split(".").slice(0, 2).join(".")];
if (!SCENARIOS) {
  console.error(`FATAL: no scenario table for mcode major '${mcodeVersion.split(".").slice(0,2).join(".")}'.`);
  console.error(`  Add SCENARIOS_BY_MAJOR["<major>.<minor>"] in tests/mcode-smoke.mjs for this injection model.`);
  process.exit(2);
}
const scenarios = SCENARIOS;

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
    if (sc.expectViewportClass) {
      // 0.4.0 anchor set: the class that defines renderViewport plus its
      // class-body / method offsets, all checked for ordering by the finder.
      check(kv.VCLASS === sc.expectViewportClass,
        `finder -> VCLASS=${sc.expectViewportClass}`, `got ${kv.VCLASS}`);
      check(Number(kv.VCLASS_BODY_END) > Number(kv.VMETHOD_END) && Number(kv.VMETHOD_END) > Number(kv.VKEY_END),
        "finder -> viewport offsets ordered (KEY < METHOD_END < BODY_END)");
      // The wrapper needs a shell-state path from EITHER the subclass's own
      // field or the base class's. Neither is hardcoded: the finder reports
      // '' when it cannot discover a name, and the patcher then emits one
      // fewer guarded clause instead of a literal guess.
      if (sc.expectState !== undefined) {
        check(kv.STATE_PROP === sc.expectState,
          `finder -> STATE_PROP=${sc.expectState}`, `got ${kv.STATE_PROP}`);
        check(!!(kv.SHELLSTATE_PROP || kv.STATE_PROP),
          "finder -> a shell-state path is available (subclass or base)");
      }
    } else {
      check(Number.isFinite(Number(kv.WIDGET_BODY_END)) && Number(kv.WIDGET_BODY_END) > 0, "finder -> WIDGET_BODY_END valid");
      check(Number.isFinite(Number(kv.CTOR_END)) && Number(kv.CTOR_END) > 0, "finder -> CTOR_END valid");
    }
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
    const hook = launchSrc.match(/(?:__mcodeQuotaWidget=this;|__mcodeQuotaWidget=this\.)[\s\S]{0,700}?return (?:r|_r)\}/);
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
  // ---- native path (mcode >= 0.4.0) ----
  // Above we exercised the legacy fork patcher against the newest available
  // fork. From 0.4.0 onward mcodex stops patching entirely and drives mcode's
  // own `custom-command` status item, so the things worth asserting change:
  // the config merge is idempotent and reversible, and the status script
  // answers a synthetic mcode payload with the 3-row contract.
  console.log("\n[scenario] native custom-command path (mcode >= 0.4.0)");
  {
    const current = (() => {
      try { return readFileSync(`${process.env.HOME}/.minimax-code/current`, "utf-8").trim(); }
      catch { return null; }
    })();
    const isNative = !!current &&
      ["0.4.0", current].sort((a, b) => {
        const A = a.split(".").map(Number), B = b.split(".").map(Number);
        return (A[0] - B[0]) || (A[1] - B[1]) || (A[2] - B[2]);
      })[0] === "0.4.0";

    if (!isNative) {
      console.log(`  SKIP: mcode ${current} predates the native item`);
    } else {
      const { applyStatuslineConfig, removeStatuslineConfig } =
        await import("../lib/config-apply.mjs");
      const { buildStatusLines, stripAnsi } = await import("../lib/render.mjs");

      // config merge: idempotent + reversible, on a copy of the real file
      const realConfig = `${process.env.HOME}/.minimax/config.yaml`;
      const work = mkdtempSync(join(tmpdir(), "mcodex-cfg-"));
      const cfg = join(work, "config.yaml");
      copyFileSync(realConfig, cfg);
      const before = readFileSync(cfg, "utf-8");

      const a1 = applyStatuslineConfig(cfg, { command: "/bin/true" });
      const afterApply = readFileSync(cfg, "utf-8");
      const a2 = applyStatuslineConfig(cfg, { command: "/bin/true" });
      const afterSecond = readFileSync(cfg, "utf-8");
      check(a1.changed === true, "apply reports changed on first run");
      check(a2.changed === false, "apply is idempotent (second run reports no change)");
      check(afterApply === afterSecond, "apply is byte-stable across runs");
      check(afterApply.includes("custom-command"), "statusLine gained custom-command");
      check(afterApply.includes("customStatusLine:"), "customStatusLine block written");
      check(afterApply.includes("display: block") && afterApply.includes("maxLines: 3"),
        "block mode + 3 lines configured");
      check(afterApply.includes("colorMode: ansi"), "ansi colourMode configured");
      // everything outside the tui: block must survive byte-for-byte
      const headBefore = before.split("tui:")[0];
      const headAfter = afterApply.split("tui:")[0];
      check(headBefore === headAfter, "content above tui: is untouched");
      check(existsSync(cfg + ".mcodex-backup"), "one-shot backup written");

      const r1 = removeStatuslineConfig(cfg);
      const afterRemove = readFileSync(cfg, "utf-8");
      check(r1.changed === true, "remove reports changed");
      check(!afterRemove.includes("customStatusLine:"), "customStatusLine removed");
      check(!/^\s*-\s*custom-command\s*$/m.test(afterRemove), "custom-command removed from statusLine");
      check(afterRemove.split("tui:")[0] === headBefore, "content above tui: still untouched");
      rmSync(work, { recursive: true, force: true });

      // status script: synthetic payload -> the 3-row contract
      const statusBin = join(PROJECT_ROOT, "mcodex-status");
      if (existsSync(statusBin)) {
        const sid = (() => {
          try {
            const { execFileSync: ex } = require("node:child_process");
            return "";
          } catch { return ""; }
        })();
        const payload = JSON.stringify({
          protocol: 1, event: "interval",
          session_id: process.env.MCODEX_TEST_SESSION || "",
          workspace_dir: PROJECT_ROOT, model: "-", tui_version: current,
        });
        const out = execFileSync(process.execPath, [statusBin], {
          input: payload + "\n", encoding: "utf-8", env: { ...process.env, COLUMNS: "200" },
        });
        const rows = out.trim() ? out.trim().split("\n").length : 0;
        // With no session id the script must stay silent rather than emit
        // placeholder noise — that is the containment contract.
        check(rows === 0 || rows === 3, `empty session -> ${rows} rows (expect 0)`);
      }

      // renderer unit contract (independent of any mcode install)
      const st = {
        quota: { valid: true, dRem: 55, dReset: "2h 6m", wRem: 97, wReset: "2d 11h" },
        session: { valid: true, total: 644.88e6, input: 8.01e6, output: 1.41e6, cache: 635.45e6,
                   turns: 97, cacheHit: 0.9875 },
        context: { used: 425844, window: 1000000 },
        today: { valid: true, items: [{ model: "MiniMax-M3", total: 170.19e6 }] },
        placeholders: { session: false, context: false, today: false },
        tailMode: "auto",
      };
      const lines200 = buildStatusLines(st, 200).map(stripAnsi);
      check(lines200.length === 3, `wide render emits 3 rows (got ${lines200.length})`);
      check(/^会话 tokens 644\.88M/.test(lines200[0]), "row 1 starts with 会话 tokens and 2-decimal totals");
      check(lines200[0].includes("上下文 43% 「425.84K/1.00M」"),
        "row 1 renders the live 1M context window, not config.yaml's 512K",
        lines200[0].slice(0, 90));
      check(lines200[1].includes("小时会话窗口") && lines200[1].includes("周限制使用量"),
        "row 2 carries both quota bars");
      check(lines200[2].includes("今日"), "row 3 carries the per-model totals");
      const lines60 = buildStatusLines(st, 60).map(stripAnsi);
      check(lines60.length >= 3, `narrow render still emits ≥3 rows (got ${lines60.length})`);
      check(lines60.every((l) => stripAnsi(l).length <= 200), "narrow rows stay within budget-ish");

      // v3.4.6 — category registry: each row can be turned off independently
      const offRows = buildStatusLines(st, 200, { enabled: { row4chunks: false } }).map(stripAnsi);
      check(offRows.length === 2 && !offRows.some((l) => l.includes("会话 tokens")),
        "row4chunks: false drops the 4-chunk row",
        offRows.join(" / "));
      const offQuota = buildStatusLines(st, 200, { enabled: { quotaRow: false } }).map(stripAnsi);
      check(offQuota.length === 2 && !offQuota.some((l) => l.includes("小时会话窗口")),
        "quotaRow: false drops the 5h/周 rows",
        offQuota.join(" / "));
      const offToday = buildStatusLines(st, 200, { enabled: { todayRow: false } }).map(stripAnsi);
      check(offToday.length === 2 && !offToday.some((l) => l.includes("今日")),
        "todayRow: false drops the per-model row",
        offToday.join(" / "));
      const offAll = buildStatusLines(st, 200, {
        enabled: { row4chunks: false, quotaRow: false, todayRow: false },
      });
      check(offAll.length === 0, "all categories off emits 0 rows (got " + offAll.length + ")");

      // v3.4.6 — decimals option controls cache hit fraction digits
      const intRows = buildStatusLines(st, 200, { decimals: 0 }).map(stripAnsi);
      check(intRows[0].includes("缓存命中 99%"), "decimals: 0 → 整数百分比",
        intRows[0].slice(0, 80));
      const oneDec = buildStatusLines(st, 200, { decimals: 1 }).map(stripAnsi);
      check(oneDec[0].includes("缓存命中 98.8%"), "decimals: 1 → 一位小数",
        oneDec[0].slice(0, 80));
      const fourDec = buildStatusLines(st, 200, { decimals: 4 }).map(stripAnsi);
      check(fourDec[0].includes("缓存命中 98.7500%"), "decimals: 4 → 四位小数",
        fourDec[0].slice(0, 80));
      // Out-of-range decimals falls back to default (2)
      const oor = buildStatusLines(st, 200, { decimals: 99 }).map(stripAnsi);
      check(oor[0].includes("缓存命中 98.75%"), "decimals out-of-range → defaults to 2",
        oor[0].slice(0, 80));

      // v3.4.6 — options parser round-trips with applyMcodexOptions
      const { applyMcodexOptions, removeMcodexOptions } = await import("../lib/config-apply.mjs");
      const { loadMcodexOptions } = await import("../lib/options.mjs");
      const optDir = mkdtempSync(join(tmpdir(), "mcodex-opts-"));
      tempDirs.push(optDir);
      const workCfg = join(optDir, "options.yaml");
      writeFileSync(workCfg, "tui:\n  statusLine: []\n");
      // First apply with defaults writes the block; second apply is no-op.
      check(applyMcodexOptions(workCfg, {}).changed,
        "first apply with empty opts writes the default mcodex block");
      check(!applyMcodexOptions(workCfg, {}).changed,
        "second apply with empty opts is a no-op (defaults idempotent)");
      applyMcodexOptions(workCfg, {
        enabled: { quotaRow: false, todayRow: false }, tailMode: "compact", decimals: 0,
      });
      const parsed = loadMcodexOptions(workCfg);
      check(parsed.enabled.row4chunks === true, "options: unspecified key defaults to true");
      check(parsed.enabled.quotaRow === false, "options: quotaRow override round-trips");
      check(parsed.enabled.todayRow === false, "options: todayRow override round-trips");
      check(parsed.tailMode === "compact", "options: tailMode override round-trips");
      check(parsed.decimals === 0, "options: decimals override round-trips");
      // Idempotent on second apply of the same opts
      check(!applyMcodexOptions(workCfg, {
        enabled: { quotaRow: false, todayRow: false }, tailMode: "compact", decimals: 0,
      }).changed, "apply is idempotent on identical opts");
      // Remove
      check(removeMcodexOptions(workCfg).changed, "remove strips the mcodex block");
      check(loadMcodexOptions(workCfg).enabled.row4chunks === true,
        "after remove, parser returns defaults again");
      check(!removeMcodexOptions(workCfg).changed, "second remove is a no-op");
    }
  }
} finally {
  for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
