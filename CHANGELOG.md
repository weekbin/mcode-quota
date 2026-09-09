# Changelog — mcode quota patch

记录每次对工具集的修改。新条目加在最上面。

## 2026-09-09 — v2.3.0：两段式排版（token usage 行 + 会话 tokens 行）

### 诉求

> 我考虑 会话 tokens, 上下文的情况显示和 token usage 还是换行显示，这样屏幕小的时候显示的内容能够更多一点，注意，把 token usage 显示在最后一行，其他信息都显示在 token usage 的上方

澄清后：「token usage」= 5小时/周行；「其他信息」= 会话 tokens + 上下文；行序为 token usage 在上、会话+上下文在下。

### 变更

之前 D15 的响应式打分会让两段挤在同一行（窄屏争空间、宽屏挤瘦进度条），改为**两段独立**：

- **段 1：token usage 行**（始终独立）。要么 1 行（5h │ 周，无重置），要么拆 2 行（5h + 周，带重置、标签对齐）。拆 2 行时 `周使用量` 标签用全宽空格（U+3000）补齐到与 `5小时使用量` 同宽、方括号左缘对齐。
- **段 2：会话 tokens + 上下文**（始终独立、**始终 1 行**）。候选 tail 按优先级逐个试：detail → compact → 仅会话 → 仅上下文。`会话 tokens` 永不丢；`上下文` 极端紧张时让位。

### 段 1 在不同宽度下的策略

| 行数 | 触发 | 内容 |
|---|---|---|
| 1 | 5h+SEP+周 在宽度内 | 1 行 5h+周，丢重置 |
| 2 | 塞不下 | 5h+重置 + 周+重置，标签对齐 |
| 2 退化 | < ~50 列 | 丢方括号与百分比，标签可压缩到 4/0 全宽空格 |
| 3 | < ~20 列 | 单字符进度条，无 padding |

### 段 2 候选 tail 优先级

1. detail（输入/输出/缓存）+ 上下文（**仅 ≥80 列** & TAIL_MODE ≠ compact）
2. compact（仅总量）+ 上下文
3. 仅会话 tokens
4. 仅上下文
5. 兜底

### 验证

- doctor 增至 **20 项**：明细检查改用新阈值（200 列有、100 列有），新增段结构断言
- 46–260 列逐列扫描 **0 溢出**（v2.2.0 在 30-40 列段有 12 处溢出，本版修掉）
- 真实 pty 在 250 列 / 100 列实测符合契约
- 22 项单元断言全绿
- `MCODE_QUOTA_TAIL=auto` / `full` / `compact` 三档在 120 列下行为符合预期

## 2026-09-08 — v2.2.0：窄屏响应式排版

### 诉求

> 当屏幕宽度比较窄的时候，不显示输入、输出、缓存的详细数据，为其他内容腾出展示空间，
> 这里要做得响应式一点。

### 做法

v2.1.2 的规则是「明细永远优先」，窄屏下为了保住明细既多占一行、又把进度条从 20 挤到 8。
改为**按实际内容打分**：对 `full` / `compact` 两种 tail 分别生成候选布局
（`horizRows` / `narrowRows`，纯函数，返回行数组或 `null`），按字典序排序：

1. **行数最少** —— 省下的垂直空间让给其它内容
2. **进度条最宽** —— 行数相同则不为了明细挤瘦进度条
3. **保留明细** —— 前两项相同才算"免费"，此时才显示

完整 tail 只有在 `dw(full) <= width` 时才进入候选（否则它自己那行就溢出）。
`会话 tokens` / `上下文` **永不丢弃**，被牺牲的只有 `输入/输出/缓存`。

### 实测阶梯（会话 231M + 上下文 42K/200K）

| 宽度 | 行数 | 明细 | 进度条 |
|---|---|---|---|
| ≥172 | 1 | 有 | 20 |
| 135–171 | 1 | 无 | 20 |
| 111–134 | 1 | 无 | 8→19 |
| 89–110 | 2 | 无 | 20 |
| 79–88 | 3 | 有 | 20 |
| ≤78 | 3 | 无 | 8→20 |

79–88 一段会显示明细：行数与进度条都和紧凑版一样，明细是"免费"的——
响应式不等于"窄就一律砍掉"。

### 开关

`MCODE_QUOTA_TAIL` 从两值扩成三值：

