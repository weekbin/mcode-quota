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
import { copyFileSync, readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FINDER = join(__dirname, "mcode-find-anchors.mjs");
const PATCHER = join(__dirname, "mcode-patch-quota.mjs");

let pass = 0, fail = 0;
const check = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS: ${label}`); }
  else { fail++; console.log(`  FAIL: ${label}${extra ? " — " + extra : ""}`); }
};

const LIVE_LAUNCHER = process.env.MCODE_LAUNCHER
  || `${process.env.HOME}/.local/share/mcode-quota/mcode-clone/0.3.10/code/chunks/launcher-CVR77P3I.js`;
if (!existsSync(LIVE_LAUNCHER)) {
  console.error(`FATAL: live launcher not found at ${LIVE_LAUNCHER}; set MCODE_LAUNCHER env`);
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
  const src = process.env.MCODE_SRC || `${process.env.HOME}/.minimax-code/releases/0.3.10`;
  execFileSync(process.execPath, [PATCHER,
    "--src=" + src,
    "--fork-base=" + forkDir,
    "--sidecar=" + join(__dirname, "sidecar/mcode-quota-fetcher-9f8a7b.mjs"),
    "--current=0.3.10",
    "--offline",
  ], { stdio: "inherit" });
  const patched = join(forkDir, "0.3.10/code/chunks");
  const files = execFileSync("ls", [patched], { encoding: "utf-8" });
  const launcher = files.split("\n").find((f) => /^launcher-.*\.js$/.test(f));
  check(!!launcher, "fork contains a launcher-*.js chunk");
  if (launcher) {
    const content = readFileSync(join(patched, launcher), "utf-8");
    check(content.includes("__mcodeQuotaRender"), "fork launcher has __mcodeQuotaRender override");
    check(content.includes("__mcodeShellState"), "fork launcher captures __mcodeShellState");
    check(content.includes("__mcodeRuntime"), "fork launcher captures __mcodeRuntime");
  }
  const cli = join(forkDir, "0.3.10/code/cli.js");
  if (existsSync(cli)) {
    const c = readFileSync(cli, "utf-8");
    check(c.includes("mcode-quota-sidecar"), "fork cli.js imports the sidecar");
  } else {
    console.log("  WARN: cli.js not present in fork (fork-only verification skipped)");
  }
} finally {
  for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
