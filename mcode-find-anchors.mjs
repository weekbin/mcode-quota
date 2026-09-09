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

// Structural widget check: instead of hardcoding `this.runtime = ...` etc.,
// the widget class is identified by three purely structural features:
//   1. has a superclass
//   2. has a setInterval() call somewhere in its body (status bar polling
//      — the real discriminator; only widgets poll like this)
//   3. its constructor takes >= 2 params and assigns >= 2 of them to
//      instance fields (i.e. the widget receives the shell state, runtime,
//      and requestRender from the framework)
// `render` is NOT required: mcode widgets may inherit it from the base
// class (which is common in Ink-style inheritance hierarchies).
const isWidgetClass = (classNode) => {
  if (!classNode.superClass) return false;
  // (2) the status-bar polling signature. If a class doesn't call
  // setInterval, it's a leaf component, not the status-bar widget.
  if (!nodeHas(classNode, isSetIntervalCall)) return false;
  // (3) ctor assigns >= 2 ctor params to instance fields
  const ctor = classNode.body.body.find(m => m.type === "MethodDefinition" && m.kind === "constructor");
  if (!ctor || ctor.value.type !== "FunctionExpression") return false;
  const params = ctor.value.params.filter(p => p && p.type === "Identifier");
  if (params.length < 2) return false;
  const paramNames = new Set(params.map(p => p.name));
  let assignedParams = new Set();
  function visit(n) {
    if (!n || typeof n !== "object" || !n.type) return;
    if (n.type === "AssignmentExpression" && n.operator === "=" &&
        n.left.type === "MemberExpression" && !n.left.computed &&
        n.left.object.type === "ThisExpression" && n.left.property.type === "Identifier") {
      // RHS: this.X = firstParam  OR  this.X = firstParam.Y
      if (n.right.type === "Identifier" && paramNames.has(n.right.name)) {
        assignedParams.add(n.right.name);
      } else if (n.right.type === "MemberExpression" && !n.right.computed &&
                 n.right.object.type === "Identifier" && paramNames.has(n.right.object.name)) {
        assignedParams.add(n.right.object.name);
      }
    }
    for (const k of Object.keys(n)) {
      if (k === "loc" || k === "start" || k === "end") continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === "object") visit(v);
    }
  }
  visit(ctor.value.body);
  return assignedParams.size >= 2;
};