- `auto`（默认）— 上面的响应式规则
- `full` — 永远保留明细，宁可换行（v2.1.2 行为）
- `compact` — 永远不显示明细（v2.1.0 行为）

### 验证

- doctor 增至 **20 项**：明细检查改成两档——200 列必须**有**明细、100 列必须**无**明细（v2.3 起 ≥80 列都保留）
  且 `上下文` 仍在
- 单元测试 22 项断言全绿；46–260 列逐列扫描无溢出，阶梯单调（越宽不会更差）
- 三种 `MCODE_QUOTA_TAIL` 模式在 140 列下实测：`auto` 1 行无明细 / `full` 2 行带明细 /
  `compact` 1 行无明细

## 2026-09-08 — 文档：新增 `DECISIONS.md`（方案与决策记录）

把散落在 CHANGELOG / ARCHITECTURE 里的「考虑过哪些方案、为什么否决」集中成一份决策记录，
共 14 条（D1–D14）：注入路径、fork 来源、锚点定位、渲染回传、两处数据源、刷新节奏、
进程风暴防护、熔断恢复、分隔符、上下文语义/格式、排版取舍、验证方式。

- 新增 `DECISIONS.md`：总览表 + 逐条「背景 / 候选 / 选择 / 理由 / 代价 / 证据」+ 否决清单 + 计划
- README 增加文档索引；doctor 项数从 14 更正为 17，补上遗漏的自检项
- ARCHITECTURE 顶部指向 DECISIONS
- 更正旧文档两处过期说法：
  - 「mcode 改混淆变量名需要重派生锚点」—— AST 结构匹配**不依赖名字**（已用 sed 模拟重命名验证），
    只有结构变化才需要更新特征列表
  - 伪 TTY 80 列的描述（现在是三行紧凑布局，不再是两行）

## 2026-09-08 — v2.1.2：修复单行模式丢明细

### 问题

v2.1.0 为了把新增的上下文塞进单行，把横排布局的 tail 硬编码成紧凑形式，
于是宽终端下 `会话 tokens` 的 `(输入 │ 输出 │ 缓存)` 明细**无声消失**了。
这不是预期取舍——明细比省一行更有用。

### 修复

- 横排改用 `tailFor(width)`：放得下明细就保留，放不下才退化
- **明细优先于行数**：宁可多一行，也不丢明细。实测阶梯（会话 220M + 上下文 42K/200K）：
  - ≥150 列：单行，带明细
  - 128–149 列：两行，带明细
  - 81–127 列：三行，带明细
  - ≤80 列：三行，紧凑（一整行也放不下明细时）
- 新增 `MCODE_QUOTA_TAIL=compact` 开关，恢复"宁可丢明细也要单行"的旧行为（默认 `full`）
- doctor 增至 17 项：新增「140 列下明细仍在」检查，防止再次静默回归

### 验证

- doctor 17 ok / 0 warn / 0 fail；`MCODE_QUOTA_TAIL=compact` 时该项正确降为 info 而非 warn
- 单元测试 22 项断言全绿，46–220 列逐列扫描无溢出
- 46–220 列布局阶梯实测与文档一致

## 2026-09-08 — v2.1.1：上下文显示「已用/总量 + 百分比」

### 变更

`上下文 13%` → `上下文 25K/200K 13%`，即**已用 token 数 / 窗口总量 + 已用百分比**。
只有百分比看不出绝对量（13% 到底是 13K 还是 130K 差别很大），补上数字后更容易判断
距离 `/compact` 还有多少余量。

- 数字复用 `会话 tokens` 同一套格式化（`1M` / `1.5M` / `200K` / `42K`）
- 新增 `trimNum()`：去掉无意义的尾随 0，`1.00M` → `1M`、`1.50M` → `1.5M`
- 颜色分级、阈值、数据源、排布位置均不变（≥75% 暗橙、≥90% 暗红）

### 验证

- 单元测试 22 项断言全绿：5 种上下文场景（无快照 / 21% / 78% / 94% / 只给窗口）
  + 14 档宽度不溢出，并断言 `上下文 \S+/\S+ N%` 格式与告警/错误配色
