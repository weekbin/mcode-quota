# mcodex — mcode 状态栏配额 / token 用量

在 mcode TUI 状态栏下面显示：

- **5小时使用量** — 当前 5 小时窗口剩余百分比 + 进度条 + 重置倒计时
- **周使用量** — 当前周窗口剩余百分比 + 进度条 + 重置倒计时
- **会话 tokens** — 当前会话累计 token（输入 / 输出 / 缓存）
- **上下文** — 上下文窗口 **已用/总量 + 已用百分比**（如 `42K/200K 21%`），≥75% 变暗橙、≥90% 变暗红，提示该 `/compact` 了

数据来自 `mmx quota show` 和 mcode runtime / sqlite，全部带 24-bit 颜色分级。

## 核心设计：环境隔离，绝不改 mcode

早期版本直接 patch `~/.minimax-code` 里 mcode 本体的 launcher，结果一旦 patch 有 bug，
**用 mcode 排查问题时排查不到根源**，还会不断拉起僵尸进程。现在改成：

```
mcode 本体（只读，字节级等于 npm 官方包）
        ▲
        │ 从不写入
        │
mcodex ─┴─> 私有 fork：~/.local/share/mcode-quota/mcode-clone/<版本>/code/
             （从 npm 官方 tarball 解压出来的完整真实拷贝）
             └── 只在这里打两个 patch
```

- **mcode 本体永不被修改**。fork 是从 npm registry 下载的**干净 tarball**解压而来，
  不是从已安装目录复制（避免把污染带进 fork）。
- fork 是**真实拷贝**（不是 symlink）—— 避免 Node realpath 解析把相对 import 指回源安装。
- fork 坏了？直接删掉重新生成，mcode 毫发无损。
- `mcode-quota-doctor` 会校验 mcode launcher 与 npm 官方包**字节一致**。

## 入口

```bash
mcodex            # 任何目录都可以（~/.minimax/bin/mcodex 在 PATH 上）
mcodex --help
```

`mcodex` 做的事：
1. 读 `~/.minimax-code/current` 拿当前版本
2. 跑 `mcode-patch-quota.mjs`（幂等，已就绪时 <1s）
3. `exec <mcode 官方 node> <fork>/code/cli.js "$@"`

patcher 失败时自动回退到**未打 patch 的官方 mcode**，不会卡住你。

## 效果

**宽终端（≥150 列）** — 单行横排，保留 `输入/输出/缓存` 明细：

```
~/projects/... │ Permissions │ ✦ model
5小时使用量 [████████████████░░░░] 79% 剩余  │  周使用量 [█████████████████░░░] 86% 剩余  │  会话 tokens 220.4M (输入 3.96M │ 输出 626K │ 缓存 215.2M)  │  上下文 42K/200K 21%
```

**中等宽度（128–149 列）** — 两行，周行与 tail 合并（明细保留）：

```
5小时使用量 [████████████████░░░░] 79% 剩余  │ 重置 2h 23m
周使用量 [█████████████████░░░] 86% 剩余  │ 重置 5d 6h  │  会话 tokens 220.4M (输入 3.96M │ 输出 626K │ 缓存 215.2M)  │  上下文 42K/200K 21%
```

**较窄（81–127 列）** — 三行（明细保留）：

```
5小时使用量 [████████████████░░░░] 79% 剩余  │ 重置 2h 23m
周使用量 [█████████████████░░░] 86% 剩余  │ 重置 5d 6h
会话 tokens 220.4M (输入 3.96M │ 输出 626K │ 缓存 215.2M)  │  上下文 42K/200K 21%
```

**很窄（≤80 列）** — 三行，明细放不下时才退化为紧凑 tail：

```
5小时使用量 [████████████████░░░░] 79% 剩余  │ 重置 2h 23m
周使用量 [█████████████████░░░] 86% 剩余  │ 重置 5d 6h
会话 tokens 220.4M  │  上下文 42K/200K 21%
```

行数由**内容实际宽度**决定，不是固定区间：进度条先从 20 收缩到 8，仍放不下才拆行。
CJK 字符按 2 列计算宽度。**明细优先于行数**——只有连一整行都放不下时才会丢掉明细。

想反过来（宁可丢明细也要保住一行），设 `MCODE_QUOTA_TAIL=compact`。

**颜色（按剩余百分比分级）**：

| 剩余 | 颜色 | RGB |
|---|---|---|
| > 50% | 深绿 | `(60,160,90)` |
| 21–50% | 暗橙 | `(200,150,40)` |
| ≤ 20% | 暗红 | `(200,80,80)` |
| 无数据 | 灰 | `(140,140,140)` |

## 文件

