// lib/options.mjs — load `tui.mcodex` block from ~/.minimax/config.yaml.
//
// Schema (under `tui:`):
//   tui:
//     mcodex:
//       enabled:
//         row4chunks: true    # 会话 tokens │ 上下文 │ 缓存命中 │ 轮数
//         quotaRow:   true    # 小时会话窗口 │ 周限制使用量
//         todayRow:   true    # 今日 per-model
//       tailMode:   auto      # auto | full | compact
//       decimals:   2         # 缓存命中 fraction digits (0..4)
//
// Design:
//   - Pure file reader. No side effects, no logging. mcodex-status calls it
//     every interval tick (10s default); a fresh install where the block is
//     missing must NOT error — it gets the defaults silently.
//   - Hand-rolled line scanner matching the style of config-apply.mjs so we
//     do not pull in a YAML parser. The block we read is tiny and well-formed
//     by construction.
//   - Unknown keys inside the mcodex block are ignored. Unknown / malformed
//     values fall back to defaults. Comments (`#`) and blank lines are skipped.

import { readFileSync, existsSync } from "node:fs";

import { DEFAULT_ENABLED } from "./render.mjs";

const DEFAULT_TAIL_MODE = "auto";
const DEFAULT_DECIMALS = 2;
const VALID_TAIL_MODES = new Set(["auto", "full", "compact"]);

const defaultPath = () =>
  process.env.MCODE_CONFIG_YAML ||
  (process.env.HOME ? process.env.HOME + "/.minimax/config.yaml" : "");

/**
 * @param {string} [configPath]
 * @returns {{ enabled: object, tailMode: string, decimals: number, source: string }}
 */
export function loadMcodexOptions(configPath) {
  const path = configPath || defaultPath();
  const fallback = defaultsSnapshot(path);
  if (!path || !existsSync(path)) return fallback;
  let text;
  try { text = readFileSync(path, "utf-8"); } catch { return fallback; }
  return parseFromText(text, path, fallback);
}

export function defaultsSnapshot(path) {
  return {
    enabled: { ...DEFAULT_ENABLED },
    tailMode: DEFAULT_TAIL_MODE,
    decimals: DEFAULT_DECIMALS,
    source: path || "(defaults)",
  };
}

// ---------------------------------------------------------------------------
// Internal: small hand-rolled YAML extractor for the tui.mcodex sub-tree.
// ---------------------------------------------------------------------------

function parseFromText(text, path, fallback) {
  const lines = text.split("\n");
  const tuiIdx = lines.findIndex((l) => /^tui\s*:\s*(#.*)?$/.test(l));
  if (tuiIdx < 0) return { ...fallback, source: path };

  const mcodexIdx = lines.findIndex((l, i) =>
    i > tuiIdx
    && /^\s{2}mcodex\s*:\s*(#.*)?$/.test(l)
    && !l.startsWith("    "));
  if (mcodexIdx < 0) return { ...fallback, source: path };

  // End of the `mcodex:` block = next line whose first non-space char is at
  // indent 0 or 2. Blank / comment lines don't end it.
  let end = lines.length;
  for (let i = mcodexIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const ind = lines[i].match(/^ */)[0].length;
    if (ind <= 2) { end = i; break; }
  }

  const block = lines.slice(mcodexIdx + 1, end);
  const out = { ...fallback, source: path };

  // enabled: — map of <key>: <bool>
  const enabledIdx = block.findIndex((l) => /^\s{4}enabled\s*:\s*(#.*)?$/.test(l));
  if (enabledIdx >= 0) {
    let endEnabled = block.length;
    for (let i = enabledIdx + 1; i < block.length; i++) {
      const trimmed = block[i].trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const ind = block[i].match(/^ */)[0].length;
      if (ind <= 4) { endEnabled = i; break; }
    }
    for (let i = enabledIdx + 1; i < endEnabled; i++) {
      const m = block[i].match(/^\s{6}(\w+)\s*:\s*(.+?)\s*(?:#.*)?$/);
      if (!m) continue;
      const key = m[1];
      if (!(key in out.enabled)) continue;          // ignore unknown categories
      out.enabled[key] = parseBool(m[2]);
    }
  }

  // tailMode: <auto|full|compact>
  for (const l of block) {
    const m = l.match(/^\s{4}tailMode\s*:\s*(\S+)/);
    if (!m) continue;
    const v = stripQuotes(m[1]);
    if (VALID_TAIL_MODES.has(v)) out.tailMode = v;
    break;
  }

  // decimals: <0..4>
  for (const l of block) {
    const m = l.match(/^\s{4}decimals\s*:\s*(\d+)/);
    if (!m) continue;
    const v = parseInt(m[1], 10);
    if (Number.isFinite(v) && v >= 0 && v <= 4) out.decimals = v;
    break;
  }

  return out;
}

function parseBool(s) {
  const v = stripQuotes(s).toLowerCase();
  if (v === "true" || v === "yes" || v === "on" || v === "1") return true;
  if (v === "false" || v === "no" || v === "off" || v === "0" || v === "") return false;
  // Unknown scalar: be permissive — anything truthy-string is true.
  return Boolean(v);
}

function stripQuotes(s) { return s.replace(/^["']|["']$/g, ""); }