- doctor 期望值同步改为 `上下文 42K/200K 21%`，实测 16 ok / 0 warn / 0 fail
- 真实 TUI（pty）实测渲染出 `会话 tokens 25K (输入 614 │ 输出 134 │ 缓存 25K)  │  上下文 25K/200K 13%`

## 2026-09-08 — v2.1.0：分隔符改 `│` + 新增「上下文」使用率

### 分隔符

`·`（U+00B7）→ `│`（U+2502），三处统一：状态栏各段之间、`剩余 │ 重置`、`(输入 │ 输出 │ 缓存)`。
理由：和 mcode 原生状态栏（`◇ Greeting │ ⎇ master │ FULL`）风格一致。

### 新增 上下文

排在 `会话 tokens` 之后，显示**已用**百分比：

```
会话 tokens 25K (输入 618 │ 输出 33 │ 缓存 25K)  │  上下文 13%
```

- 数据源：`globalThis.__mcodeShellState.contextUsage`（`{ usedTokens, contextWindowTokens }`），
  即 mcode 原生 `Context N% left` 指示器用的同一份 runtime `getContextSnapshot` 快照。
  **渲染时实时读取**，不新增轮询。
- 取**已用**占比而非剩余：涨到 100% 就是该 `/compact` 的信号，比"剩余"直观。
- 阈值对齐 mcode 原生逻辑（它按剩余判定 10% / 25%），取补数后：**≥75% 暗橙、≥90% 暗红**。
- 快照缺失时整块不渲染，不影响其他行。

### 排版

- 单行横排模式改用**紧凑 tail**（省略输入/输出/缓存明细），否则加上上下文后会从 165 列起步，
  140 列终端被迫掉成两行。现在 110 列即可单行。
- 新增 `tailFor(width)`：tail 先试完整形式，超宽退化为紧凑形式（只留总量 + 上下文）。
- 单行即使缩到最小进度条仍放不下时，自动降级为多行布局，不再溢出。

### 验证

- 单元测试：5 种上下文场景（无快照 / 21% / 78% / 94% / 只给窗口）+ 14 档宽度全部不溢出
- doctor 增至 16 项：新增「上下文行」「分隔符为 │」两条检查
- 真实 TUI（pty）实测渲染出 `上下文 13%`，分隔符 `│`

## 2026-09-08 — v2.0.1：修复 mmx 熔断永不恢复

**背景**：用 `mcodex` 起的会话实测排查僵尸进程 / MainThread 反复拉起时发现，
`fetchQuotaOnce` 的失败熔断恢复逻辑有缺陷。

**缺陷**：冷却判定锚在 `raw.lastSuccessAt` 上：

```js
if (raw.lastSuccessAt && Date.now() - raw.lastSuccessAt > MMX_FAILURE_RESET_MS) { ... }
```

若会话启动时 mmx 连续失败 5 次而**从未成功过**，`lastSuccessAt` 恒为 0，
条件永远为假 → 直接 `return`，配额行直到 mcode 重启都不会再尝试。
即「启动时遇到 5 分钟 mmx 故障 = 本次会话配额行永久空白」。

**修复**：改为在熔断触发瞬间记录冷却截止时间 `mmxDisabledUntil`，
冷却到期即重试，与「是否曾成功」解耦。

- `let mmxDisabledUntil = 0;`，熔断时 `mmxDisabledUntil = Date.now() + MMX_FAILURE_RESET_MS`
- 入口判定改为 `if (Date.now() < mmxDisabledUntil) return;` 然后重置计数

**可测试性**：`CACHE_TTL_MS` 与 `MMX_FAILURE_RESET_MS` 支持环境变量覆盖
（`MCODE_QUOTA_TTL_MS` / `MCODE_QUOTA_MMX_COOLDOWN_MS`），生产默认值不变。
回归测试实测：5 次失败 → 熔断 → 冷却期 0 次调用 → 冷却后恢复并渲染 79%。

## 2026-09-08 — v2.0.0：fork 隔离架构 + mcodex

**背景**：v1.x 直接 patch mcode 本体的 launcher，一旦 patch 有 bug，
用 mcode 排查问题时排查不到根源，且**不断拉起僵尸进程**。用户要求重新设计隔离架构。

### 架构（重写）

