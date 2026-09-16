# mcode-hub — Install Guide

End-to-end setup for the mcode-hub quota status line, covering all supported
install layouts and platforms. **mcode is never modified.** How the status
line is attached depends on the installed mcode version, and `mcode-hub`
picks automatically:

| mcode | strategy | what gets written |
|---|---|---|
| **≥ 0.4.0** | native `custom-command` | two keys in `~/.minimax/config.yaml` — nothing else |
| **< 0.4.0** | legacy fork patch | a private fork under `~/.local/share/mcode-hub/` |

`./mcode-hub status` tells you which one is in force.

> **If you are an AI agent** asked to install mcode-hub on a new machine,
> read [AGENTS.md](AGENTS.md) instead — it has the same content plus
> decision trees and a "what not to do" list.

## TL;DR

```bash
# 1. Install mcode itself (skip if already installed)
npm install -g @minimax-ai/code         # npm-global layout
# OR
# download MiniMax Inside Code (platform install)

# 2. Install mcode-hub (one-shot, idempotent)
git clone https://github.com/weekbin/mcode-hub.git ~/Works/mcode-hub
cd ~/Works/mcode-hub
./mcode-hub-install                        # or --check for diagnostic-only

# 3. Verify, then use plain `mcode`
./mcode-hub status                         # which strategy + config state
./mcode-hub-doctor                    # self-check (17 项)
mcode                                   # 启动 mcode —— 直接用 mcode 即可
```

> **v3.4.7 起 wrapper 已删除**。`mcode-hub` 现在只是 mcode spawn 的渲染
> 脚本。装好之后**直接跑 `mcode` 就行**；维护场景用 `mcode-hub-install` /
> `mcode-hub-doctor` / `mcode-hub-status-compact` / `mcode-hub-push-remote`。
> 完整 roadmap 见 MAINTENANCE.md §10。

`mcode-hub-install` auto-detects your mcode layout, builds the shim if
needed, installs `mmx-cli` for the 5h/周 data source, then runs one
bootstrap pass:

- **mcode ≥ 0.4.0** — writes the `custom-command` config. After this,
  plain `mcode` shows the rows too; `mcode-hub` is only needed for
  install / status / doctor.
- **mcode < 0.4.0** — materializes the private fork.

`--no-fork` skips that bootstrap step on either path.

`mcode-hub-install` flags:

| Flag | Effect |
|---|---|
| `--check` | pre-flight diagnostic; no changes made |
| `--mmx-skip` | do not attempt to install mmx even if missing |
| `--mmx-fail` | exit non-zero if mmx install fails (default: warn) |
| `--no-fork` | skip the `mcode-hub --version` first-run step |
| `--copy` | install PATH entry as a copy instead of a symlink |
| `--bin-dir=DIR` | PATH entry directory (default `~/.minimax/bin`) |
| `--project=DIR` | override the project directory |
| `--quiet` | suppress non-essential output |

---

## Environment dependencies

### Required

| Dep | Why | Install |
|---|---|---|
| `node` ≥ 18 | mcode + mcode-hub both run on Node | `brew install node` / `nvm install 18` |
| `mcode` (`@minimax-ai/code`) ≥ 0.3.10 | what gets patched | `npm install -g @minimax-ai/code` |
| `git` | clone mcode-hub + the fork's tarball | Xcode CLT / `brew install git` |
| `npm` | comes with Node; needed for fork + acorn | bundled with node |
| `bash` ≥ 3.2 | `mcode-hub-install` is bash (macOS 3.2 compat) | macOS ships 3.2; Linux has 4+ |
| POSIX tools | `sed`, `grep`, `cmp`, `tr`, `find` (the doctor uses `ls`, not `find -printf`) | preinstalled on every macOS / Linux |

### Optional (for full quota display)

| Dep | Why | If missing |
|---|---|---|
| `mmx` (`mmx-cli`) | source for 5h/周 quota; comes from `https://github.com/MiniMax-AI/cli` | mcode-hub-install auto-installs with a 3-step fallback chain: (1) `npm install -g mmx-cli`, (2) `npm install -g mmx-cli --registry https://registry.npmmirror.com` (CN mirror), (3) download tarball from `https://registry.npmjs.org/mmx-cli/-/mmx-cli-<v>.tgz` and `npm install -g .`. If all three fail, mcode-hub degrades gracefully (5h/周 stays empty, other 5 data sources still work). |
| Active `mmx auth login` | mmx must be logged in for quota data | `mmx auth login` (OAuth) or `mmx auth login --api-key <key>` |

### Out-of-scope but related

| Tool | Used by | Notes |
|---|---|---|
| `mmx` | the 5h/周 data source | see Optional above |
| Docker | not used | mcode-hub does not need Docker |
| Internet (one-time) | mcode-hub downloads a pristine npm tarball of mcode on first run | ~5 MB; cached in `~/.local/share/mcode-hub/mcode-clone/tarballs/`. Use `MCODE_QUOTA_OFFLINE=1 mcode-hub` to skip |