let widget = null;
let widgetMissing = null;
for (const c of classes) {
  if (!isWidgetClass(c.classNode)) {
    widgetMissing = { name: c.name, missing: "structural widget check" };
    continue;
  }
  widget = c;
  break;
}
if (process.env.MCODE_FIND_ANCHORS_DEBUG) {
  process.stderr.write(`# DEBUG: total classes=${classes.length} widget=${widget?.name ?? "NONE"}\n`);
  for (const c of classes) {
    if (c.superClassName === "Xc") {
      const classNode = c.classNode;
      const ctor = classNode.body.body.find(m => m.type === "MethodDefinition" && m.kind === "constructor");
      const params = ctor?.value?.type === "FunctionExpression"
        ? ctor.value.params.filter(p => p.type === "Identifier").map(p => p.name)
        : [];
      const paramNames = new Set(params);
      const assigned = new Set();
      function visitDbg(x) {
        if (!x || typeof x !== "object" || !x.type) return;
        if (x.type === "AssignmentExpression" && x.operator === "=" && x.left.type === "MemberExpression" && !x.left.computed && x.left.object.type === "ThisExpression") {
          if (x.right.type === "Identifier" && paramNames.has(x.right.name)) assigned.add(x.right.name);
          else if (x.right.type === "MemberExpression" && !x.right.computed && x.right.object.type === "Identifier" && paramNames.has(x.right.object.name)) assigned.add(x.right.object.name);
        }
        for (const k of Object.keys(x)) {
          if (k === "parent" || k === "loc" || k === "start" || k === "end") continue;
          const v = x[k];
          if (Array.isArray(v)) v.forEach(visitDbg);
          else if (v && typeof v === "object") visitDbg(v);
        }
      }
      if (ctor?.value?.body) visitDbg(ctor.value.body);
      process.stderr.write(`# DEBUG: class=${c.name} super=${c.superClassName} params=${params.length} assigned=${assigned.size} superOK=${!!classNode.superClass} renderOK=${classNode.body.body.some(m => m.type === "MethodDefinition" && m.kind === "method" && m.key?.name === "render")} intervalOK=${nodeHas(classNode, isSetIntervalCall)}\n`);
    }
  }
}
if (!widget) {
  process.stderr.write(
    `ERROR: no class matches the structural widget check (super + render + setInterval + ctor assigns >= 2 ctor params to fields)\n` +
      (widgetMissing ? `  (last candidate '${widgetMissing.name}' failed the structural check)\n` : "") +
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

// ---- Discover widget property names (AST, not hardcoded) ----------------
// The patch captures `this.<runtimeProp>` and `this.<shellStateProp>` so the
// sidecar can read context/session. The names are not stable across mcode
// versions, so we AST-walk the widget class for assignments of the form
// `this.X = param.runtime` / `this.X = param`, where `param` is the first
// constructor parameter. The X's become the discovered property names.
const isFirstCtorParam = (n) => {
  const ctor = widget.ctorMethod;
  if (!ctor || ctor.value.type !== "FunctionExpression") return false;
  const params = ctor.value.params;
  return params.length > 0 && n === params[0];
};
const discoverPropNames = () => {
  const ctor = widget.ctorMethod;
  if (!ctor || ctor.value.type !== "FunctionExpression") return { runtimeProp: null, shellStateProp: null };
  const ctorBody = ctor.value.body;
  // The widget constructor may have multiple params; mcode's widget
  // signature today is (shellState, runtime, requestRender). Scan all
  // ctor params and collect every `this.X = param.Y` / `this.X = param`
  // pair, keyed by param name.
  const paramNames = new Set();
  for (const p of ctor.value.params) {
    if (p && p.type === "Identifier") paramNames.add(p.name);
  }
  const fieldPairs = [];   // [{thisProp, rhsFieldName}]
  const selfPairs = [];    // [{thisProp, paramName}]
  function visit(n) {
    if (!n || typeof n !== "object" || !n.type) return;
    if (n.type === "AssignmentExpression" &&
        n.operator === "=" &&
        n.left.type === "MemberExpression" &&
        !n.left.computed &&
        n.left.object.type === "ThisExpression" &&
        n.left.property.type === "Identifier") {
      const thisProp = n.left.property.name;
      if (n.right.type === "MemberExpression" && !n.right.computed &&
          n.right.object.type === "Identifier" &&
          paramNames.has(n.right.object.name) &&
          n.right.property.type === "Identifier") {
        fieldPairs.push({ thisProp, rhsFieldName: n.right.property.name, paramName: n.right.object.name });
      } else if (n.right.type === "Identifier" && paramNames.has(n.right.name)) {
        selfPairs.push({ thisProp, paramName: n.right.name });
      } else if (n.right.type === "LogicalExpression") {
        visit(n.right.left); visit(n.right.right);
      } else if (n.right.type === "ConditionalExpression") {
        visit(n.right.consequent); visit(n.right.alternate);
      }
    }
    for (const k of Object.keys(n)) {
      if (k === "loc" || k === "start" || k === "end") continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === "object") visit(v);
    }
  }
  visit(ctorBody);

  // shellState: a `this.X = <param>` (self-shape) assignment where X is one
  // of the known shellState names. Fall back to PropertyDefinition
  // initializers that name a ctor param.
  let shellStateProp = null;
  for (const pref of ["shellState", "_shellState", "shell", "state", "ctx", "context"]) {
    const hit = selfPairs.find(p => p.thisProp === pref);
    if (hit) { shellStateProp = hit.thisProp; break; }
  }
  if (!shellStateProp) {
    for (const m of widget.classNode.body.body) {
      if (m.type !== "PropertyDefinition") continue;
      if (!m.key || m.key.type !== "Identifier") continue;
      if (m.value && m.value.type === "Identifier" && paramNames.has(m.value.name)) {
        shellStateProp = m.key.name; break;
      }
    }
  }

  // runtime: try self-shape first (param itself is the runtime object) then
  // field-shape (param.<something>). The LHS thisProp is what the patcher
  // needs; pick a known-good name if multiple candidates exist.
  const runtimeNamePriority = ["runtime", "_runtime", "rt", "tu", "r", "context", "ctx"];
  let runtimeProp = null;
  for (const pref of runtimeNamePriority) {
    const hit = selfPairs.find(p => p.thisProp === pref && p.thisProp !== shellStateProp);
    if (hit) { runtimeProp = hit.thisProp; break; }
  }
  if (!runtimeProp) {
    for (const pref of runtimeNamePriority) {
      const hit = fieldPairs.find(p => p.rhsFieldName === pref && p.thisProp !== shellStateProp);
      if (hit) { runtimeProp = hit.thisProp; break; }
    }
  }
  if (!runtimeProp) {
    for (const pref of runtimeNamePriority) {
      const hit = fieldPairs.find(p => p.thisProp === pref && p.thisProp !== shellStateProp);
      if (hit) { runtimeProp = hit.thisProp; break; }
    }
  }
  if (!runtimeProp) {
    for (const { thisProp } of [...selfPairs, ...fieldPairs]) {
      if (thisProp !== shellStateProp) { runtimeProp = thisProp; break; }
    }
  }
  return { runtimeProp, shellStateProp };
};
const { runtimeProp, shellStateProp } = discoverPropNames();

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
process.stdout.write(`RUNTIME_PROP=${sq(runtimeProp || "")}\n`);
process.stdout.write(`SHELLSTATE_PROP=${sq(shellStateProp || "")}\n`);
if (baseIsExternal) {
  process.stdout.write(`# BASE is in another chunk; not patched (WIDGET alone is enough)\n`);
} else {
  process.stdout.write(`# Class body span: ${widget.classNode.start}..${widget.classNode.end} (${widget.classNode.end - widget.classNode.start} bytes)\n`);
}
process.stdout.write(`# Render method span: ${widget.renderMethod ? `${widget.renderMethod.start}..${widget.renderMethod.end}` : "(none, will be added by patcher)"}\n`);
process.stdout.write(`# Constructor span: ${widget.ctorMethod.start}..${widget.ctorMethod.end}\n`);
process.stdout.write(`# Discovered runtime prop: ${runtimeProp || "(none)"}\n`);
process.stdout.write(`# Discovered shellState prop: ${shellStateProp || "(none)"}\n`);
process.stdout.write(`# Total classes discovered: ${classes.length}\n`);
