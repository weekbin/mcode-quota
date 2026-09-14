# Release v3.4 — mcode 0.4.x 兼容 + 维护期优化

> 2026-09-14 · 5 commits · 8 files · +449 / -28

## 一句话总结

mcode ≥ 0.4.0 走 **native `tui.customStatusLine` 路径**(只写 config.yaml,
mcode 自己 spawn mcodex-status),`mcodex` wrapper 启动 deprecation;同时把
statusline 数据刷新率原则显式化:**远程 API 节流,本地 sqlite 实时**。

## 5 个 commit

| # | hash | version | 主题 |
|---|---|---|---|
| 1 | `1b3ad23` | v3.4.0 | `mcodex` wrapper 启动-mode deprecation warning;`mcode` 成为唯一起动命令 |
| 2 | `ee57118` | v3.4.1 | `fetchTodayByModel` warmed 路径 TTL early-return;省 58K-row scan + 写盘 |
| 3 | `2e59bb7` | v3.4.2 | 轮数改 `COUNT(DISTINCT turn_id FROM local_runtime_message_rows WHERE role='user')`;剔除 mcode 内部 warmup turn |
| 4 | `6924560` | v3.4.3 | `QUOTA_TTL_MS` 60s → 5min;`mmx quota show` 启动频次 6/min → 1/5min |
| 5 | `3236468` | v3.4.4 | warmed 路径去掉 60s TTL 限制;本地 sqlite 实时,新 turn 下一个 10s tick 立刻反映 |

## v3.4.0 — `mcodex` wrapper deprecation

**Why**: mcode ≥ 0.4.0 走 native `tui.customStatusLine.command`,写一份
`~/.minimax/config.yaml` 即可,mcode 自己 spawn `mcodex-status`,不 fork、
不 patch mcode。`mcodex` wrapper 启动脚本失去"补 config"的核心价值(只
剩 install / uninstall / status / doctor 等维护子命令)。

**What**:
- `mcodex` 启动时打 deprecation warning,**仍 exec mcode**(保持兼容)
- `--no-deprecation-warning` / `MCODEX_NO_DEPRECATION_WARNING` 静默选项
- `install` / `uninstall` / `status` / `doctor` 子命令静默(无 warning)
- 三阶段路线图(MAINTENANCE.md §10):
  - **v3.4**: 警告(当前)
  - **v3.5**: install 默认不装 symlink
  - **v4.0**: 删除 wrapper
- AGENTS.md / INSTALL.md / README.md / ARCHITECTURE.md 全部以 `mcode`
  为主线;`mcodex` 退到 install / maintenance 边缘

**为什么不能一步到位**: wrapper 仍承担"刚 `mcode update` 完自动补
`customStatusLine`"的 safety net,legacy fork (< 0.4.0) 还在产线。

## v3.4.1 — `fetchTodayByModel` warmed 路径 TTL early-return

**Why**: v3.3.3 修 picker 屏后,`collect({ sessionId: "" })` 在无 sessionId
时也跑 — 也就是 picker / welcome 屏每 10s tick 都触发,`fetchTodayByModel`
走 warmed 路径但仍每次重跑 58K-row scan + 写盘。**v3.4.0 之后** mcode
成为唯一起动命令,warmed 路径每次 10s tick 全表扫更明显卡。

**What**: warmed + `rows.length === 0` + 60s 内 + items 有 → return 缓存,
跳过 58K scan + 写盘。冷启动路径保留 60s 兜底(全表扫慢)。

## v3.4.2 — 轮数算法

**Why**: 旧逻辑 `COUNT(DISTINCT turn_id) FROM local_runtime_token_usage`
是"该 session 消耗过 token 的 turn 数"。mcode 0.4.x `pi-agent` 在某些
session 里会**额外写一个 warmup turn**(`turn_e0c2c16f-...`,2 token rows,
0 user message,0 assistant message),导致 token_turns 比 user_turns 多 1。

8-session 抽查:2/8 有 +1 异常(25%),6/8 一致。**用户预期是"我发了几个
prompt"**,不是"该 session 消耗过 token 的 turn 数"。

**What**: 改 `COUNT(DISTINCT turn_id) FROM local_runtime_message_rows
WHERE role='user'`,以用户视角的 prompt 数为准,warmup turn 自动剔除。
fallback 到 `token_turns` 当 `user_turns = 0`(空 session 不显示 0)。

## v3.4.3 — 5h·周 quota TTL 60s → 5min

**Why**: `mmx quota show` 远程 CLI,启动频次 6/min(每 10s tick 一次,
60s 内必触发),每次 spawn node + JSON 解析 + 磁盘 I/O。但 5h 滚动窗口
以分钟级变化,周限制以小时级变化,1 分钟粒度对用户视觉无意义。