- **不再修改 mcode 本体**。mcode 的 `~/.minimax-code/**` 保持与 npm 官方包字节一致。
- **fork 来源改为 npm 官方 tarball**：`npm pack @minimax-ai/code@<版本>` →
  `tarballs/` 缓存 → 解压到 `.pristine-<版本>/` → 真实拷贝到 `<版本>/code/`。
  （早期草案从已安装目录 symlink 镜像，有两个致命问题：① 顶层 symlink 导致 `chunks/`
  根本不会被实拷贝，patch 会落到源安装上；② Node realpath 会把 symlink 的 `cli.js`
  解析回源安装，相对 import 绕过 patch。改为**真实拷贝**彻底规避。）
- **两处 patch**：
  1. fork 的 `chunks/launcher-*.js` — 在 widget 类体末尾插入 `render()` 覆盖
     （`super.render()` + 注入 runtime/shellState/widget + 追加配额行）
  2. fork 的 `cli.js` — 静态 `import "<sidecar>"`
- 入口从 `mcode-with-quota` 改名为 **`mcodex`**；PATH stub 同步替换。
- patcher CLI 改为 `--fork-base` / `--sidecar` / `--current` / `--registry` / `--offline`。

### 修复僵尸进程风暴（根因）

根因是 `NODE_OPTIONS=--import=<sidecar>`：该环境变量被 mcode 派生的**所有子进程**继承，
每个子进程都加载 sidecar 并各自 fork `mmx`，进程数指数级爆炸。修复：

1. 弃用 `NODE_OPTIONS`，改由 fork 的 `cli.js` 静态 import —— 只有 TUI 入口进程加载。
2. sidecar **不再自动启动**：轮询器在**第一次状态栏渲染**时才启动（子进程不渲染 → 不 fork）。
3. 保留进程防护：`detached:true` + 进程组 SIGKILL、`isMmxOnPath()` 探测、
   连续失败 5 次停用 + 5 分钟自动恢复、stderr 64KB 上限、定时器 `unref()`。

### 文案中文化

- `Session` → **会话 tokens**
- `5-hour` → **5小时使用量**
- `Weekly` → **周使用量**
- 附带：`left` → 剩余、`resets in` → 重置、`(no data)` → （无数据）、
  `in/out/cache` → 输入/输出/缓存

### 显示正确性

- 新增 CJK 宽度计算（CJK 按 2 列），排版按真实显示宽度收缩进度条，修复 95 列溢出。
- 会话 token 兜底修正：runtime API 返回全 0 或结构异常时，自动回落到 sqlite
  （`local_runtime_token_usage`），避免把有数据的会话显示成 0。
- 实测：新会话 `会话 tokens 25K (输入 619 · 输出 13 · 缓存 25K)`，与 sqlite 的 25,208 一致。

### 验证

- 单元测试：宽度 140 / 95 / 60 均不溢出；runtime 路径与 sqlite 路径均正确。
- 集成测试（pty 真 TUI）：`mcodex` 渲染出中文标签；进程采样
  `max clone=1, max mmx=0, max zombie=0`，无风暴。
- `mcode-quota-doctor`：14 ok / 0 warn / 0 fail。

### 清理

- 恢复 mcode launcher 为 npm 官方版本（sha256 `fb92932…`）。
- 删除历史遗留：`launcher-*.js.unpatched.bak`、`mcode-quota-fetcher-*.mjs`、
  `*.bak.stormquake`。
- 删除 `~/.minimax/bin/mcode-with-quota`，新增 `~/.minimax/bin/mcodex`。


## 2026-09-08 — 初始版本 + 4 轮迭代

### v1.0（首版）
- 实现：patch `Xc.render` + `jf.constructor` 两个锚点
- sidecar 每 60s 跑 `mmx quota show --output json`
- 单行状态栏 quota：`5h 36% used (resets in 2h 32m) · Week 10% used (resets in 131h 32m)`
- 数据：实测 `mmx quota show --output json` 返回 `model_remains[].current_interval_remaining_percent` / `current_weekly_remaining_percent` + `remains_time` / `weekly_remains_time`
- 验证：用 `script -qfc` 伪 TTY 跑 mcode，捕获 ANSI 输出，确认 row 24 出现 quota 行
- 文件：`mcode-patch-quota.sh` / `mcode-with-quota` / `mcode-quota-doctor`，全部在 `~/.minimax/bin/`

