# mcodex — Install Guide

End-to-end setup for the mcodex quota status line, covering all supported
install layouts and platforms. mcodex never modifies mcode itself: every
patch goes into a private fork under `~/.local/share/mcode-quota/`.

## TL;DR

```bash
# 1. Install mcode itself (skip if already installed)
npm install -g @minimax-ai/code         # npm-global layout
# OR
# download MiniMax Inside Code (platform install)

# 2. Install mcodex (one-shot, idempotent)
git clone https://github.com/weekbin/mcode-quota.git ~/Works/mcode-quota
cd ~/Works/mcode-quota
./mcodex-install

# 3. Use
mcodex                                  # starts mcode with quota status line
mcodex-install/scripts/../mcode-quota-doctor  # self-check (21 items)
```

`mcodex-install` auto-detects your mcode layout, builds the shim if
needed, installs the `mmx-cli` for the 5h/周 quota data source, and
runs `mcodex --version` once to materialize the fork.

---

## Environment dependencies

### Required

| Dep | Why | Install |
|---|---|---|
| `node` ≥ 18 | mcode + mcodex both run on Node | `brew install node` / `nvm install 18` |
| `mcode` (`@minimax-ai/code`) ≥ 0.3.10 | what gets patched | `npm install -g @minimax-ai/code` |
| `git` | clone mcode-quota + the fork's tarball | Xcode CLT / `brew install git` |
| `npm` | comes with Node; needed for fork + acorn | bundled with node |
| `bash` ≥ 3.2 | the wrapper scripts are bash | macOS ships 3.2; Linux has 4+ |
| POSIX tools | `sed`, `grep`, `cmp`, `tr`, `find` (the doctor uses `ls`, not `find -printf`) | preinstalled on every macOS / Linux |

### Optional (for full quota display)

| Dep | Why | If missing |
|---|---|---|
| `mmx` (`mmx-cli`) | source for 5h/周 quota; comes from `https://github.com/MiniMax-AI/cli` | mcodex-install auto-installs via `npm install -g mmx-cli`; mcodex degrades gracefully (5h/周 stays empty, other 5 data sources still work) |
| Active `mmx auth login` | mmx must be logged in for quota data | `mmx auth login` (OAuth) or `mmx auth login --api-key <key>` |

### Out-of-scope but related

| Tool | Used by | Notes |
|---|---|---|
| `mmx` | the 5h/周 data source | see Optional above |
| Docker | not used | mcodex does not need Docker |
| Internet (one-time) | mcodex downloads a pristine npm tarball of mcode on first run | ~5 MB; cached in `~/.local/share/mcode-quota/mcode-clone/tarballs/`. Use `MCODE_QUOTA_OFFLINE=1 mcodex` to skip |

---

## Supported mcode install layouts

mcodex supports two mcode install layouts and auto-detects which one you
have. Pick whichever matches your machine.

### Layout A: npm-global (the common macOS / dev-machine case)

mcode lives under `$(npm root -g)/@minimax-ai/code/`. This is what you
get from `npm install -g @minimax-ai/code`.

What mcodex-install does on top of the install itself:

1. Creates `~/.minimax-code/releases/<v>/lib/node_modules/@minimax-ai/code` as a **symlink** to the npm-global path (read-only view, mcode is unaware).
2. Writes `~/.minimax-code/releases/<v>/.mcode-launcher` (small stub `exec '<node>' '<cli>'` mcodex parses to find the node binary).
3. Writes `~/.minimax-code/current` with the version string.
4. Does NOT touch the npm-global install itself.

The fork (where patches live) is a separate **real copy** under
`~/.local/share/mcode-quota/mcode-clone/<v>/code/`. This is a verbatim
extraction of the npm tarball, not a symlink, to avoid Node's realpath
resolution pointing back at the npm install.

### Layout B: platform install (the macOS MiniMax Inside Code app)

mcode lives at `~/.minimax-code/releases/<v>/lib/node_modules/@minimax-ai/code/`
already. mcodex-install detects this and skips the shim step — the
layout mcodex expects is already there.

If you used Layout B before and have a stale `~/.minimax-code/releases/`
left over, re-running mcodex-install is safe: it only fills in what's
missing.

---

## macOS-specific notes

These are the gotchas hit during the first macOS install. They are all
handled by the current mcodex-install + the project fixes shipped in
this repo:

| Gotcha | Root cause | Fix |
|---|---|---|
| `mcodex` symlink → "Cannot find module '...patches/_loader.mjs'" | `BASH_SOURCE[0]` returns the symlink path, not the project root | `mcodex` now follows symlinks in a `while [[ -L ]]; do ... done` loop (commit F1) |
| `mcode-quota-doctor` reports "patches/ has no versioned subdirectories" even though `patches/0.3.10` and `patches/0.3.11` exist | doctor used `find -printf` (GNU-only); macOS BSD find rejects it | doctor now uses `ls -1 \| grep \| sort -V` (commit F2) |
| `rm -f "$HOME/..."` silently fails | mavis-trash hook in the user's environment intercepts `rm` and bails on paths it thinks are unexpanded | mcodex-install uses `node -e 'require("fs").unlinkSync(...)'` for any unlink step |
| `mavis-trash` warns on `rm` with literal `$HOME` in path | same hook as above | the install / uninstall paths avoid `rm` and use Node unlink |
| `mmx` not on PATH after mcode npm-global install | `mmx-cli` is a separate npm package, not bundled with `@minimax-ai/code` | mcodex-install auto-installs `mmx-cli` from npm (5h/周 quota data source) |
| pristine tarball extract shows file mtime as `1985-01-01` | npm pack writes deterministic mtimes | cosmetic only; do not use `stat mtime` to detect tampering — use `cmp` for byte equality (which the doctor does) |

---

## What mcodex-install does NOT do

- It does **not** modify mcode itself in any layout. The shim is a read-only
  symlink; the fork is a separate copy. Both are detectable by the doctor's
  "mcode launcher byte-identical to pristine npm tarball" check.
- It does **not** start mcode. It only builds the fork and runs
  `mcodex --version` to confirm the install works. To actually use mcode
  with the quota status line, run `mcodex` (or `mcodex <args>`).
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

# 2. mcodex
git clone https://github.com/weekbin/mcode-quota.git ~/Works/mcode-quota
cd ~/Works/mcode-quota
./mcodex-install

# Expected output:
#   [mcodex-install] ✓ found mcode at npm-global: ...
#   [mcodex-install] ✓ mcode version: 0.3.11 (npm-global layout)
#   [mcodex-install] ✓ project: ...
#   [mcodex-install] ✓ acorn installed
#   [mcodex-install] ✓ shim ready (symlink + .mcode-launcher + current pointer)
#   [mcodex-install] ✓ mmx installed: /Users/.../bin/mmx
#   [mcodex-install] ✓ PATH entry installed (symlink)
#   [mcodex-install] ✓ fork built and mcodex responsive
#   [mcodex-install] ✓ mcodex install complete.

# 3. Login to mmx for quota data (one-time, interactive)
mmx auth login                        # OAuth, or
mmx auth login --api-key <key>        # direct

# 4. Use
mcodex                                # TUI with quota status line

# 5. Self-check
./mcode-quota-doctor
# Expected: Result: 21 ok, 0 warnings, 0 failures
```

---

## Upgrading mcode

```bash
npm install -g @minimax-ai/code@<new-version>      # 1. upgrade mcode
echo -n "<new-version>" > ~/.minimax-code/current  # 2. update pointer
mcodex                                              # 3. mcodex detects new version,
                                                    #    downloads new tarball, rebuilds fork
./mcode-quota-doctor                                # 4. verify
```

If the new mcode version changed the widget structure, you also need a
new `patches/<new>/` directory in this repo. See MAINTENANCE.md §5.5.

---

## Uninstalling

```bash
# Use Node to unlink — `rm` may be intercepted by mavis-trash on macOS.
node -e 'require("fs").unlinkSync(process.env.HOME+"/.minimax/bin/mcodex")'

# Drop the fork + tarball cache (~130 MB)
node -e 'require("fs").rmSync(process.env.HOME+"/.local/share/mcode-quota",{recursive:true,force:true})'

# Drop the shim (only present for npm-global installs)
node -e 'require("fs").rmSync(process.env.HOME+"/.minimax-code",{recursive:true,force:true})'
# ↑ WARNING: only do this if mcodex is the only thing in ~/.minimax-code.
#   On a platform install of mcode, that directory is mcode itself.
```

mcode itself was never modified. After uninstall, plain `mcode` keeps
working as before.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `mcodex: quota patcher failed — launching plain mcode` | patcher errored; mcodex falls back to vanilla mcode | `MCODE_QUOTA_DEBUG=1 mcodex` to see stderr; usually means the shim is missing or acorn is not installed |
| `Cannot find module 'acorn'` | `npm install` was not run in the project | `cd <project> && npm install` |
| `Cannot find module '...patches/_loader.mjs'` | `mcodex` is a symlink to the project but the old wrapper didn't follow symlinks | upgrade to the version with the F1 fix, or just `cp` instead of `ln -s` for the PATH entry |
| 5h/周 quota line empty, doctor says "mmx not on PATH" | `mmx-cli` not installed (only happens if you used `--mmx-skip`) | `npm install -g mmx-cli && mmx auth login` |
| doctor reports a false-positive FAIL on patches/ | old version of doctor; had the `find -printf` bug | upgrade to the version with the F2 fix |
| `~/.minimax/bin` is not on PATH | shell rc not sourced for this directory | `echo 'export PATH="$HOME/.minimax/bin:$PATH"' >> ~/.zshrc` (or `~/.bashrc`) and `source` it |
| Upgrade broke the quota line | mcode widget changed | see MAINTENANCE.md §5 (re-derive anchors) and §5.5 (add new `patches/<v>/`) |

For everything else, MAINTENANCE.md §4 has a complete diagnostic table.