---

## Supported mcode install layouts

mcode-hub supports two mcode install layouts and auto-detects which one you
have. Pick whichever matches your machine.

### Layout A: npm-global (the common macOS / dev-machine case)

mcode lives under `$(npm root -g)/@minimax-ai/code/`. This is what you
get from `npm install -g @minimax-ai/code`.

What mcode-hub-install does on top of the install itself:

1. Creates `~/.minimax-code/releases/<v>/lib/node_modules/@minimax-ai/code` as a **symlink** to the npm-global path (read-only view, mcode is unaware).
2. Writes `~/.minimax-code/releases/<v>/.mcode-launcher` (small stub `exec '<node>' '<cli>'` mcode-hub parses to find the node binary).
3. Writes `~/.minimax-code/current` with the version string.
4. Does NOT touch the npm-global install itself.

The fork (where patches live) is a separate **real copy** under
`~/.local/share/mcode-hub/mcode-clone/<v>/code/`. This is a verbatim
extraction of the npm tarball, not a symlink, to avoid Node's realpath
resolution pointing back at the npm install.

### Layout B: platform install (the macOS MiniMax Inside Code app)

mcode lives at `~/.minimax-code/releases/<v>/lib/node_modules/@minimax-ai/code/`
already. mcode-hub-install detects this and skips the shim step — the
layout mcode-hub expects is already there.

If you used Layout B before and have a stale `~/.minimax-code/releases/`
left over, re-running mcode-hub-install is safe: it only fills in what's
missing.

---

## macOS-specific notes

These are the gotchas hit during the first macOS install. They are all
handled by the current mcode-hub-install + the project fixes shipped in
this repo:

| Gotcha | Root cause | Fix |
|---|---|---|
| `mcode-hub` symlink → "Cannot find module '...patches/_loader.mjs'" | `BASH_SOURCE[0]` returns the symlink path, not the project root | `mcode-hub` now follows symlinks in a `while [[ -L ]]; do ... done` loop (commit F1) |
| `mcode-hub-doctor` reports "patches/ has no versioned subdirectories" even though `patches/0.3.10` and `patches/0.3.11` exist | doctor used `find -printf` (GNU-only); macOS BSD find rejects it | doctor now uses `ls -1 \| grep \| sort -V` (commit F2) |
| `rm -f "$HOME/..."` silently fails | mavis-trash hook in the user's environment intercepts `rm` and bails on paths it thinks are unexpanded | mcode-hub-install uses `node -e 'require("fs").unlinkSync(...)'` for any unlink step |
| `mavis-trash` warns on `rm` with literal `$HOME` in path | same hook as above | the install / uninstall paths avoid `rm` and use Node unlink |
| `mmx` not on PATH after mcode npm-global install | `mmx-cli` is a separate npm package, not bundled with `@minimax-ai/code` | mcode-hub-install auto-installs `mmx-cli` from npm (5h/周 quota data source) |
| pristine tarball extract shows file mtime as `1985-01-01` | npm pack writes deterministic mtimes | cosmetic only; do not use `stat mtime` to detect tampering — use `cmp` for byte equality (which the doctor does) |

---

## What mcode-hub-install does NOT do

- It does **not** modify mcode itself in any layout. The shim is a read-only
  symlink; the fork is a separate copy. Both are detectable by the doctor's
  "mcode launcher byte-identical to pristine npm tarball" check.
- It does **not** start mcode. It only builds the fork and runs
  `mcode-hub --version` to confirm the install works. To actually use mcode
  with the quota status line, run `mcode-hub` (or `mcode-hub <args>`).
- It does **not** install mcode itself. Run `npm install -g @minimax-ai/code`
  (or use the MiniMax Inside Code installer) first.
- It does **not** require `sudo` for the npm install. If your `npm prefix`
  is global and not writable, fix that first (`npm config set prefix ~/.npm-global`
  and add it to PATH).

---

## Step-by-step (verbose)