### v1.1 — 多行进度条
- 改：单行 `·` 分隔 → 多行（每行一个字段），用 `\n` 分隔
- 改：Xc.render patch 从 `["",r,"",_q]` 改成 `["",r,..._q.split("\n")]`
- 改：文案 "5h/Week" → "5-hour/Weekly" 对齐
- 改：加 `[██░░]` 进度条，BAR_WIDTH=40
- bug 修复：perl 命令用双引号传 replacement 时 `\n` 被解释为换行符；改用 env var 传（`$ENV{RENDER_PATCH}`）
- bug 修复：BAR_WIDTH=40 在 80 列 TTY 被 `t3 → vs → x` 截断；降到 30
- 文件移到 `~/orca/projects/mcode/mcode-quota/`（用户提醒 mavis data dir 易失）

### v1.2 — 横排 + 颜色分级
- 改：sidecar 不再预渲染，改为暴露 `globalThis.__mcodeQuotaRender(width)` 函数
- 改：Xc.render 调 `__mcodeQuotaRender(e)` 拿 string[]
- 改：width >= 88 横排（单行 + 两个进度条并排 + 颜色），width < 88 fallback 竖排（两行 + reset time）
- 加：ANSI 24-bit 颜色按 remaining 分级
  - success (绿) `#28C567` = (40,197,103) — 来自 mcode theme
  - warning (橙) `#FFC340` = (255,195,64) — 来自 mcode theme
  - error (红) `#FF5E6C` = (255,94,108) — 来自 mcode theme
  - 阈值：rem > 30 success，11-30 warning，≤ 10 error（与 mcode 内部 `ef()` 一致）
- 加：`~/.minimax/bin/mcode-with-quota` 改为 328 字节 stub，exec 委托项目目录 wrapper（single source of truth）

### v1.3 — 颜色调暗 + 进度条 max 宽度
- 改：success (绿) (40,197,103) → (60,160,90) — **深绿**，用户反馈"刺眼"
- 改：warning (橙) (255,195,64) → (200,150,40) — 配合深绿更协调
- 改：error (红) (255,94,108) → (200,80,80) — 同样协调
- 加：`MAX_BAR_WIDTH = 20` — 用户反馈"大屏幕下太宽"
- 加：`MIN_BAR_WIDTH = 12` — 防止太窄
- `buildBar` 内部 clamp 到 [12, 20]，调用方传的 width 只是 hint
- 验证：160 cols 终端 bar 仍是 20 字符

---

## 已知版本兼容性

| mcode 版本 | @minimax-ai/code 版本 | patcher 状态 |
|---|---|---|
| 0.3.10 | 0.2.7 | ✅ 测试通过 |
| 0.2.x | 0.2.x | 推测可用（锚点结构 `Xc=class` / `var jf=class extends Xc` 在 0.2.6+ 都用） |
| 0.3.0 - 0.3.9 | — | 推测可用（观察到的 0.3.10 launcher bundle 跟早期 0.2.x 锚点结构一致） |
| 旧 0.2.x 早期（launcher-U4C3IZNL） | — | ❌ 锚点不匹配（变量名 `bc`/`tf`/`Wo`/`K_` 是更早的混淆结果）— 0.3.10 升级已切到 `Xc`/`jf`/`ma`/`J6` 体系 |

**已知问题**：AST 结构匹配**不依赖混淆短名**（`Xc` → `Yx` 这类重命名不影响，已用 sed 模拟验证）。
只有当 mcode 改动状态栏的**结构**（不再继承基类、`render(width) → string[]` 契约变化）时，
patcher 才会失败，需按 `MAINTENANCE.md §5` 更新 `mcode-find-anchors.mjs` 的特征列表。

---

## 测试矩阵

每个版本做的验证：

## 2026-09-08 — v1.6 抗升级加固 + process storm 修复

### 问题回顾
- mmx 调用 5s 超时后 SIGKILL 会留下 watcher 僵尸进程
- 多个 mcode CLI 同时跑就会形成 process storm
- mcode runtime API 可能改名/移除，需要 sqlite fallback
- 之前锚点用 regex + 括号配对，遇到模板字符串 `}` 就错
- setState wrap 太依赖名字

### 改动

