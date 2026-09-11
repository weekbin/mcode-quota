# AGENTS.md — installing mcodex on a new machine

> **If you are an AI agent** asked to set up mcodex on a machine that does
> not have it yet, **read this file first.** It tells you exactly what to
> do, in what order, and how to recover when things go wrong.

## What mcodex is

Adds a 3-line quota / token status block under mcode's status bar
(会话 tokens + 上下文 / 5h-周 limits / 今日 per-LLM-model totals) **without
ever modifying mcode itself.**

There are two strategies, picked automatically from the installed mcode
version — do not assume the fork one:

| mcode | strategy | how it works |
|---|---|---|
| **≥ 0.4.0** | **native (default now)** | mcodex merges `tui.statusLine` + `tui.customStatusLine` into `~/.minimax/config.yaml`; mcode's own `custom-command` status item then runs `<repo>/mcodex-status` (stdin JSON in, up to 5 stdout lines out). No fork, no patching, nothing to rebuild. |
| **< 0.4.0** | legacy fork | `patches/_loader.mjs` picks `patches/<version>/` and patches a private pristine fork at `~/.local/share/mcode-quota/mcode-clone/<v>/code/`. |

Both paths share one renderer (`lib/render.mjs`); `tests/parity.mjs` asserts
their output is byte-identical. The doctor's core invariant for **both**:
**mcode's own installation is unmodified** — on the native path it is not
even opened for writing.

Check which one applies before doing anything:

```bash
./mcodex status
```

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
  ├─ native path (>= 0.4.0) shows no status block at all
  │    ├─ `mcodex status` says "config applied: no"
  │    │    └─ `mcodex install` (idempotent; rewrites only its own keys)
  │    ├─ `mcodex status` says yes, but still nothing
  │    │    └─ `mcodex doctor`; check the statusLine / command items.
  │    │       Then feed the script a payload by hand:
  │    │       printf '{"protocol":1,"event":"interval","session_id":"<mvs_…>",
  │    │         "workspace_dir":"/tmp","model":"-","tui_version":"0.4.0"}\n'
  │    │         | COLUMNS=200 ./mcodex-status
  │    │       Output => mcode side. No output => MCODEX_STATUS_DEBUG=1 for why.
  │    └─ config was rewritten by mcode → just `mcodex install` again
  │
  └─ doctor shows "mcode launcher differs from pristine npm tarball"
       └─ mcode itself was modified. Neither strategy writes to mcode —
          the native one does not even open it. Either the user did, or
          an old mcodex version did. Restore: MAINTENANCE.md §6.
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
   wrapper resolves symlinks before deriving its project root
   (BASH_SOURCE[0] alone would yield the symlink's directory), so a
   symlink is safe.
8. **First run** — `mcodex --version`. What that does depends on the
   detected version:
   - **≥ 0.4.0 (native)**: writes the two `custom-command` keys into
     `~/.minimax/config.yaml` and execs stock mcode. No fork is created.
   - **< 0.4.0 (legacy)**: materializes the fork under
     `~/.local/share/mcode-quota/mcode-clone/<v>/code/`.
   Either way it is idempotent — re-running only re-checks equality.

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
- Do **not** hand-edit `~/.minimax/config.yaml` to add or remove the
  `custom-command` / `customStatusLine` keys — run `mcodex install` /
  `mcodex uninstall`. They edit only those keys, keep every comment and
  the surrounding layout, and round-trip byte-identically; a manual edit
  easily corrupts a file the user has tuned.
- Do **not** force-push the mirror. If the remote has moved ahead (for
  example another machine pushed), `mcodex-push-remote` fetches and
  merges with `-s ours`, preserving the other side's commits.

## Verifying success

Run `./mcodex status` first — it names the strategy in force:

```
mcodex status
  mcode version   : 0.4.0
  strategy        : native custom-command (no fork, no patching)
  config applied  : yes
```

Then `./mcode-quota-doctor`. It runs the check set for the detected
strategy and should end with:

```
Result: 18 ok, 0 warnings, 0 failures
```

**Native path (≥ 0.4.0)** — items to look at:

- `mcode launcher pristine (no quota hooks)` — mcode unmodified
- `config present: ~/.minimax/config.yaml` — mcodex's config is there
- `statusLine includes custom-command` — our item is wired in
- `customStatusLine.command executable: …/mcodex-status`
- `maxLines = 3` / `colorMode = ansi`
- `live render: 会话 tokens …` — the script answers a synthetic payload
- `parity with legacy fork renderer: 19 pass, 0 fail`
- `mmx on PATH` / `mmx appears logged in` — 5h/周 quota will be visible

Startup is triggered by mcode: if the block is briefly empty right after
launch that is the 10 s tick, not a failure.

**Legacy path (< 0.4.0)** — additionally:

- `fork launcher render hook present` — the patcher ran
- `fork cli.js imports sidecar statically`
- `mcode launcher byte-identical to pristine npm tarball`

## Upgrading mcode later (what an agent should do)

`mcode update && mcodex install && mcodex doctor`. On the native path
that is almost always the whole job — the full playbook, including when
code changes *are* needed, is MAINTENANCE.md §3. Read it before editing
anything. After any code change, `tests/parity.mjs` and
`tests/mcode-smoke.mjs` must both be green.

## References

- `README.md` — what the patch does, output examples, data sources
- `INSTALL.md` — human-facing install guide with all the detail
- `MAINTENANCE.md` — **§3 is the upgrade playbook**: what to do when
  mcode gets a new version, on either strategy; plus troubleshooting and
  anchor re-derivation
- `ARCHITECTURE.md` — design and isolation model
- `DECISIONS.md` — why each design choice was made
- `CHANGELOG.md` — every change to the toolset
