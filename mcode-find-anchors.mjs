#!/usr/bin/env node
// mcode-find-anchors.mjs
//
// Find structural anchors in mcode's launcher bundle for the quota patch.
// Uses acorn for full AST parsing — robust to template literals, comments,
// nested functions, and any obfuscator rename. Walks the entire AST (not
// just top-level statements) because the mcode launcher often defines
// classes inside comma expressions like `},Xc=class{...}` or as nested
// class expressions.
//
// Output (shell-eval-able key=value):
//   BASE=<base class short name>   (or "external" if superClass not in this chunk)
//   WIDGET=<widget class short name>
//   RENDER_METHOD_END=<byte offset of the `}` of the widget class render method>
//   WIDGET_BODY_END=<byte offset of the closing `}` of widget class body>
//   CTOR_END=<byte offset of the closing `}` of widget class constructor>
//
// Algorithm (WIDGET-first, BASE derived):
//   1. Parse the entire launcher with acorn → AST
//   2. Walk all nodes. For each ClassExpression, walk up the parent chain
//      to discover its binding (VariableDeclarator or AssignmentExpression).
//   3. Find the WIDGET: a class with 5 distinguishing state-init features
//      (super() call, this.runtime=, this.requestRender=, this.statusLineItems=,
//      setInterval). All structurally checked.
//   4. BASE = widget.superClass (the bound class extends something).
//      If BASE is not in this chunk (it's imported from another), report
//      "external" and the WIDGET alone is enough for the patch.

import { parse } from "acorn";
import { readFileSync } from "node:fs";

const launcherPath = process.argv[2];
if (!launcherPath) {
  process.stderr.write("usage: node mcode-find-anchors.mjs <launcher.js>\n");
  process.exit(1);
}
const content = readFileSync(launcherPath, "utf-8");

let ast;
try {
  ast = parse(content, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowReturnOutsideFunction: true,
    allowImportExportEverywhere: true,
    allowAwaitOutsideFunction: true,
    allowSuperOutsideMethod: true,
    ranges: true,
  });
} catch (e) {
  process.stderr.write(`[mcode-find-anchors] parse failed: ${e.message}\n`);
  process.exit(2);
}

// ---- Build parent map (depth-first traversal) ---------------------------
const parentMap = new WeakMap();
(function walk(node) {
  if (!node || typeof node !== "object" || !node.type) return;
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "parent") continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const v of val) {
        if (v && typeof v === "object" && v.type) {
          parentMap.set(v, node);
          walk(v);
        }
      }
    } else if (val && typeof val === "object" && val.type) {
      parentMap.set(val, node);
      walk(val);
    }
  }
})(ast);

// ---- Discover class expressions and their bindings ----------------------
function discoverClassNames() {
  const out = [];
  function visit(node) {
    if (!node || typeof node !== "object" || !node.type) return;
    if (node.type === "ClassExpression") {
      const binding = findBinding(node);
      if (binding) out.push(binding);
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "parent") continue;
      const val = node[key];
      if (Array.isArray(val)) {
        for (const v of val) if (v && typeof v === "object" && v.type) visit(v);
      } else if (val && typeof val === "object" && val.type) {
        visit(val);
      }
    }
  }
  visit(ast);
  return out;
}
function findBinding(classNode) {
  let cur = classNode;
  while (cur) {
    const parent = parentMap.get(cur);
    if (!parent) break;
    if (parent.type === "VariableDeclarator" && parent.init === cur && parent.id && parent.id.type === "Identifier") {
      return makeBinding(parent.id.name, classNode);
    }
    if (parent.type === "AssignmentExpression" && parent.right === cur && parent.left.type === "Identifier") {
      return makeBinding(parent.left.name, classNode);
    }
    cur = parent;
  }
  return null;
}
function makeBinding(name, classNode) {
  const out = {
    name,
    superClassName: classNode.superClass && classNode.superClass.type === "Identifier" ? classNode.superClass.name : null,
    classNode,
    renderMethod: null,
    ctorMethod: null,
  };
  for (const m of classNode.body.body) {
    if (m.type !== "MethodDefinition") continue;
    if (m.key && m.key.type === "Identifier") {
      if (m.key.name === "render") out.renderMethod = m;
      if (m.kind === "constructor") out.ctorMethod = m;
    }
  }
  return out;
}

const classes = discoverClassNames();
if (classes.length === 0) {
  process.stderr.write("ERROR: no ClassExpression found in launcher\n");
  process.exit(2);
}