```
/home/weekbin/orca/projects/mcode/mcode-quota/   # 工具集（git 仓库，single source of truth）
├── mcodex                       # 入口 wrapper
├── mcode-patch-quota.mjs        # 构建 fork + 打 patch + 生成 sidecar
├── mcode-find-anchors.mjs       # acorn AST 锚点发现器
├── mcode-quota-doctor           # 自检（17 项）
├── sidecar/                     # patcher 生成的 sidecar（不要手改）
└── README / ARCHITECTURE / DECISIONS / MAINTENANCE / CHANGELOG

~/.minimax/bin/mcodex                                            # PATH 入口（250 字节 stub）
~/.local/share/mcode-quota/mcode-clone/tarballs/                 # 官方 tarball 缓存
~/.local/share/mcode-quota/mcode-clone/.pristine-<版本>/         # 解压出的纯净源码
~/.local/share/mcode-quota/mcode-clone/<版本>/code/              # 打了 patch 的 fork
```

## 安装 / 使用

```bash
# 首次：什么都不用手动做，直接跑（会自动下载 tarball 并建 fork）
mcodex

# 自检
/home/weekbin/orca/projects/mcode/mcode-quota/mcode-quota-doctor
```

## 升级 mcode

```bash
mcode update      # 官方升级
mcodex            # 直接跑：检测到版本变化会自动重新下载 tarball、重建 fork
mcode-quota-doctor
```

不需要手动跑 patcher，`mcodex` 每次启动都会做幂等检查。

## 数据源与刷新

| 数据 | 来源 | TTL | 超时 |
|---|---|---|---|
| 5小时 / 周使用量 | `mmx quota show --output json --quiet` | 60s | 20s |
| 会话 tokens | runtime `getSessionUsageSummary` → sqlite `local_runtime_token_usage` 兜底 | 10s | — |
| 上下文 | shellState `contextUsage`（runtime `getContextSnapshot`，mcode 自己的 `Context N% left` 用的同一份数据） | 随渲染实时读取 | — |

会话 token 总量 = `input_tokens + output_tokens + cache_read_tokens`。

**上下文显示** = `已用/总量 百分比`，例如 `上下文 42K/200K 21%`。

- 百分比 = `round(usedTokens / contextWindowTokens × 100)`，取**已用**占比
  （mcode 原生显示的是剩余占比，这里取补数，因为"涨到 100% 就该压缩了"更直观）
- 窗口大小优先取 `contextUsage.contextWindowTokens`，缺失时回落 shellState 顶层的 `contextWindowTokens`
- 数字用与 `会话 tokens` 相同的格式化（`1M` / `1.5M` / `200K` / `42K`）

**兜底逻辑**：runtime API 有时在 turn 落库前返回全 0，或返回结构不符预期。
此时会自动回落到 sqlite；只有两边都没有真实数字时才显示 0。

## 为什么不会再有僵尸进程风暴

旧版本用 `NODE_OPTIONS=--import=<sidecar>` 注入，**这个环境变量会被 mcode 派生的每一个子进程继承**，
每个子进程都启动一个 `mmx` 轮询器 → 进程数指数级爆炸。

现在：

1. **不用 `NODE_OPTIONS`** —— sidecar 由 fork 的 `cli.js` 静态 `import`，只有 TUI 入口进程会加载它。
2. **sidecar 不自动启动** —— 轮询器在**第一次状态栏渲染**时才启动（这是"真的是 TUI"的可靠信号）。
   子进程即使加载了 sidecar 也不会 fork 任何东西。
3. **进程防护** —— `spawn(detached:true)` + 进程组 SIGKILL 兜底；PATH 上没 `mmx` 直接跳过；
   连续失败 5 次后停用，5 分钟后自动恢复；stderr 截断 64KB。

## 已知 trade-offs

- 每 60s fork 一次 `mmx`（约 5s，可忽略；`unref` 的定时器不阻止退出）
- 首次渲染时 quota 行可能先空约 1–6s，数据到达后自动重绘
- 24-bit 颜色需要终端支持（现代终端都支持）
- `mmx` 是外部依赖：不在 PATH 或未登录时，只显示会话 tokens / 上下文行
- 自动化测试用 `script -qfc` 起的伪 TTY 默认 80 列，会落到三行紧凑布局；
  想看单行带明细的效果，用真实终端或把 pty 窗口设成 ≥150 列

## 文档

| 文档 | 内容 |
|---|---|
| [README.md](README.md) | 怎么用、效果、数据源、trade-off |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 隔离架构、两处 patch、sidecar 数据流、排版 |
| [DECISIONS.md](DECISIONS.md) | **方案与决策记录**：每个设计问题的候选、选择、理由、代价、证据 |
| [MAINTENANCE.md](MAINTENANCE.md) | 故障诊断、重派生锚点、还原 mcode |
| [CHANGELOG.md](CHANGELOG.md) | 每次改动记录 |
