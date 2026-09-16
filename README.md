# mcode-hub — mcode 配额 / token 状态栏

在 mcode 的状态栏下方显示 3 行：

```
~/orca/projects/mcode-hub │ ◇ 打招呼 │ ⎇ master │ Full access │ ✦ MiniMax-M3 · Thinking On │ Context 95% left │ Cache 98%
会话 tokens 644.88M 「输入 8.01M │ 输出 1.41M │ 缓存 635.45M」 │ 上下文 43% 「425.84K/1.00M」 │ 缓存命中 99% │ 轮数 97
小时会话窗口 [███████████░░░░░░░░░] 55% 剩余 │ 重置 2h 6m │ 周限制使用量 [███████████████████░] 97% 剩余 │ 重置 2d 11h
今日 「MiniMax-M3」 170.19M │ 「deepseek-flash」 53.25M
```

## 按 mcode 版本分两条策略

| mcode | 做法 | 修改 mcode |
|---|---|---|
| **≥ 0.4.0** | 用 mcode 原生的 `custom-command` 状态栏项跑 `mcode-hub` 脚本 | **0 字节** |
| **< 0.4.0** | 私有 pristine-tarball fork + `patches/<version>/` 注入 | 0 字节（fork 是副本） |

两条策略共用同一个渲染核心 `lib/render.mjs`，并用 `tests/parity.mjs` 在 18 个
宽度上逐字节锁定输出一致。

## 快速开始

**新机器首次安装**（macOS / Linux，自动检测 mcode 装法 + 装缺失依赖）：
见 [INSTALL.md](INSTALL.md)，或直接跑 `./mcode-hub-install`。

```bash
./mcode-hub-install     # 一次装好（写 config.yaml + 装 mmx + 装 PATH 入口）
./mcode-hub status      # 当前策略、配置状态
./mcode-hub doctor      # 自检（17 项）

mcode                # 启动 mcode —— ≥ 0.4.0 直接用 mcode 即可
```