**What**: `QUOTA_TTL_MS` 默认 60_000 → 300_000。`mmx quota show` 启动
频次 6/min → 1/5min。env `MCODE_QUOTA_TTL_MS=60000` 可压回 60s。

| 指标 | 60s TTL | 5min TTL |
|---|---|---|
| `mmx quota show` 启动频次 | 6 次/分钟 | 1 次 / 5 分钟 |
| statusline 5h·周 行新数据延迟 | ≤ 1 分钟 | ≤ 5 分钟(视觉无感) |

## v3.4.4 — 远程节流 / 本地实时原则

**Why**: v3.4.1 当时为了省 warmed 路径的 58K scan 写盘,把所有 warmed
无新行命中都加 60s early-return。但代价是 today 数据最差能 stale 60s
— 跟"本地 sqlite 应该实时刷新"的预期相悖。

**核心原则(显式化)**:
- **远程 API** (mmx CLI / 网络) — 3-5min 节流,数据本身以分钟/小时变化,
  频于其变化率的查询只是进程开销
- **本地 sqlite** — 尽量实时。`message_rows` / `token_usage` 按 turn_id
  同步追加,增量扫描 `id > lastId` 是主键范围 SEARCH(sub-ms),无新行就
  0 写盘

**What**: warmed 路径去掉 60s TTL 限制,无新 message row 直接 return
缓存;`MCODE_QUOTA_TODAY_TTL_MS` 仍生效但只影响冷启动路径(全表扫
兜底)。

**冒烟测试证据**(注入 1.5M test turn):

| 时刻 | 操作 | today total |
|---|---|---|
| T+0 | 注入前 | 15,280,739 |
| T+1 | 注入 1.5M(1M in + 200K out + 300K cache read) | — |
| T+2 | 单次 `mcodex-status` | **15,351,817** (delta = +71,078) |
| — | 加上 1.5M 注入(下一次 tick 反映) | **16,924,316** (delta = +1,572,499) |

**新 turn 在下一个 10s tick 立刻反映**(不是 60s 后)。

## 兼容性矩阵

| mcode version | 启动命令 | strategy | 行为 |
|---|---|---|---|
| **≥ 0.4.0** | `mcode` (推荐) / `mcodex` (有 deprecation 警告) | native | 写 `~/.minimax/config.yaml`,mcode 自己 spawn mcodex-status |
| < 0.4.0 | `mcodex` (still required) | legacy fork | `patches/_loader.mjs` 选 `patches/<version>/`,patcher 在 `~/.local/share/mcode-quota/mcode-clone/<v>/code/` 构私有 fork |

两条路径共用 `lib/render.mjs`;`tests/parity.mjs` 断言输出逐字节一致。

## 文件改动汇总

```
AGENTS.md       |  35 +/-     # "What mcodex is" 重写,以 mcode 为主线
ARCHITECTURE.md |  37 +       # 启动路径图重画,mcodex 退到维护框
CHANGELOG.md    | 216 +       # 5 条 v3.4.x 条目
INSTALL.md      |  11 +/-     # TL;DR 第 3 步 mcodex → mcode
MAINTENANCE.md  |  77 +       # §10 deprecation 路线图
README.md       |  15 +/-     # 快速开始段调整
lib/data.mjs    |  60 +/-     # TTL 默认值 + warmed 路径优化 + 顶部原则注释
mcodex          |  26 +       # deprecation warning
8 files changed, 449 insertions(+), 28 deletions(-)
```

## 上游 / 验证

- **`mcodex doctor` / `mcode-quota-doctor`**: 17 ok, 0 warnings, 0 failures
- **`mcode --version`**: 0.4.1
- **本机 mcode TUI 实际渲染** (session `mvs_9ab7f891fdd3438f90f57cde67d3fc38`):
  ```
  会话 tokens 82.04M 「输入 2.42M │ 输出 214.43K │ 缓存 79.40M」│ 上下文 10%「51.08K/512.00K」│ 缓存命中 97%│ 轮数 23
  小时会话窗口 [███████████████████░] 94% 剩余 │ 重置 4h 9m │ 周限制使用量 [████████████████████] 99% 剩余 │ 重置 6d 13h
  今日 「MiniMax-M3」 14.59M
  ```

## 升级指南 (从 v3.3.x / 老 mcodex 用法)

```bash
cd ~/Works/mcode-quota  # 或 mcodex 项目根
git pull                 # 拉 v3.4.x
./mcodex-install         # 重新装,首次会装 symlink,后续 idempotent
mcode                    # 用 mcode,不用 mcodex
mcodex doctor            # 仍可用,但只是维护期诊断
```

新 install 用户: 直接 `mcode` 即可,**不**需要 `mcodex` wrapper。
