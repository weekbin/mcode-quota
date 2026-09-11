# AGENTS.md — installing mcodex on a new machine

> **If you are an AI agent** asked to set up mcodex on a machine that does
> not have it yet, **read this file first.** It tells you exactly what to
> do, in what order, and how to recover when things go wrong.

## What mcodex is

A fork-isolated patcher for the mcode TUI: it adds a 3-line quota status
bar (会话 tokens / 上下文 / 5h/周 配额 / 今日按 LLM 模型) without ever
modifying mcode itself. All patches go into a private fork at
`~/.local/share/mcode-quota/mcode-clone/<v>/code/`. The doctor's core
invariant: **mcode's launcher is byte-identical to the npm pristine
tarball after install.**

## Quick path (one command, idempotent)

```bash
git clone https://github.com/weekbin/mcode-quota.git ~/Works/mcode-quota
cd ~/Works/mcode-quota
./mcodex-install
```

If that succeeds, you are done. If not, read §3.

For a non-destructive diagnostic, run `./mcodex-install --check` first.
It reports what is present, what is missing, and what would be installed,
without changing anything.

## What you may need to do manually

The install script handles ~95% of cases. The remaining 5% is when
**foundational tools are missing** — `node`, `npm`, `git`, `mcode`, or
`curl`. The install script reports the right install command per OS:

| OS family | `node` install |
|---|---|
| macOS | `brew install node` (or download from nodejs.org) |
| Debian / Ubuntu / Mint | `sudo apt-get install -y nodejs npm` |
| Fedora / RHEL / Rocky | `sudo dnf install -y nodejs npm` |
| Arch / Manjaro | `sudo pacman -S --noconfirm nodejs npm` |
| Alpine | `sudo apk add nodejs npm` |

After installing, re-run `./mcodex-install`.

`mcode` is not in the standard package managers. The supported install
methods are:

- **npm-global** (most common on dev machines): `npm install -g @minimax-ai/code`
- **platform** (macOS MiniMax Inside Code app): the official installer
  places it at `~/.minimax-code/releases/<v>/`

## Decision tree when things fail

```
mcodex-install failed
  │
  ├─ pre-flight says "node: MISSING"
  │    └─ install node + npm per OS table above, re-run
  │
  ├─ pre-flight says "mcode: MISSING"
  │    └─ run `npm install -g @minimax-ai/code`, re-run
  │
  ├─ "Cannot find module 'acorn'"
  │    └─ `cd <project> && npm install`, re-run
  │
  ├─ mmx install fails (5h/周 quota line stays empty)
  │    └─ manual: `npm install -g mmx-cli`
  │       (mmx-cli is at https://github.com/MiniMax-AI/cli)
  │       mcodex still works without mmx — 4 of 6 data sources
  │       (会话 tokens / 上下文 / 缓存命中 / 轮数 / 今日按模型) still show.
  │       Only 5h/周 quota is missing.
  │
  ├─ "Cannot find module '...patches/_loader.mjs'"
  │    └─ PATH entry is a symlink to the project but the installed
  │       mcodex is too old to follow symlinks. Either:
  │       a) update mcodex (`git pull` in the project) and re-run
  │       b) use a copy instead: `./mcodex-install --copy`
  │
  └─ doctor shows "mcode launcher differs from pristine npm tarball"
       └─ mcode itself was modified. The install script never touches
          mcode — either the user did, or an old mcodex version did.
          Restore mcode: see MAINTENANCE.md §6.
```

## How the install script decides what to do

1. **Detect OS + package manager** (`/etc/os-release` on Linux, `sw_vers`
   on macOS, `brew` detection on macOS). Output is shown at the start
   of every run.
2. **Pre-flight check** — reports presence + version of `node`, `npm`,
   `git`, `curl`, `mcode`, `mmx`. Aborts if any of `node`/`npm`/`git`/
   `mcode` is missing (suggests the install command for this OS).
3. **Locate mcode** — tries three paths in order:
   - `mcode` on PATH resolves to `$(npm root -g)/@minimax-ai/code` (npm-global)
   - `~/.minimax-code/releases/<v>/lib/node_modules/@minimax-ai/code`
     (platform install)
   - Walk the symlink chain of `which mcode` looking for any
     `@minimax-ai/code/package.json` (custom install paths)