> **v3.4.7 起 wrapper 已删除**。`mcode-hub` 现在只是 mcode spawn 的渲染
> 脚本(`tui.customStatusLine.command` 路径)。装好之后**直接跑 `mcode` 就行**;
> 维护场景用 `mcode-hub-install` / `mcode-hub-doctor` /
> `mcode-hub-status-compact` / `mcode-hub-push-remote`。完整 roadmap 见
> [MAINTENANCE.md §10](MAINTENANCE.md#10-mcode-hub-入口-deprecation-路线图v340-起)。

## mcode 升级时我要做什么

```bash
mcode update          # 升级 mcode
mcode-hub install        # 刷新配置（幂等；<0.4.0 时无需执行）
mcode-hub doctor         # 期望 0 failures
mcode                 # 直接跑 mcode
```

**≥ 0.4.0 绝大多数情况下到此为止** —— 我们只依赖 mcode 的配置 schema 和两处
sqlite 表，不碰它的内部方法名。完整决策树（含什么时候才需要改代码、跨过 0.4.0
那次的一次性切换、legacy 路径下怎么加 `patches/<新版本>/`）见
[MAINTENANCE.md §3](MAINTENANCE.md)。

## 原生路径怎么工作（≥ 0.4.0）

`mcode-hub install` 把这段合并进 `~/.minimax/config.yaml`（文本级编辑，保留你文件
里的注释与排版，幂等，带一次性 `.mcode-hub-backup`）：

```yaml
tui:
  statusLine:
    - ...既有项...
    - custom-command
  customStatusLine:
    command: <repo>/mcode-hub
    display: block
    position: below
    maxLines: 3
    intervalSeconds: 10
    timeoutMs: 5000
    colorMode: ansi
```

mcode 在 startup / session 切换 / 每 10s 调用脚本，向它的 **stdin** 写一行：

```json
{"protocol":1,"event":"interval","session_id":"mvs_…","workspace_dir":"…",
 "model":"MiniMax-M3","session_title":"打招呼","tui_version":"0.4.0"}
```

脚本把 3 行写到 **stdout**，mcode 渲染在原生状态栏下方。

## 数据来源

| 数据 | 来源 | 刷新 |
|---|---|---|
| session_id / model / 标题 | mcode 的 stdin JSON | 每 tick |
| 会话 tokens（输入/输出/缓存/总量）+ 轮数 | sqlite `local_runtime_token_usage` 按 session **SUM** | 每 tick |
| 上下文 已用/窗口 | sqlite assistant 行的 `context_usage.usedTokens` / `contextWindowTokens` | 每 tick |
| 缓存命中 | 由上面的 cache_read 与 input 计算 | 每 tick |
| 今日 按模型 | sqlite message rows（model）× token_usage（总量）按 turn_id 关联 | 60s 文件缓存 |
| 小时会话窗口 / 周限制使用量 | `mmx quota show --output json` | 60s 文件缓存 |

> 上下文窗口**不**从 `config.yaml` 的 `limit.context` 取：那是静态声明值
> （MiniMax-M3 写 512000），而实际生效窗口可能是 1000000。见 DECISIONS D31。

## 文件

```
mcode-hub                   入口：按 mcode 版本分发
mcode-hub            ≥0.4.0 的 custom-command 目标脚本
mcode-hub-doctor       自检（双路径）
lib/render.mjs           渲染核心（纯函数；两条路径共用）
lib/data.mjs             数据层（sqlite / mmx / 缓存）
lib/config-apply.mjs     config.yaml 文本级合并
config/0.4.0/            配置载荷（说明 + 参考）
patches/                 legacy fork 补丁（<0.4.0）
tests/parity.mjs         新旧渲染逐字节一致性
tests/mcode-smoke.mjs    行为回归
```

## 环境变量

| 变量 | 作用 |
|---|---|
| `MCODE_QUOTA_TAIL` | `auto`（默认）/ `full` / `compact` —— 明细的显示策略 |
| `MCODE_QUOTA_TTL_MS` | mmx 配额缓存 TTL（默认 60000） |
| `MCODE_QUOTA_TODAY_TTL_MS` | 今日统计缓存 TTL（默认 60000） |
| `MCODEX_CACHE_DIR` | 缓存目录（默认 `~/.cache/mcode-hub`） |
| `MCODEX_STATUS_DEBUG=1` | 脚本诊断到 stderr |
| `MCODE_QUOTA_DEBUG=1` | `mcode-hub` 诊断 |

## 效果

**3 行结构**（v3.2.0）：

- **第 1 行：4-chunk** — 紧贴 mcode 状态栏，承载**当前会话**的 4 类独立数据：
  `会话 tokens X.XM 「输入 │ 输出 │ 缓存」 │ 上下文 N% 「X/Y」 │ 缓存命中 N% │ 轮数 N`。
  4 类都是独立维度，全部保留（v3.2.0 首版 ship 曾合并/删除 4-chunk，用户反馈后恢复）。
- **第 2 行：5h/周** — 独立成行，承载配额（小时会话窗口 / 周限制使用量）剩余百分比与重置时间。
  标签**字数一致**（都是 6 字 / 12 列），天然对齐。宽屏 1 行带两组重置，窄屏拆 2 行每行带重置。
- **第 3 行：今日 按 LLM 模型** — 独立成行，承载**今日**用过的 LLM 模型及对应 token 总量。
  数据源 `local_runtime_message_rows.data_json.context_usage_telemetry.model` 关联到
  `local_runtime_token_usage.turn_id`（`token_usage.model` 列在 0.3.11 始终为 NULL）。
  60s 轮询，跨日自动刷新。响应式 top-N（5/3/1 by width）。

**宽屏（≥140 列，例 200 列）** — 3 行：

```
会话 tokens 152.3M 「输入 1.3M │ 输出 366.2K │ 缓存 150.6M」 │ 上下文 28% 「145.0K/512.0K」 │ 缓存命中 99% │ 轮数 984
小时会话窗口 [████████░░░░░░░░░░░░] 41% 剩余  │ 重置 3h 1m  │  周限制使用量 [██████████████████░░] 92% 剩余  │ 重置 3d 7h
今日 「MiniMax-M3」 867.4M
```

**中屏（100–139 列）** — 3 行，token usage 拆 2 行（每行带重置），段 1 显明细但去轮数，今日多模型（如有）降为 top-3：

```
会话 tokens 24.9K 「输入 550 │ 输出 95 │ 缓存 24.3K」  │  5% 「24.9K/512.0K」  │  缓存命中 98%
小时会话窗口 [██████████████████░] 90% 剩余  │ 重置 3h 42m
周限制使用量 [████████████████░░░░] 82% 剩余  │ 重置 4d 12h
今日 「MiniMax-M3」 705.8M
```

**中屏（80–97 列）** — 4 行，段 1 紧凑 + 缓存命中 + 轮数（无明细），今日 top-1：

```
会话 tokens 274.0M  │  5% 「259.0K/512.0K」  │  缓存命中 98%  │  轮数 56
小时会话窗口 [██████████████████░] 90% 剩余  │ 重置 3h 42m
周限制使用量 [████████████████░░░░] 82% 剩余  │ 重置 4d 12h
今日 「MiniMax-M3」 274.0M
```

**窄屏（55–79 列）** — 4 行，段 1 紧凑，去明细 / 去部分辅助（保留轮数或缓存命中），今日 top-1：

```
会话 tokens 274.0M  │  5% 「259.0K/512.0K」  │  轮数 56
小时会话窗口 [██████████████░░] 90% 剩余  │ 重置 3h 42m
周限制使用量 [█████████████░░░] 82% 剩余  │ 重置 4d 12h
今日 「MiniMax-M3」 274.0M
```

**数字精度**：K / M 都带 1 位小数（`24.9K` / `512.0K` / `274.0M`），< 1000 的纯整数保持原样（`550` / `1`）。
列宽在数字跨越量级时稳定不跳变。

**极窄（≤54 列）** — 退化（只剩上下文，token usage 退化），不再硬撑。

行数由**内容实际宽度**决定，不是固定区间。CJK 字符按 2 列计算宽度。
段 1 是**真正响应式**的：候选列表按"信息量从高到低"排列（`明细+上下文+缓存命中+轮数` → ... → 仅上下文），
逐个试直到有能 fit 当前宽度的；fit 不下时降级为多行。

排版模式可切换（`MCODE_QUOTA_TAIL`）：

| 值 | 行为 |
|---|---|
| `auto`（默认） | ≥80 列显明细（`输入/输出/缓存`），更窄退化为紧凑 tail |
| `full` | 永远保留明细 |
| `compact` | 永远不显示明细 |

**颜色（按剩余百分比分级）**：

| 剩余 | 颜色 | RGB |
|---|---|---|
| > 50% | 深绿 | `(60,160,90)` |
| 21–50% | 暗橙 | `(200,150,40)` |
| ≤ 20% | 暗红 | `(200,80,80)` |
| 无数据 | 灰 | `(140,140,140)` |

### 窄屏模式：`mcode-hub-status-compact`（v3.3.2+，可选）

3 行 block 在 < 80 列的小终端会被 mcode 自家视觉宽度截断抹掉一部分。
`mcode-hub-status-compact` 是 **1 行变体**：脚本用 `tput cols` 自己测真实
宽度并按梯度降级（≥50 → `ws │ model │ title`，30–49 → `ws │ model`，
18–29 → `ws`，<18 → 静默），**不**让 mcode 的 `…` 省略号再吃掉内容。

切换（改完需要**重启 mcode**）：

```yaml
# ~/.minimax/config.yaml
tui:
  customStatusLine:
    command: /path/to/mcode-hub-status-compact    # 替代 mcode-hub
    display: inline                            # 替代 block
    maxLines: 1                                # 替代 3
```

不查 sqlite、无子进程（除 `tput cols`），所以 spawn 快、timeout 设 3s 足够。
任何异常下静默退出，不拖 TUI 下水。

## 已知 trade-offs

- **≥0.4.0 刷新下限 10s** —— mcode 的 `intervalSeconds` 最小 10。会话切换会立刻
  触发一次，所以切 session 时不会等。
- **每次刷新一个短命进程**（实测 ~30ms 热 / ~90ms 冷）。10s 一次约 0.3% CPU。
  因为不在 TUI 事件循环里，即使 sqlite 扫描慢也不会卡界面。
- **mmx 与今日统计走文件缓存**（各 60s），避免每 10s 重跑。
- 首次渲染依赖 mcode 的 tick 或 session-change；启动瞬间可能短暂空白。
- 24-bit 颜色需要终端支持；`colorMode: ansi` 下 mcode 原样透传。
- **<0.4.0 仍走 fork** —— 那条路径每次 mcode 升级可能要重新适配 AST 锚点。
- `mmx` 不在 PATH 或未登录时，5h/周 行显示缓存值或占位符。

## 文档

| 文档 | 内容 |
|---|---|
| [README.md](README.md) | 怎么用、效果、数据源、trade-off |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 两条策略的隔离架构、数据流、排版 |
| [DECISIONS.md](DECISIONS.md) | 方案与决策记录：候选、选择、理由、代价、证据 |
| [MAINTENANCE.md](MAINTENANCE.md) | 故障诊断、mcode 升级、还原 |
| [CHANGELOG.md](CHANGELOG.md) | 每次改动记录 |
