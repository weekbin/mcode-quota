#!/usr/bin/env node
// mcode-find-anchors.mjs
//
// Find structural anchors in mcode's launcher bundle for the quota patch.
// All output is short-name-agnostic — the obfuscator can rename anything.
//
// Output (shell-eval-able):
//   BASE=<base class short name>
//   WIDGET=<widget class short name>
//   WIDGET_BODY_START=<byte offset, right after the opening `{` of widget class body>
//   WIDGET_BODY_END=<byte offset, position of the closing `}` of widget class body>
//   CTOR_END=<byte offset, position of the closing `}` of widget class constructor>
//
// Strategy:
//   1. Find every "Name = class [extends Base] {" position.
//   2. For each, brace-count to find the body.
//   3. BASE: has a render(<param>) method whose body contains ["", <expr>].
//   4. WIDGET: extends BASE, has 5 state-init features:
//        super(...)
//        this.runtime = ...
//        this.requestRender = ...
//        this.statusLineItems = ...
//        setInterval(...)
//   5. Locate the END of widget class constructor by matching braces from the
//      start of `constructor(...)` keyword to its matching `}`. The character
//      right after this `}` is the natural insertion point for the start hook.

import { readFileSync } from "node:fs";

const launcherPath = process.argv[2];
if (!launcherPath) {
  process.stderr.write("usage: node mcode-find-anchors.mjs <launcher.js>\n");
  process.exit(1);
}
const content = readFileSync(launcherPath, "utf-8");

// Find all "Name = class [extends Base] {" positions.
const classRe = /(\w+)\s*=\s*class(?:\s+extends\s+(\w+))?\s*\{/g;
const classes = [];
let m;
while ((m = classRe.exec(content)) !== null) {
  const shortName = m[1];
  const baseName = m[2] || null;
  const bodyStart = m.index + m[0].length; // right after `{`
  // Brace counting to find matching `}` for this class body.
  let depth = 1;
  let i = bodyStart;
  while (i < content.length && depth > 0) {
    const c = content[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    i++;
  }
  const bodyEnd = i - 1; // position of the matching `}` of class body
  classes.push({ shortName, baseName, bodyStart, bodyEnd, body: content.slice(bodyStart, bodyEnd) });
}
if (classes.length === 0) {
  process.stderr.write("ERROR: no ClassExpression found in launcher\n");
  process.exit(2);
}

// --- Find BASE class -----------------------------------------------------
let base = null;
for (const c of classes) {
  // Look for a render(<param>) { ... } method.
  const renderMatch = c.body.match(/\brender\s*\(\s*\w+\s*\)\s*\{/);
  if (!renderMatch) continue;
  const renderStart = renderMatch.index + renderMatch[0].length;
  let depth = 1;
  let j = renderStart;
  while (j < c.body.length && depth > 0) {
    if (c.body[j] === "{") depth++;
    else if (c.body[j] === "}") depth--;
    j++;
  }
  const renderBody = c.body.slice(renderStart, j - 1);
  // Distinctive pattern:  ["", <something>]  (empty row + content row).
  if (/\[\s*""\s*,\s*\w+\s*\]/.test(renderBody)) {
    base = c;
    break;
  }
}
if (!base) {
  process.stderr.write(
    "ERROR: could not find base class — no class has a render() method\n" +
      "  returning ['<empty string>', <expr>] (the mcode status bar layout)\n",
  );
  process.exit(2);
}

// --- Find WIDGET class ----------------------------------------------------
let widget = null;
for (const c of classes) {
  if (c.baseName !== base.shortName) continue;
  const checks = [
    [/\bsuper\s*\(/, "super(...) call"],
    [/this\.runtime\s*=/, "this.runtime assignment"],
    [/this\.requestRender\s*=/, "this.requestRender assignment"],
    [/this\.statusLineItems\s*=/, "this.statusLineItems assignment"],
    [/\bsetInterval\s*\(/, "setInterval(...) call"],
  ];
  for (const [, label] of checks) {
    if (!checks[0][0].test(c.body)) {
      // not actually a failure path; we break on missing feature below
    }
  }
  const missing = checks.find(([re, label]) => !re.test(c.body));
  if (missing) {
    process.stderr.write(
      `WIDGET candidate '${c.shortName}' missing feature: ${missing[1]}\n`,
    );
    continue;
  }
  widget = c;
  break;
}
if (!widget) {
  process.stderr.write(
    `ERROR: could not find widget class — no class extends '${base.shortName}'\n` +
      "  with all 5 state-init features (super + runtime + requestRender + statusLineItems + setInterval)\n",
  );
  process.exit(2);
}

// --- Find END of widget class constructor -------------------------------
// We need the byte offset of the closing `}` of the constructor method,
// so the patcher can insert the sidecar-start hook right after it.
// Strategy: locate "constructor(...)" inside widget body, then brace-count
// from the `{` of its body.
let ctorEnd = -1;
const ctorMatch = widget.body.match(/\bconstructor\s*\([^)]*\)\s*\{/);
if (!ctorMatch) {
  process.stderr.write("ERROR: widget class has no constructor method\n");
  process.exit(2);
}
const ctorBodyStart = ctorMatch.index + ctorMatch[0].length;
{
  let depth = 1;
  let j = ctorBodyStart;
  while (j < widget.body.length && depth > 0) {
    if (widget.body[j] === "{") depth++;
    else if (widget.body[j] === "}") depth--;
    j++;
  }
  ctorEnd = widget.bodyStart + j - 1; // absolute byte offset of the `}` of ctor
}
if (ctorEnd < 0) {
  process.stderr.write("ERROR: could not locate end of widget constructor body\n");
  process.exit(2);
}

// --- Emit shell-eval-able output -----------------------------------------
const sq = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
process.stdout.write(`# mcode-find-anchors output for ${launcherPath}\n`);
process.stdout.write(`BASE=${sq(base.shortName)}\n`);
process.stdout.write(`WIDGET=${sq(widget.shortName)}\n`);
process.stdout.write(`WIDGET_BODY_START=${widget.bodyStart}\n`);
process.stdout.write(`WIDGET_BODY_END=${widget.bodyEnd}\n`);
process.stdout.write(`CTOR_END=${ctorEnd}\n`);
process.stdout.write(`# Verified: WIDGET extends BASE, has all 5 widget features\n`);
process.stdout.write(`# Verified: widget class body is ${widget.bodyEnd - widget.bodyStart} bytes\n`);
