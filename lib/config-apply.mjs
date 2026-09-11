// lib/config-apply.mjs — merge the mcodex status-line settings into mcode's
// config.yaml.
//
// WHY TEXT EDITING, NOT PARSE + RESERIALISE
// ------------------------------------------
// ~/.minimax/config.yaml is a hand-maintained 12 KB file the user has tuned:
// provider blocks, model limits, comments, ordering. Round-tripping it through
// a YAML parser would silently discard every comment and reflow the whole
// file. So we edit only the two keys we own inside the `tui:` block and leave
// every other byte untouched.
//
// Idempotent: running it twice produces the same file. A one-shot backup is
// written next to the original before the first change.

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";

const OWNED_LIST_KEY = "statusLine";
const OWNED_BLOCK_KEY = "customStatusLine";
const ITEM = "custom-command";

const indentOf = (line) => (line.match(/^ */) || [""])[0].length;

// Split/join must round-trip a file that ends with a newline. split("\n") on
// "a\nb\n" yields ["a","b",""] and join("\n") puts it back — but any splice
// that touches the tail can drop that sentinel, silently stripping the final
// newline from a hand-maintained config. Capture it up front and restore it.
const splitKeepEol = (text) => {
  const hadEol = text.endsWith("\n");
  const lines = text.split("\n");
  if (hadEol) lines.pop();
  return { lines, hadEol };
};
const joinKeepEol = (lines, hadEol) => lines.join("\n") + (hadEol ? "\n" : "");

// Locate a top-level `key:` block: [startIndex, endIndexExclusive].
function topLevelBlock(lines, key) {
  const start = lines.findIndex((l) => new RegExp("^" + key + "\\s*:").test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    if (indentOf(lines[i]) === 0) { end = i; break; }
  }
  return [start, end];
}

// Locate a child block inside [from, to) at the given indent.
function childBlock(lines, from, to, key, indent) {
  const pad = " ".repeat(indent);
  const start = lines.findIndex((l, i) =>
    i >= from && i < to && l.startsWith(pad + key + ":"));
  if (start < 0) return null;
  let end = to;
  for (let i = start + 1; i < to; i++) {
    if (lines[i].trim() === "") continue;
    if (indentOf(lines[i]) <= indent) { end = i; break; }
  }
  return [start, end];
}

function listItems(lines, from, to, indent) {
  const pad = " ".repeat(indent);
  const out = [];
  for (let i = from; i < to; i++) {
    const m = lines[i].match(new RegExp("^" + pad + "-\\s*(.+?)\\s*$"));
    if (m) out.push(m[1].replace(/^["']|["']$/g, ""));
  }
  return out;
}

/**
 * Ensure `tui.statusLine` contains `custom-command` and `tui.customStatusLine`
 * points at `command`.
 *
 * Returns { changed, configPath, backup } — backup is null when nothing was
 * written.
 */
export function applyStatuslineConfig(configPath, opts) {
  const {
    command,
    maxLines = 3,
    intervalSeconds = 10,
    timeoutMs = 5000,
    position = "below",
    colorMode = "ansi",
    ensureItems = null,     // extra statusLine items to append if missing
    dryRun = false,
  } = opts || {};

  if (!existsSync(configPath)) throw new Error("config not found: " + configPath);
  const original = readFileSync(configPath, "utf-8");
  const { lines, hadEol } = splitKeepEol(original);

  let tui = topLevelBlock(lines, "tui");
  let createdTui = false;
  if (!tui) {
    // Append a fresh tui: block at the end.
    if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
    const at = lines.length;
    lines.push("tui:");
    tui = [at, lines.length];
    createdTui = true;
  }

  // ---- statusLine list -----------------------------------------------------
  let [tuiStart, tuiEnd] = tui;
  let list = childBlock(lines, tuiStart, tuiEnd, OWNED_LIST_KEY, 2);
  const wantItems = [];
  if (list) {
    const current = listItems(lines, list[0], list[1], 4);
    for (const it of current) if (!wantItems.includes(it)) wantItems.push(it);
  }
  for (const extra of [ITEM, ...(ensureItems || [])]) {
    if (!wantItems.includes(extra)) wantItems.push(extra);
  }

  let changed = false;
  const rendered = wantItems.map((it) => "    - " + it);
  if (list) {
    const before = lines.slice(list[0], list[1]).join("\n");
    const after = ["  " + OWNED_LIST_KEY + ":"].concat(rendered).join("\n");
    if (before.trim() !== after.trim()) { changed = true; }
    lines.splice(list[0], list[1] - list[0], ...["  " + OWNED_LIST_KEY + ":"], ...rendered);
  } else {
    // Insert the list right after `tui:`.
    lines.splice(tuiStart + 1, 0, "  " + OWNED_LIST_KEY + ":", ...rendered);
    changed = true;
  }

  // ---- customStatusLine block ---------------------------------------------
  tui = topLevelBlock(lines, "tui");
  [tuiStart, tuiEnd] = tui;
  const block = [
    "  " + OWNED_BLOCK_KEY + ":",
    "    command: " + command,
    "    display: block",
    "    position: " + position,
    "    maxLines: " + maxLines,
    "    intervalSeconds: " + intervalSeconds,
    "    timeoutMs: " + timeoutMs,
    "    colorMode: " + colorMode,
  ];
  const existing = childBlock(lines, tuiStart, tuiEnd, OWNED_BLOCK_KEY, 2);
  if (existing) {
    const before = lines.slice(existing[0], existing[1]).join("\n");
    if (before.trim() !== block.join("\n").trim()) changed = true;
    lines.splice(existing[0], existing[1] - existing[0], ...block);
  } else {
    // Append at the end of the tui block.
    lines.splice(tuiEnd, 0, ...block);
    changed = true;
  }
  if (createdTui) changed = true;

  const next = joinKeepEol(lines, hadEol);
  if (!changed || next === original) {
    return { changed: false, configPath, backup: null };
  }
  if (dryRun) return { changed: true, configPath, backup: null, preview: next };

  const backup = configPath + ".mcodex-backup";
  if (!existsSync(backup)) copyFileSync(configPath, backup);
  writeFileSync(configPath, next, "utf-8");
  return { changed: true, configPath, backup };
}

/** Remove our two keys, leaving the rest of the file alone. */
export function removeStatuslineConfig(configPath, dryRun = false) {
  if (!existsSync(configPath)) return { changed: false, configPath };
  const original = readFileSync(configPath, "utf-8");
  const { lines, hadEol } = splitKeepEol(original);
  let tui = topLevelBlock(lines, "tui");
  if (!tui) return { changed: false, configPath };
  let [tuiStart, tuiEnd] = tui;

  let changed = false;
  const block = childBlock(lines, tuiStart, tuiEnd, OWNED_BLOCK_KEY, 2);
  if (block) { lines.splice(block[0], block[1] - block[0]); changed = true; }

  tui = topLevelBlock(lines, "tui");
  [tuiStart, tuiEnd] = tui;
  const list = childBlock(lines, tuiStart, tuiEnd, OWNED_LIST_KEY, 2);
  if (list) {
    const kept = listItems(lines, list[0], list[1], 4).filter((x) => x !== ITEM);
    const rendered = kept.map((it) => "    - " + it);
    lines.splice(list[0], list[1] - list[0], "  " + OWNED_LIST_KEY + ":", ...rendered);
    changed = true;
  }
  if (!changed) return { changed: false, configPath };
  const next = joinKeepEol(lines, hadEol);
  if (dryRun) return { changed: true, configPath, preview: next };
  writeFileSync(configPath, next, "utf-8");
  return { changed: true, configPath };
}