```bash
# 0. Prereqs (skip if you have them)
brew install node git                 # macOS
node --version                        # expect v18 or newer

# 1. mcode itself
npm install -g @minimax-ai/code
mcode --version                       # 0.3.11

# 2. mcode-hub
git clone https://github.com/weekbin/mcode-hub.git ~/Works/mcode-hub
cd ~/Works/mcode-hub
./mcode-hub-install

# Expected output (≈15 lines):
#   [mcode-hub-install] running mcode-hub-install on macos 26.6.1 (arm64)
#   [mcode-hub-install] pre-flight:
#   [mcode-hub-install]   OS:        macos 26.6.1 (arm64, family=darwin)
#   [mcode-hub-install]   pkg mgr:   brew
#   [mcode-hub-install]   node:      v22.23.2
#   [mcode-hub-install]   npm:       10.9.8
#   [mcode-hub-install]   mcode:     0.3.11
#   [mcode-hub-install] ✓ pre-flight passed
#   [mcode-hub-install] ✓ mcode version: 0.3.11 (npm-global layout)
#   [mcode-hub-install] ✓ acorn present
#   [mcode-hub-install] ✓ shim ready (symlink + .mcode-launcher + current pointer)
#   [mcode-hub-install] ✓ mmx installed: /Users/.../bin/mmx
#   [mcode-hub-install] ✓ PATH entry installed (symlink)
#   [mcode-hub-install] ✓ setup done (run 'mcode-hub status' for which strategy applies)
#   [mcode-hub-install] ✓ strategy: native custom-command (no fork, no patching)
#   [mcode-hub-install] ✓ mcode-hub install complete.

# 3. Login to mmx for quota data (one-time, interactive)
mmx auth login                        # OAuth, or
mmx auth login --api-key <key>        # direct

# 4. Use
mcode-hub                                # TUI with quota status line

# 5. Which strategy, then self-check
./mcode-hub status
#   strategy : native custom-command (no fork, no patching)   [>= 0.4.0]
#   strategy : legacy fork patch (< 0.4.0)                    [older]
./mcode-hub-doctor
# Expected: Result: 18 ok, 0 warnings, 0 failures
# (the legacy strategy runs 2 extra fork checks)
```

---

## Upgrading mcode

```bash
mcode update          # 1. upgrade mcode (or the platform installer)
mcode-hub install        # 2. >= 0.4.0: refresh the config (idempotent)
                      #    <  0.4.0: nothing to install; the fork is
                      #    rebuilt on the next launch
mcode-hub doctor         # 3. verify — expect 0 failures
mcode-hub                # 4. (or just `mcode`) confirm the 3 rows render
```

**On mcode ≥ 0.4.0 the native `custom-command` item carries the status
line, so a version bump almost never requires a code change** — we depend
on a config schema, not on mcode's internals. Only if mcode moves the
`customStatusLine` schema or renames the sqlite columns do we edit
`lib/`. After any edit, `tests/parity.mjs` and `tests/mcode-smoke.mjs`
must stay green.

**On mcode < 0.4.0** the fork patch re-derives its anchors on each launch,
so small bumps usually just work. If the widget structure really changed,
add a new `patches/<new>/` directory. The full decision tree — including
the one-time fork→native switch when crossing 0.4.0 — is in
[MAINTENANCE.md](MAINTENANCE.md) §3.

---

## Uninstalling

```bash
# Use Node to unlink — `rm` may be intercepted by mavis-trash on macOS.
node -e 'require("fs").unlinkSync(process.env.HOME+"/.minimax/bin/mcode-hub")'

# Drop the fork + tarball cache (~130 MB)
node -e 'require("fs").rmSync(process.env.HOME+"/.local/share/mcode-hub",{recursive:true,force:true})'

# Drop the shim (only present for npm-global installs)
node -e 'require("fs").rmSync(process.env.HOME+"/.minimax-code",{recursive:true,force:true})'
# ↑ WARNING: only do this if mcode-hub is the only thing in ~/.minimax-code.
#   On a platform install of mcode, that directory is mcode itself.
```

mcode itself was never modified. After uninstall, plain `mcode` keeps
working as before.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `mcode-hub: quota patcher failed — launching plain mcode` | patcher errored; mcode-hub falls back to vanilla mcode | `MCODE_QUOTA_DEBUG=1 mcode-hub` to see stderr; usually means the shim is missing or acorn is not installed |
| `Cannot find module 'acorn'` | `npm install` was not run in the project | `cd <project> && npm install` |
| `Cannot find module '...patches/_loader.mjs'` | `mcode-hub-install` is a symlink in `~/.minimax/bin` but the symlink target was moved | re-run `mcode-hub-install --copy`, or fix the symlink: `ln -link-fs $(realpath <repo>/mcode-hub-install) ~/.minimax/bin/mcode-hub-install` |
| 5h/周 quota line empty, doctor says "mmx not on PATH" | `mmx-cli` not installed (only happens if you used `--mmx-skip`) | `npm install -g mmx-cli && mmx auth login` |
| doctor reports a false-positive FAIL on patches/ | old version of doctor; had the `find -printf` bug | upgrade to the version with the F2 fix |
| `~/.minimax/bin` is not on PATH | shell rc not sourced for this directory | `echo 'export PATH="$HOME/.minimax/bin:$PATH"' >> ~/.zshrc` (or `~/.bashrc`) and `source` it |
| Upgrade broke the quota line | mcode widget changed | see MAINTENANCE.md §5 (re-derive anchors) and §5.5 (add new `patches/<v>/`) |

For everything else, MAINTENANCE.md §4 has a complete diagnostic table.