#### A. AST 化 anchor finder (mcode-find-anchors.mjs)
- 用 acorn 8.18 解析整个 launcher 为 AST
- 找 ClassExpression 不再只盯顶层 VariableDeclaration
- 走 parent chain 找出 class 的 binding (VariableDeclarator 或 AssignmentExpression)
- 通过 5 个结构特征 (super / this.runtime= / this.requestRender= / this.statusLineItems= / setInterval) 找 widget class
- BASE = widget.superClass 直接派生，不再单独匹配
- 所有 byte offset 来自 acorn 的 source range，不再 string scan
- 抗：模板字符串、注释、regex literal、嵌套函数、改 obfuscator 名

#### B. Bridge 简化（不再依赖 setState）
- 之前：static block 包裹 setState prototype 来抓 this.runtime + this.shellState
- 现在：render() wrapper 直接 `this.runtime` / `this.shellState` → globalThis
- 副作用：不再需要 static block，sidecar import 时 auto-start 即可
- 抗：setState 改名/换签名/移除

#### C. SQLite direct fallback
- mcode runtime 用 `local_runtime_token_usage` 表存每次 turn 的 token
- 表 schema: `input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, session_id`
- sidecar 的 fetchSessionOnce 现在两路：
  1. 优先 `runtime.getSessionUsageSummary(sessionId)`（in-process 快）
  2. 失败时回落到直接查 `~/.minimax/v2/sqlite/runtime-state.sqlite` (readOnly)
- 抗：runtime API 改名/移除/schema 变了（sqlite 路径用同一份 schema）

#### D. Process storm 修复（关键）
- `detached: true` + 自己 process group + 超时 SIGKILL 整个 group
- `isMmxOnPath()` 启动前先 probe，没有就不 spawn（避免 ENOENT thrash）
- `MMX_MAX_FAILURES = 3` 连续失败后 stop 整个 sidecar lifetime
- mmx 调用自己 stderr 64KB cap 防止 unbounded memory
- 失败时回落到 sqlite，**永远不刷 retry storm**

#### E. Self-test
- patch 后用 acorn parse 验证 launcher 仍是合法 JS
- 检查 `super.render(e)` 和 `__mcodeQuotaRender` 引用都在
- 检查 `__mcodeRuntime` / `__mcodeShellState` capture 都在

### 验证
1. AST finder: `BASE='Xc' WIDGET='jf' CTOR_END=823576 WIDGET_BODY_END=824319` （与旧 regex finder 一致）
2. 完整 mock test:
   - runtime path: `Session 155K (in 100K · out 50K · cache 5.0K)` ✓
   - sqlite path: `Session 179.7M (in 2.73M · out 445K · cache 176.5M)` ✓
   - mmx 缺失: `Session 179.0M (in 2.73M · out 444K · cache 175.9M)` (只有 Session 行，quota 行不显示)
3. 0 进程泄漏: mmx 失败 3 次后 sidecar 永远 stop

### 文件
- `package.json`:  新增 acorn ^8.18 dep
- `mcode-find-anchors.mjs`: 305 行 AST 版本
- `mcode-patch-quota.mjs`: PATCH_AFTER_CTOR 长度从 433 → 0 (不再需要 static block)
- `mcode-quota-fetcher-9f8a7b.mjs`: 7448 → 13931 bytes (+6483 字节：sqlite fallback + process storm 防护)

| 验证项 | v1.5 | v1.6 |
|---|---|---|
| AST 化 anchor finder | n/a | ✅ |
| Bridge 抗 setState 改名 | n/a | ✅ |
| SQLite fallback (runtime API 挂掉) | n/a | ✅ |
| Process storm 防护 (mmx 失败不刷) | n/a | ✅ |
| `node --check` launcher | ✅ | ✅ |
| `node --check` sidecar | ✅ | ✅ |
| acorn parse 验证 patch | n/a | ✅ |
| mock test (runtime path) | ✅ | ✅ |
| mock test (sqlite path) | n/a | ✅ |

---

## 文件清单

```
/home/weekbin/orca/projects/mcode/mcode-quota/
├── README.md                  # 用户文档
├── MAINTENANCE.md             # 维护指南（升级 / 失败 / 还原 / 自定义）
├── ARCHITECTURE.md            # 原理说明（patch 机制 / bridge 机制）
├── CHANGELOG.md               # 本文件
├── mcode-find-anchors.mjs     # AST 锚点查找（v1.4+）
├── mcode-patch-quota.mjs      # 升级后重跑（Node 版，v1.4+）
├── mcode-with-quota           # 一键启动 wrapper
└── mcode-quota-doctor         # 自检

/home/weekbin/.minimax/bin/mcode-with-quota     # PATH 入口（328B stub，exec 项目 wrapper）
~/.minimax-code/.../mcode-quota-fetcher-9f8a7b.mjs   # sidecar
~/.minimax-code/.../launcher-*.js.unpatched.bak      # 备份
```

