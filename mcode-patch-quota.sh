#!/usr/bin/env bash
# Patch mcode's status bar to add a 5h/Week quota line.
# Data source: `mmx quota show --output json`
# Idempotent; safe to re-run after every `mcode update`.
set -euo pipefail

CODE_ROOT="${MCODE_CODE_ROOT:-$HOME/.minimax-code}"
CURRENT_FILE="$CODE_ROOT/current"

if [[ ! -f "$CURRENT_FILE" ]]; then
  echo "mcode current pointer not found: $CURRENT_FILE" >&2
  exit 1
fi

CURRENT_VERSION="$(tr -d '\r\n' < "$CURRENT_FILE")"
CHUNKS_DIR="$CODE_ROOT/releases/$CURRENT_VERSION/lib/node_modules/@minimax-ai/code/chunks"
LAUNCHER="$(ls "$CHUNKS_DIR"/launcher-*.js 2>/dev/null | head -1 || true)"

if [[ -z "$LAUNCHER" || ! -f "$LAUNCHER" ]]; then
  echo "Launcher not found in $CHUNKS_DIR" >&2
  exit 1
fi

BACKUP="$LAUNCHER.unpatched.bak"
if [[ ! -f "$BACKUP" ]]; then
  cp -p "$LAUNCHER" "$BACKUP"
fi

# Already patched? (compare with backup)
if ! cmp -s "$LAUNCHER" "$BACKUP"; then
  echo "[mcode-quota] already patched for $CURRENT_VERSION (launcher: $LAUNCHER)" >&2
  exit 0
fi

# Anchors verified for mcode 0.3.10 / @minimax-ai/code 0.2.7.
# Both anchors are unique within the launcher bundle.
# 1) Xc class: status renderer base — we'll call globalThis.__mcodeQuotaRender(e)
# 2) jf class: status widget — we'll inject quota init in constructor

# Anchor 1 (base class render)
RENDER_ANCHOR='Xc=class{constructor(e){this.state=e}setState(e){this.state=e}invalidate(){}render(e){let t=ma(e);if(t===0)return[];let i=X6(this.state);if(i.length===0)return[];let s=i.map(o=>J6(o,this.state)).filter(o=>o!==void 0);if(s.length===0)return[];let r=t3(s,t);return xe(r).trim()?["",r]:[]}}'

# Anchor 2 (status widget class declaration, to inject quota init in constructor)
WIDGET_ANCHOR='var jf=class extends Xc{constructor(t,i,s){super(t);this.runtime=i;this.requestRender=s;this.statusLineItems=t.statusLineItems,this.shellState=t,this.refresh(),this.refreshTimer=setInterval(()=>void this.refresh(),o3),this.refreshTimer.unref?.()}'

if ! grep -qF "$RENDER_ANCHOR" "$LAUNCHER"; then
  echo "Base class anchor not found in $LAUNCHER (mcode internals may have changed)" >&2
  echo "Please re-derive the anchor and update mcode-patch-quota.sh" >&2
  exit 2
fi
if ! grep -qF "$WIDGET_ANCHOR" "$LAUNCHER"; then
  echo "Status widget anchor not found in $LAUNCHER (mcode internals may have changed)" >&2
  echo "Please re-derive the anchor and update mcode-patch-quota.sh" >&2
  exit 2
fi

# Replacement 1: append quota row(s) by delegating to globalThis.__mcodeQuotaRender(width).
# The sidecar publishes a function that, given the TUI's content width, returns
# an array of formatted lines (single horizontal row if wide, two vertical rows if narrow).
RENDER_PATCH='Xc=class{constructor(e){this.state=e}setState(e){this.state=e}invalidate(){}render(e){let t=ma(e);if(t===0)return[];let i=X6(this.state);if(i.length===0)return[];let s=i.map(o=>J6(o,this.state)).filter(o=>o!==void 0);if(s.length===0)return[];let r=t3(s,t);if(!xe(r).trim())return[];let _qr=typeof globalThis.__mcodeQuotaRender==="function"?globalThis.__mcodeQuotaRender(e):[];if(!Array.isArray(_qr)||_qr.length===0)return["",r];return["",r,..._qr]}}'

# Replacement 2: add quota start hook to jf constructor (passes requestRender as update cb)
WIDGET_PATCH='var jf=class extends Xc{constructor(t,i,s){super(t);this.runtime=i;this.requestRender=s;this.statusLineItems=t.statusLineItems,this.shellState=t,this.refresh(),this.refreshTimer=setInterval(()=>void this.refresh(),o3),this.refreshTimer.unref?.();if(typeof globalThis.__mcodeQuotaStart==="function")globalThis.__mcodeQuotaStart(()=>{if(this.requestRender)setTimeout(()=>this.requestRender(),0)})}'

# Use perl for safe in-place replacement. Pass replacement through env var
# so the shell/Perl does not re-interpret \n inside the JS string.
RENDER_ANCHOR="$RENDER_ANCHOR" RENDER_PATCH="$RENDER_PATCH" \
  perl -i -pe 's/\Q$ENV{RENDER_ANCHOR}\E/$ENV{RENDER_PATCH}/' "$LAUNCHER"
