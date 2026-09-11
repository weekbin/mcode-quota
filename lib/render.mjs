// lib/render.mjs — mcodex status-line renderer (pure, no I/O).
//
// This is the canonical render core for mcode 0.4.0+, where mcodex no longer
// patches mcode and instead feeds it through the native `custom-command`
// status-line item. The legacy fork (patches/0.3.x) carries its own frozen
// copy of this logic inside its sidecar template; tests/parity.mjs asserts the
// two produce byte-identical rows for the same inputs, so the display cannot
// drift.
//
// Everything here is pure: give it the data, get back an array of styled
// lines. No sqlite, no subprocesses, no globals.
//
// Width contract: callers pass the terminal column budget. CJK counts as 2
// columns and ANSI escapes as 0 — see dw().

// ---------------------------------------------------------------------------
// Palette. 24-bit RGB, chosen for dark terminals.
//   success 60,160,90    warning 200,150,40    error 200,80,80
//   muted   140,140,140  label   180,180,180
// ---------------------------------------------------------------------------
export const C_SUCCESS = "38;2;60;160;90";
export const C_WARNING = "38;2;200;150;40";
export const C_ERROR = "38;2;200;80;80";
export const C_MUTED = "38;2;140;140;140";
export const C_LABEL = "38;2;180;180;180";
export const C_HIT_MID = "38;2;140;170;90";
export const C_RESET = "0";

const ESC = "\u001b[";
const RESET_SEQ = ESC + C_RESET + "m";

// Separator: 1 ASCII space on each side of the │. Together with the 1-char
// space already in adjacent chunks this gives a comfortable 2-col gap.
export const SEP = " " + ESC + C_MUTED + "m\u2502" + RESET_SEQ + " ";

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------
export const L_LABEL_SESSION = "\u4f1a\u8bdd tokens";             // 会话 tokens
export const L_LABEL_5H = "\u5c0f\u65f6\u4f1a\u8bdd\u7a97\u53e3"; // 小时会话窗口
export const L_LABEL_WEEK = "\u5468\u9650\u5236\u4f7f\u7528\u91cf"; // 周限制使用量
export const L_CONTEXT = "\u4e0a\u4e0b\u6587";                    // 上下文
export const L_IN = "\u8f93\u5165";                               // 输入
export const L_OUT = "\u8f93\u51fa";                              // 输出
export const L_CACHE = "\u7f13\u5b58";                            // 缓存
export const L_HIT = "\u7f13\u5b58\u547d\u4e2d";                  // 缓存命中
export const L_TURN = "\u8f6e\u6570";                             // 轮数
export const L_TODAY = "\u4eca\u65e5";                            // 今日
export const L_LEFT = "\u5269\u4f59";                             // 剩余
export const L_RESET = "\u91cd\u7f6e";                            // 重置
export const L_NO_DATA = "\u65e0\u6570\u636e";                    // 无数据

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------
export const MAX_BAR_WIDTH = 20;
// 8, not 4: buildBar() clamps its width argument up to this floor, so
// fit()'s second loop (bar = MIN-1 .. 1) is a no-op below it. Porting 4
// here made the combined quota row look 4 columns narrower than the
// legacy did, which flipped a whole layout branch at narrow widths.
export const MIN_BAR_WIDTH = 8;
const BLOCK_FULL = "\u2588";
const BLOCK_EMPTY = "\u2591";

// Model names are written verbatim by mcode with no normalisation, so custom
// GGUF filenames and fine-tune names routinely exceed 30 chars. Middle-ellipsis
// keeps the family name (head) and the version/quant suffix (tail) readable.
export const MAX_MODEL_NAME_CHARS = 32;
export const MIN_MODEL_NAME_CHARS = 8;
const ELLIPSIS = "\u2026";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------
export const label = (s) => ESC + C_LABEL + "m" + s + RESET_SEQ;
export const muted = (s) => ESC + C_MUTED + "m" + s + RESET_SEQ;
export const dot = () => muted("\u2502");

export const pct = (n) =>
  typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;