---

## 未来可能的工作

> **已迁移**：计划清单现维护在 [`DECISIONS.md §4 计划`](DECISIONS.md#4-计划)（含已完成 / 待办 / 观察中）。
> 下面这份是早期版本，保留作历史记录。

- [ ] 把 `mcode-quota/` 纳入 git 版本管理（**已完成** — 4 个 commit，0.3.10 / v1.4 / v1.5）
- [x] 把锚点查找自动化（v1.4 AST 通用匹配）
- [x] 第三行 session tokens 累计显示（v1.5）
- [ ] patcher 加 `--revert` 一键还原选项
- [ ] sidecar 支持 multiple model（同时显示 video / general / 其他）
- [ ] 添加图标（用 nerd font 或 emoji 装饰标签 / 进度条）
- [ ] 多个 TUI 实例同时跑时 sidecar 共享（目前每个 mcode 进程独立 fork mmx）
- [ ] session 切换时立即刷新（现在依赖 10s 轮询）

### v1.4 — Universal AST-based patcher (no hardcoded short names)

**Motivation**: previous v1.3 hardcoded the obfuscated short names `Xc` (base class) and `jf` (widget class) as literal strings in `RENDER_ANCHOR` / `WIDGET_ANCHOR` / `RENDER_PATCH` / `WIDGET_PATCH`. If the minifier produced different short names on a future mcode build, the patcher would fail to match. The user's "特征匹配是如何做到的呢" question prompted this rewrite.

**Solution**: structural matching with brace counting (no AST parser required). New `mcode-find-anchors.mjs` script:
- Finds every `Name = class [extends Base]? {` position in the launcher bundle
- For each, brace-counts to find the class body
- BASE class: has a `render(<param>)` method whose body contains `["", <expr>]` (the mcode status bar layout)
- WIDGET class: extends BASE, constructor has all 5 state-init features:
    `super(...)` + `this.runtime = ...` + `this.requestRender = ...` + `this.statusLineItems = ...` + `setInterval(...)`
- Locator also reports `WIDGET_BODY_END` and `CTOR_END` (byte offsets within the class body)

**New patcher** (`mcode-patch-quota.mjs`, replaces the .sh version):
- Calls the anchor finder; receives the obfuscated short names dynamically
- Inserts two byte-exact patches into the launcher:
  - **Patch A**: a `static { ... }` block right after the constructor closes (the ONLY construct allowed in ES2022 class-body top level that runs arbitrary statements) — calls `__mcodeQuotaStart(this.requestRender)`
  - **Patch B**: a `render(e) { ... }` method right before the widget class body closes — calls `super.render(e)` and appends sidecar lines
- Verifies the result with `node --check`; rolls back on failure
- Writes the sidecar as an inline `const SIDECAR_BODY` (no external template file)

**Verified**: simulated minifier rename (Xc→Yx, jf→kw via sed) was correctly discovered as `BASE='Yx' WIDGET='kw'`. Direct mcode TUI render at 160 cols confirmed horizontal layout still works.

**Files**:
- New: `mcode-find-anchors.mjs`, `mcode-patch-quota.mjs`
- Removed: `mcode-patch-quota.sh` (the old bash+perl+literal-string version)
- `mcode-with-quota` and `mcode-quota-doctor` unchanged

**Patch payload sizes** (no longer depend on internal short names like `X6`, `J6`, `t3`, `xe`, `o3`):
- PATCH_AFTER_CTOR = `static{;if(typeof globalThis.__mcodeQuotaStart==="function")globalThis.__mcodeQuotaStart(()=>{if(this.requestRender)setTimeout(()=>this.requestRender(),0)})}`  (152 chars)
- PATCH_BEFORE_CLASS_END = `render(e){let r=super.render(e);if(Array.isArray(r)){let _qr=typeof globalThis.__mcodeQuotaRender==="function"?globalThis.__mcodeQuotaRender(e):[];if(Array.isArray(_qr)&&_qr.length>0)return[...r,..._qr]}return r}`  (213 chars)

---

## 2026-09-08 — v1.5 第三行：当前会话累计 token

### 用户诉求
> 能否显示当前会话累计使用的 token，负载在 Weekly usage 的后面，累计使用 token 的计算公式为 输入+输出+缓存命中

### 数据源调研
- mcode 内部已经有 `runtime.getSessionUsageSummary(sessionId)` API（chunk-CTHP2I62.js），返回 `{summary, rows}`
- summary 字段：`inputTokens` (fresh, 非 cache)、`outputTokens`、`cacheReadTokens` (cache 命中)、`cacheWriteTokens`、`reasoningTokens`、`totalTokens`
- 用户的"输入+输出+缓存命中" 在 mcode 字段语义下 = `inputTokens + outputTokens + cacheReadTokens` (fresh input + output + cache 命中 = 总消费 token)
- 注意：mcode 自己的 `totalTokens = inputTokens + outputTokens + reasoningTokens`（用 fresh input，不含 cache）—— 和用户公式不一样，所以不能用 mcode 的 `totalTokens`

### 实现方式
**bridge: globalThis 共享**
- patched `static { }` block 加 setState wrap：
  ```js
  static {
    const _C = this;
    if (_C.prototype.setState && !_C.prototype.__mcodeQ) {
      _C.prototype.__mcodeQ = 1;
      const _O = _C.prototype.setState;
      _C.prototype.setState = function(t) {
        if (this.runtime) globalThis.__mcodeRuntime = this.runtime;
        const r = _O.call(this, t);
        if (this.shellState) globalThis.__mcodeShellState = this.shellState;
        return r;
      };
    }
    if (typeof globalThis.__mcodeQuotaStart === "function") {
      globalThis.__mcodeQuotaStart(() => {});
    }
  }
  ```
- 第一次 setState 调用时，runtime 被推到 globalThis；后续每次 setState 更新 shellState
- shellState 的 `agentSessionId` 字段就是当前 mcode session id（来自 launcher chrome 的 setState 调用：见 880613 + 950688）

**sidecar 新增**
- `let session = { valid: false, total: 0, input: 0, output: 0, cache: 0, reasoning: 0, sessionId: null, fetchedAt: 0 }`
- `fetchSessionOnce()` 每 10s 调 `runtime.getSessionUsageSummary(shellState.agentSessionId)`
- `__mcodeQuotaRender(width)` 末尾追加第三行：
  ```
  Session 2,050,000 tokens (in 1.50M · out 200K · cache 350K)
  ```
- 数字格式：`fmtTok(n)` — ≥1M 用 M（≥10M 一位小数），≥1K 用 K（≥10K 整数），否则原数
- 颜色：total 用 success 绿（保持统一），括号里用 muted 灰

### 验证
1. **逻辑层**（mock 测试）：在隔离 Node 进程注入 fake runtime + shell state，sidecar 渲染出
   ```
   Session 2,050,000 tokens (in 1.50M · out 200K · cache 350K)
   ```
   公式：1.5M + 200K + 350K = 2.05M ✓
2. **bridge 层**（mcode TUI 实测）：`MCODE_QUOTA_DEBUG=1` 跑 mcode，render 回调日志显示
   ```
   [quota] render width=76 raw.valid=true session.valid=false sid=none rt=true shell=true
   ```
   - `rt=true` → globalThis.__mcodeRuntime 已被 setState 推上去
   - `shell=true` → globalThis.__mcodeShellState 也被推上去
   - `sid=none` → 当前是 welcome 屏没会话，session 行正确隐藏
3. **launcher 语法**：`node --check` 仍然 pass

### 已知边界
- 第一次启动 mcode 还在 welcome 屏时，第三行不会出现（因为没有 sessionId）；开了会话就出现
- session 切换时，10s 轮询会自动取新会话的数据（TTL 强制刷新）

### Patch payload 更新
- PATCH_AFTER_CTOR 长度：152 → 433 chars（增加了 setState wrap）
- PATCH_BEFORE_CLASS_END 不变（213 chars）
- sidecar 长度：4583 → 7448 bytes（+2865 bytes：session state + 渲染 + fetcher）