WIDGET_ANCHOR="$WIDGET_ANCHOR" WIDGET_PATCH="$WIDGET_PATCH" \
  perl -i -pe 's/\Q$ENV{WIDGET_ANCHOR}\E/$ENV{WIDGET_PATCH}/' "$LAUNCHER"

# Sidecar: periodically runs `mmx quota show --output json` and publishes
# globalThis.__mcodeQuotaRender(width) → string[]. The render function is
# called by the patched Xc.render() with the TUI's content width, so it can
# choose between a single horizontal row or two vertical rows automatically.
SIDECAR="$CHUNKS_DIR/mcode-quota-fetcher-9f8a7b.mjs"
cat > "$SIDECAR" <<'EOF'
import { spawn } from "node:child_process";
const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

// Raw quota data kept in this closure.
let raw = { valid: false, dRem: null, dReset: "", wRem: null, wReset: "", fetchedAt: 0 };
let onUpdateCb = null;

// Theme colors (tuned for less eye strain than mcode's default).
const C_SUCCESS = "38;2;60;160;90";    // deep green
const C_WARNING = "38;2;200;150;40";   // muted amber
const C_ERROR   = "38;2;200;80;80";    // muted red
const C_MUTED   = "38;2;140;140;140";
const C_RESET   = "0";
const C_LABEL   = "38;2;180;180;180";

// Bar width is capped so a wide terminal doesn't render an excessively long bar.
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
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${totalSec}s`;
};

// Color tier for a remaining percentage: matches mcode's internal ef() heuristic.
const colorFor = (rem) =>
  rem == null ? C_MUTED : rem <= 10 ? C_ERROR : rem <= 30 ? C_WARNING : C_SUCCESS;

// Build a [filled|empty] bar wrapped in ANSI color escapes.
const buildBar = (rem, width) => {
  const w = Math.max(MIN_BAR_WIDTH, Math.min(MAX_BAR_WIDTH, width | 0));
  if (rem == null) {
    return { text: "░".repeat(w), colored: false };
  }
  const c = colorFor(rem);
  const filled = Math.max(0, Math.min(w, Math.round((rem / 100) * w)));
  const empty = w - filled;
  const filledSeq = "\x1b[" + c + "m" + "█".repeat(filled) + "\x1b[" + C_RESET + "m";
  const emptySeq  = "\x1b[" + C_MUTED + "m" + "░".repeat(empty) + "\x1b[" + C_RESET + "m";
  return { text: filledSeq + emptySeq, colored: true };
};

const pickGeneral = (rows) =>
  Array.isArray(rows) ? (rows.find((r) => r?.model_name === "general") || rows[0] || null) : null;

// Compose one label + bar + percentage, with optional reset time.
function renderOne(label, rem, reset, barWidth) {
  if (rem == null) {
    return "\x1b[" + C_MUTED + "m" + label + "\x1b[" + C_RESET + "m" + "  (no data)";
  }
  const c = colorFor(rem);
  const labelSeq = "\x1b[" + C_LABEL + "m" + label + "\x1b[" + C_RESET + "m";
  const barSeq = buildBar(rem, barWidth).text;
  const pctSeq = "\x1b[" + c + "m" + rem + "% left\x1b[" + C_RESET + "m";
  const tail = reset
    ? "  \x1b[" + C_MUTED + "m· resets in " + reset + "\x1b[" + C_RESET + "m"
    : "";
  return labelSeq + " [" + barSeq + "] " + pctSeq + tail;
}

// Width threshold below which we fall back to two rows with reset times.
const HORIZ_MIN_WIDTH = 88;

globalThis.__mcodeQuotaRender = function (width) {
  if (!raw.valid) return [];
  if (width == null || width < 0) width = 0;
  if (width >= HORIZ_MIN_WIDTH) {
    // Horizontal: one row, both bars, no reset (to fit ~90 cols).
    // Each bar uses ~30 chars; budget = width - 8 (label1) - 8 (label2) - 24 (pcts + sep).
    const barWidth = Math.max(12, Math.floor((width - 40) / 2));
    const line1 = renderOne("5-hour", raw.dRem, "", barWidth);
    const line2 = renderOne("Weekly", raw.wRem, "", barWidth);
    const sep = "  \x1b[" + C_MUTED + "m·\x1b[" + C_RESET + "m  ";
    return [line1 + sep + line2];
  }
  // Vertical: two rows, each with reset time.
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
      if (code !== 0) return reject(new Error(`mmx exited ${code}: ${err.trim()}`));
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
EOF

echo "[mcode-quota] patched launcher for $CURRENT_VERSION"
echo "[mcode-quota] sidecar: $SIDECAR"
echo
echo "Launch mcode with the sidecar preloaded:"
echo "  NODE_OPTIONS=\"--import=$SIDECAR\" mcode"
echo
echo "Or set permanently in your shell rc:"
echo "  export NODE_OPTIONS=\"--import=$SIDECAR\""