// ---- Find WIDGET: 5 state-init features --------------------------------
function nodeHas(node, predicate) {
  if (!node || typeof node !== "object") return false;
  if (predicate(node)) return true;
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "parent") continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const v of val) if (v && typeof v === "object" && v.type) if (nodeHas(v, predicate)) return true;
    } else if (val && typeof val === "object" && val.type) {
      if (nodeHas(val, predicate)) return true;
    }
  }
  return false;
}
const isSuperCall = (n) => n.type === "CallExpression" && n.callee.type === "Super";
const isThisPropAssign = (prop) => (n) =>
  n.type === "AssignmentExpression" &&
  n.left.type === "MemberExpression" &&
  !n.left.computed &&
  n.left.object.type === "ThisExpression" &&
  n.left.property.type === "Identifier" &&
  n.left.property.name === prop;
const isSetIntervalCall = (n) =>
  n.type === "CallExpression" &&
  n.callee.type === "Identifier" &&
  n.callee.name === "setInterval";

const widgetChecks = [
  ["super()",                  isSuperCall],
  ["this.runtime = ...",       isThisPropAssign("runtime")],
  ["this.requestRender = ...",  isThisPropAssign("requestRender")],
  ["this.statusLineItems = ...",isThisPropAssign("statusLineItems")],
  ["setInterval(...)",         isSetIntervalCall],
];

let widget = null;
let widgetMissing = null;
for (const c of classes) {
  const missing = widgetChecks.find(([_, pred]) => !nodeHas(c.classNode, pred));
  if (missing) {
    widgetMissing = { name: c.name, missing: missing[0] };
    continue;
  }
  widget = c;
  break;
}
if (!widget) {
  process.stderr.write(
    `ERROR: no class has all 5 widget features (super + this.runtime= + this.requestRender= + this.statusLineItems= + setInterval)\n` +
      (widgetMissing ? `  (last candidate '${widgetMissing.name}' missing: ${widgetMissing.missing})\n` : "") +
      "\n",
  );
  process.exit(2);
}
if (!widget.ctorMethod) {
  process.stderr.write(`ERROR: widget '${widget.name}' has no constructor method\n`);
  process.exit(2);
}
// Note: render method is OPTIONAL — the patcher will add one if missing.
// The patched launcher will have a render method we can use as an anchor.

// ---- BASE = widget.superClass ------------------------------------------
let base = null;
let baseIsExternal = false;
if (widget.superClassName) {
  base = classes.find((c) => c.name === widget.superClassName);
  if (!base) {
    baseIsExternal = true;
    base = { name: widget.superClassName, classNode: null, renderMethod: null, ctorMethod: null, superClassName: null };
  }
} else {
  process.stderr.write(`ERROR: widget '${widget.name}' has no superClass (extends nothing)\n`);
  process.exit(2);
}

// ---- Byte offsets --------------------------------------------------------
const WIDGET_BODY_END = widget.classNode.end - 1;
const CTOR_END = widget.ctorMethod.end - 1;
const RENDER_METHOD_END = widget.renderMethod ? widget.renderMethod.end - 1 : -1;

if (RENDER_METHOD_END > 0 && WIDGET_BODY_END <= RENDER_METHOD_END) {
  process.stderr.write(`ERROR: class body end (${WIDGET_BODY_END}) must be > render end (${RENDER_METHOD_END})\n`);
  process.exit(2);
}

// ---- Emit shell-eval-able output -----------------------------------------
const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
process.stdout.write(`# mcode-find-anchors (acorn AST) for ${launcherPath}\n`);
process.stdout.write(`BASE=${sq(baseIsExternal ? "external" : base.name)}\n`);
process.stdout.write(`WIDGET=${sq(widget.name)}\n`);
process.stdout.write(`RENDER_METHOD_END=${RENDER_METHOD_END}\n`);
process.stdout.write(`WIDGET_BODY_END=${WIDGET_BODY_END}\n`);
process.stdout.write(`CTOR_END=${CTOR_END}\n`);
if (baseIsExternal) {
  process.stdout.write(`# BASE is in another chunk; not patched (WIDGET alone is enough)\n`);
} else {
  process.stdout.write(`# Class body span: ${widget.classNode.start}..${widget.classNode.end} (${widget.classNode.end - widget.classNode.start} bytes)\n`);
}
process.stdout.write(`# Render method span: ${widget.renderMethod ? `${widget.renderMethod.start}..${widget.renderMethod.end}` : "(none, will be added by patcher)"}\n`);
process.stdout.write(`# Constructor span: ${widget.ctorMethod.start}..${widget.ctorMethod.end}\n`);
process.stdout.write(`# Total classes discovered: ${classes.length}\n`);