// v3.2.2: K / M / B / T short scale (US finance / tech convention).
//   1_000_000_000 renders as 1.00B, never as 1000.00M.
// v3.2.3: two decimals, matching every other token figure on the row.
// The 999.995 thresholds stop JS float rounding from producing a 4-digit
// suffix ("1000.00M") at a tier boundary — such a value bumps to the next unit.
export const fmtTok = (n) => {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1_000_000_000_000) {
    return (n / 1_000_000_000_000).toFixed(2) + "T";
  }
  if (n >= 1_000_000_000) {
    if (n >= 999_995_000_000) {
      return (Math.round(n / 10_000_000_000) / 100).toFixed(2) + "T";
    }
    return (n / 1_000_000_000).toFixed(2) + "B";
  }
  if (n >= 1_000_000) {
    if (n >= 999_995_000) {
      return (Math.round(n / 10_000_000) / 100).toFixed(2) + "B";
    }
    return (n / 1_000_000).toFixed(2) + "M";
  }
  if (n >= 1_000) {
    if (n >= 999_995) {
      return (Math.round(n / 10_000) / 100).toFixed(2) + "M";
    }
    return (n / 1_000).toFixed(2) + "K";
  }
  return String(n);
};

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

// Display width: CJK counts as 2 columns, ANSI escapes as 0.
const ANSI_RE = new RegExp("\\u001b\\[[0-9;]*m", "g");
export function dw(s) {
  const t = String(s).replace(ANSI_RE, "");
  let w = 0;
  for (const ch of t) {
    const cp = ch.codePointAt(0);
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

export const colorFor = (rem) =>
  rem == null ? C_MUTED : rem <= 20 ? C_ERROR : rem <= 50 ? C_WARNING : C_SUCCESS;

export const buildBar = (rem, width) => {
  const w = Math.max(MIN_BAR_WIDTH, Math.min(MAX_BAR_WIDTH, width | 0));
  if (rem == null) return { text: BLOCK_EMPTY.repeat(w), colored: false };
  const c = colorFor(rem);
  const filled = Math.max(0, Math.min(w, Math.round((rem / 100) * w)));
  const empty = w - filled;
  const filledSeq = ESC + c + "m" + BLOCK_FULL.repeat(filled) + RESET_SEQ;
  const emptySeq = ESC + C_MUTED + "m" + BLOCK_EMPTY.repeat(empty) + RESET_SEQ;
  return { text: filledSeq + emptySeq, colored: true };
};

// Pad a label with full-width spaces (CJK) so 5h and 周 stack with their
// brackets aligned. ANSI reset is needed so the label colour does not leak
// into the padding.
const FULLWIDTH_SPACE = "\u3000";
export function paddedLabel(text, labelWidth) {
  if (!labelWidth || labelWidth <= 0) return label(text);
  const pad = Math.max(0, labelWidth - dw(text));
  if (pad === 0) return label(text);
  if (pad === 1) return label(text + " ");
  return label(text) + FULLWIDTH_SPACE.repeat(Math.floor(pad / 2)) + (pad % 2 ? " " : "");
}

// budget is optional. When the caller knows how many columns it can spend
// (narrow terminal, neighbours on the same row) it passes a smaller value so
// the name shrinks with the space instead of overflowing the whole row.
export function shortenModelName(name, budget) {
  let max = MAX_MODEL_NAME_CHARS;
  if (typeof budget === "number" && Number.isFinite(budget)) {
    max = Math.max(MIN_MODEL_NAME_CHARS, Math.min(MAX_MODEL_NAME_CHARS, Math.floor(budget)));
  }
  if (!name || name.length <= max) return name;
  const tail = Math.max(3, Math.floor(max * 0.4));
  const head = Math.max(1, max - tail - 1);
  return name.slice(0, head) + ELLIPSIS + name.slice(name.length - tail);
}

// ---------------------------------------------------------------------------
// Row pieces
// ---------------------------------------------------------------------------

// 5h / 周. rem is the remaining percent, reset is a pre-formatted string.
export function renderOne(text, rem, reset, barWidth, labelWidth) {
  if (rem == null) return paddedLabel(text, labelWidth) + " " + muted("(" + L_NO_DATA + ")");
  const c = colorFor(rem);
  const barSeq = buildBar(rem, barWidth).text;
  const pctSeq = ESC + c + "m" + rem + "% " + L_LEFT + RESET_SEQ;
  const tail = reset ? " " + muted(dot() + " " + L_RESET + " " + reset) : "";
  return paddedLabel(text, labelWidth) + " [" + barSeq + "] " + pctSeq + tail;
}

// 会话 tokens [「输入 │ 输出 │ 缓存」]
export function renderSessionChunk(session, compact) {
  if (!session || !session.valid) return null;
  const totalSeq = ESC + C_SUCCESS + "m" + fmtTok(session.total) + RESET_SEQ;
  if (compact) return label(L_LABEL_SESSION) + " " + totalSeq;
  const d = " " + dot() + " ";
  const detail = " \u300c" + L_IN + " " + fmtTok(session.input) + d +
                 L_OUT + " " + fmtTok(session.output) + d +
                 L_CACHE + " " + fmtTok(session.cache) + "\u300d";
  return label(L_LABEL_SESSION) + " " + totalSeq + detail;
}

// 上下文 N% 「used/window」. Thresholds mirror mcode's own "Context N% left",
// inverted to used-percent: warn at 75% used, error at 90% used.
export function renderContextChunk(ctx) {
  if (!ctx || !Number.isFinite(ctx.used) || !Number.isFinite(ctx.window) || !ctx.window) return null;
  const used = Math.max(0, Math.min(ctx.used, ctx.window));
  const p = Math.round((used / ctx.window) * 100);
  const col = p >= 90 ? C_ERROR : p >= 75 ? C_WARNING : C_SUCCESS;
  const amount = muted("\u300c" + fmtTok(used) + "/" + fmtTok(ctx.window) + "\u300d");
  return label(L_CONTEXT) + " " + ESC + col + "m" + p + "%" + RESET_SEQ + " " + amount;
}

// 缓存命中 N% — share of prompt tokens served from cache.
// ≥90% deep green, ≥70% muted green, otherwise amber.
export function renderCacheHitChunk(session) {
  if (!session || !session.valid || session.cacheHit == null) return null;
  const p = session.cacheHit * 100;
  const col = p >= 90 ? C_SUCCESS : p >= 70 ? C_HIT_MID : C_WARNING;
  return label(L_HIT) + " " + ESC + col + "m" + Math.round(p) + "%" + RESET_SEQ;
}

// 轮数 N — distinct turns in this session.
export function renderTurnCountChunk(session) {
  if (!session || !session.valid || !session.turns) return null;
  return label(L_TURN) + " " + muted(String(session.turns));
}

// 今日 「model」 total — responsive top-N by width.
// If even one model does not fit, the name is shrunk to whatever space is left;
// an empty row loses the information entirely, a terse one still answers
// "which model ran today".
export function renderTodayByModelRow(today, width) {
  if (!today || !today.valid || !Array.isArray(today.items) || today.items.length === 0) return [];
  const visible = today.items.filter((it) => it.model !== "<unknown>");
  if (visible.length === 0) return [];
  const maxN = width >= 100 ? 5 : width >= 70 ? 3 : 1;
  const items = visible.slice(0, maxN);
  const buildOne = (it) => {
    const modelStr = shortenModelName(it.model);
    const totalStr = fmtTok(it.total);
    return "\u300c" + label(modelStr) + "\u300d " + ESC + C_SUCCESS + "m" + totalStr + RESET_SEQ;
  };
  let chosen = [];
  for (let n = items.length; n >= 1; n--) {
    const lineParts = [];
    lineParts.push(label(L_TODAY) + " ");
    for (let i = 0; i < n; i++) {
      if (i > 0) lineParts.push(SEP);
      lineParts.push(buildOne(items[i]));
    }
    const line = lineParts.join("");
    if (dw(line) <= width) { chosen = [line]; break; }
  }
  if (chosen.length === 0 && items.length > 0) {
    // Layout overhead is fixed: "今日 " + 「 + 」 + " " + total.
    const first = items[0];
    const totalStr = fmtTok(first.total);
    const overhead = dw(label(L_TODAY) + " ") + 4 + 1 + dw(totalStr);
    const budget = width - overhead;
    if (budget >= MIN_MODEL_NAME_CHARS) {
      const modelStr = shortenModelName(first.model, budget);
      const line = label(L_TODAY) + " " +
        "\u300c" + label(modelStr) + "\u300d " +
        ESC + C_SUCCESS + "m" + totalStr + RESET_SEQ;
      if (dw(line) <= width) chosen = [line];
    }
  }
  return chosen;
}

// Render a single quota line at the widest bar that still fits the width.
// Below MIN_BAR_WIDTH the bar shrinks to 1 char rather than overflow — the
// user sees a sliver plus the percent, never a clipped row.
export function fit(build, width) {
  for (let bar = MAX_BAR_WIDTH; bar >= MIN_BAR_WIDTH; bar--) {
    const s = build(bar);
    if (dw(s) <= width) return s;
  }
  for (let bar = MIN_BAR_WIDTH - 1; bar >= 1; bar--) {
    const s = build(bar);
    if (dw(s) <= width) return s;
  }
  return build(MIN_BAR_WIDTH);
}

// 5h/周 row(s): one combined row when it fits, else two stacked rows with
// aligned labels, else the same without reset times, else progressively
// degraded forms. Always returns at least one row.
export function renderQuotaRows(quota, width) {
  const labelWidth = Math.max(dw(L_LABEL_5H), dw(L_LABEL_WEEK));
  const q5  = (bar) => renderOne(L_LABEL_5H, quota.dRem, quota.dReset, bar, labelWidth);
  const qw  = (bar) => renderOne(L_LABEL_WEEK, quota.wRem, quota.wReset, bar, labelWidth);
  const topCombined = (bar) => q5(bar) + SEP + qw(bar);
  const topOneRow = fit(topCombined, width);
  if (dw(topOneRow) <= width) return [topOneRow];

  const stacked = [fit(q5, width), fit(qw, width)];
  if (stacked.every((r) => dw(r) <= width)) return stacked;

  const q5n = (bar) => renderOne(L_LABEL_5H, quota.dRem, "", bar, labelWidth);
  const qwn = (bar) => renderOne(L_LABEL_WEEK, quota.wRem, "", bar, labelWidth);
  const stackedNoReset = [fit(q5n, width), fit(qwn, width)];
  if (stackedNoReset.every((r) => dw(r) <= width)) return stackedNoReset;

  // Truly tiny (< ~50): drop the percent to keep the bar visible, walking
  // label padding and bar width together to find any rendering that fits.
  let best = null;
  let out = null;
  for (const lw of [labelWidth, 4, 0]) {
    const q5s = (bar) => label(L_LABEL_5H) + " " + buildBar(quota.dRem, bar).text;
    const qws = (bar) => paddedLabel(L_LABEL_WEEK, lw) + " " + buildBar(quota.wRem, bar).text;
    const rows = [fit(q5s, width), fit(qws, width)];
    if (rows.every((r) => dw(r) <= width)) { out = rows; best = null; break; }
    best = rows;
  }
  if (out) return out;
  out = best;
  // Final fallback for sub-20-col: shrink the labels themselves.
  if (out && out.some((r) => dw(r) > width)) {
    for (const chars of [Math.max(2, Math.floor(width / 4)), 2, 1]) {
      const trunc5 = L_LABEL_5H.slice(0, chars);
      const truncW = L_LABEL_WEEK.slice(0, chars);
      const q5s = (bar) => label(trunc5) + " " + buildBar(quota.dRem, bar).text;
      const qws = (bar) => label(truncW) + " " + buildBar(quota.wRem, bar).text;
      const rows = [fit(q5s, width), fit(qws, width)];
      if (rows.every((r) => dw(r) <= width)) { out = rows; break; }
      out = rows;   // keep the most aggressive attempt as last resort
    }
  }
  return out || [topOneRow];
}

// ---------------------------------------------------------------------------
// Full status block
// ---------------------------------------------------------------------------
// state = {
//   quota:  { valid, dRem, dReset, wRem, wReset } | null
//   session:{ valid, total, input, output, cache, cacheHit, turns }
//   context:{ used, window } | null
//   today:  { valid, items: [{model,total}] }
//   placeholders: { session, context, today }
//   tailMode: "auto" | "full" | "compact"
// }
// Returns an array of styled lines: [4-chunk, 5h-周, 今日] as available.
export function buildStatusLines(state, width) {
  const {
    quota = null,
    session = null,
    context = null,
    today = null,
    placeholders = {},
    tailMode = "auto",
  } = state || {};

  const lines = [];
  const join = (...chunks) => chunks.filter(Boolean).join(SEP);
  const placeholder = (name) => muted(name + " \u2026");

  const sessionFull = renderSessionChunk(session, false) ||
    (placeholders.session ? placeholder(L_LABEL_SESSION) : null);
  const sessionCompact = renderSessionChunk(session, true) || sessionFull;
  const ctx = renderContextChunk(context) ||
    (placeholders.context ? placeholder(L_CONTEXT) : null);
  const hit = renderCacheHitChunk(session) ||
    (placeholders.session ? placeholder(L_HIT) : null);
  const turn = renderTurnCountChunk(session) ||
    (placeholders.session ? placeholder(L_TURN) : null);

  if (quota && quota.valid) {
    const buildCandidates = (allowDetail) => {
      const list = [];
      if (allowDetail && sessionFull && ctx) {
        list.push(join(sessionFull, ctx, hit, turn));
        list.push(join(sessionFull, ctx, hit));
        list.push(join(sessionFull, ctx, turn));
        list.push(join(sessionFull, ctx));
      }
      if (sessionCompact && ctx) {
        list.push(join(sessionCompact, ctx, hit, turn));
        list.push(join(sessionCompact, ctx, hit));
        list.push(join(sessionCompact, ctx, turn));
        list.push(join(sessionCompact, ctx));
      }
      if (allowDetail && sessionFull) list.push(sessionFull);
      if (sessionCompact) list.push(sessionCompact);
      if (ctx) list.push(ctx);
      return list;
    };

    const candidates = (() => {
      if (tailMode === "compact") return buildCandidates(false);
      if (tailMode === "full") return buildCandidates(true);
      const detailList = buildCandidates(true);
      const compactList = buildCandidates(false);
      const detailFits = detailList.some((c) => dw(c) <= width);
      return detailFits ? detailList : compactList;
    })();

    if (candidates.some((c) => dw(c) <= width)) {
      const fits = candidates.filter((c) => dw(c) <= width);
      fits.sort((a, b) => dw(b) - dw(a));
      lines.push(fits[0]);
    } else {
      // Nothing fits on one row: pack the tail pieces greedily and wrap.
      const coreLine = sessionFull || sessionCompact || ctx || "";
      lines.push(coreLine);
      const tailPieces = [ctx, hit, turn].filter(Boolean);
      let buf = "";
      for (const p of tailPieces) {
        const cand = buf ? buf + SEP + p : p;
        if (dw(cand) <= width) {
          buf = cand;
        } else {
          if (buf) lines.push(buf);
          buf = p;
        }
      }
      if (buf && !lines.includes(buf)) lines.push(buf);
    }

    lines.push(...renderQuotaRows(quota, width));
  } else {
    // No quota data yet: still show the 4-chunk structure with placeholders
    // so the shape is stable while mmx is in flight.
    const tryList = [];
    if (sessionFull && ctx) tryList.push(join(sessionFull, ctx, hit, turn));
    if (sessionCompact && ctx) tryList.push(join(sessionCompact, ctx, hit, turn));
    if (sessionFull) tryList.push(sessionFull);
    if (sessionCompact) tryList.push(sessionCompact);
    if (ctx) tryList.push(ctx);
    for (const c of tryList) if (dw(c) <= width) { lines.push(c); break; }
  }

  const todayRows = renderTodayByModelRow(today, width);
  if (todayRows.length > 0) lines.push(...todayRows);
  else if (placeholders.today) lines.push(placeholder(L_TODAY));

  return lines;
}

// Strip ANSI for tests / diagnostics.
export const stripAnsi = (s) => String(s).replace(ANSI_RE, "");