4. **Build shim** — only for npm-global layout. Creates
   `~/.minimax-code/releases/<v>/` as a read-only symlink + a
   `.mcode-launcher` stub. Never writes to the npm-global install.
5. **Install project deps** — `npm install` in the project (acorn for
   the patcher). Skipped if already present.
6. **Install mmx** with a fallback chain:
   - Primary: `npm install -g mmx-cli`
   - Fallback A: `npm install -g mmx-cli --registry https://registry.npmmirror.com`
     (CN network workaround)
   - Fallback B: download the tarball directly from the npm registry,
     extract, and `npm install -g .` from the extracted dir (works
     even when the npm CLI itself is broken)
   - Final: warn and skip — mcodex works without mmx, the 5h/周 quota
     line degrades gracefully. Use `--mmx-fail` to make this an error
     instead.
7. **Install PATH entry** — symlink `~/.minimax/bin/mcodex` to the
   project's `mcodex` wrapper. Use `--copy` for a copy instead. The
   wrapper follows symlinks (commit F1), so a symlink is safe.
8. **First run** — `mcodex --version` to materialize the fork under
   `~/.local/share/mcode-quota/mcode-clone/<v>/code/`. Idempotent —
   re-running just re-checks byte equality.

## Cross-OS compatibility

The project targets **POSIX sh + bash 3.2+**. macOS ships bash 3.2; Linux
distros ship bash 4+ or 5+. Both work.

Explicitly avoided (would break on some OSes):

| GNU-only | Replacement in this project |
|---|---|
| `find -printf '%f\n'` | `ls -1 \| grep \| sort` (in doctor) |
| `sort -V` (numeric version) | `awk '{printf "%09d %09d %09d %s\n",...}' \| sort \| awk '{print $4}'` |
| `readlink -f` (resolve all symlinks) | `while [[ -L ]]; do readlink; done` loop |
| `stat -c '%Y'` | not used; `cmp` is the byte-equality primitive |
| `realpath` | not used |
| `column -t` | not used |

Explicitly avoided (environment-specific):

| Pitfall | Workaround |
|---|---|
| `rm` intercepted by `mavis-trash` or `trash` CLI | use `node -e 'require("fs").unlinkSync(...)'` for unlinks |
| npm not on PATH (e.g. nvm not sourced) | nvm-aware — if `mcode` resolves via `npm root -g`, npm is implicitly available |
| npm registry unreachable (CN network) | mirror fallback to `registry.npmmirror.com` |
| npm broken entirely | tarball fallback downloads directly from the npm registry over HTTPS |

## Idempotency

The script is safe to re-run. Each step first checks "is this already
done?" and skips if so. Re-running never overwrites mcode itself; it
only re-creates the read-only shim if missing.

## What you should NOT do as an agent

- Do **not** run `mcode update` on the user's behalf unless explicitly
  asked. It modifies mcode itself.
- Do **not** run `rm -rf` on `~/.local/share/mcode-quota/` or
  `~/.minimax-code/`. Use `node -e 'require("fs").rmSync(...)'`. The
  user may have other state in `~/.minimax-code/` (e.g. a platform
  mcode install).
- Do **not** modify files in the user's npm-global mcode. The shim
  already exposes it read-only.
- Do **not** commit anything to the mcode-quota repo without an
  explicit task. The repo is a personal mirror at
  `github.com/weekbin/mcode-quota`.

## Verifying success

After install, `./mcode-quota-doctor` should print:

```
Result: 21 ok, 0 warnings, 0 failures
```

Key items to look at:

- `mcode launcher pristine (no quota hooks)` — mcode is not modified
- `mcode launcher byte-identical to pristine npm tarball` — mcode is
  byte-identical to the official npm package
- `fork launcher render hook present` — patcher ran successfully
- `live render: ...` — sidecar can produce the quota line
- `mmx on PATH` and `mmx appears logged in` — 5h/周 quota will be
  visible

## References

- `README.md` — what the patch does, output examples, data sources
- `INSTALL.md` — human-facing install guide with all the detail
- `MAINTENANCE.md` — troubleshooting, anchor re-derivation, how to
  add a new mcode version
- `ARCHITECTURE.md` — design and isolation model
- `DECISIONS.md` — why each design choice was made
- `CHANGELOG.md` — every change to the toolset
