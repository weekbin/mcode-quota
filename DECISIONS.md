# 方案与决策记录 — mcodex

记录「为什么这么做」：每个设计问题有哪些候选方案、最终选了什么、为什么、代价是什么、有什么证据。
README 讲**怎么用**，ARCHITECTURE 讲**怎么实现**，MAINTENANCE 讲**怎么修**，本文讲**为什么这么选**，
CHANGELOG 讲**改了什么**。

维护约定：改动行为时在 CHANGELOG 加条目；**如果涉及方案取舍，必须同步在本文加/改一条**。

---

## 1. 决策总览

| # | 问题 | 选定方案 | 考虑过但否决 | 版本 |
|---|---|---|---|---|
| D1 | 怎么把状态栏注入 TUI | 私有 fork + `cli.js` 静态 import | 直接改 mcode 本体 / `NODE_OPTIONS` 注入 | v2.0.0 |
| D2 | fork 源码从哪来 | npm 官方 tarball 真实拷贝 | 复制已安装目录 / symlink 到安装目录 | v2.0.0 |
| D3 | 怎么定位混淆代码里的锚点 | acorn AST 结构特征匹配 | 硬编码混淆短名 / 正则+花括号计数 | v1.4 → v1.6 |
| D4 | 渲染结果怎么回传 | 覆盖 `widget.render()` + `globalThis` | `setState` prototype wrap / `static{}` 自动启动 | v1.5 → v2.0.0 |
| D5 | 会话 token 数据源 | runtime API + sqlite 兜底 | 只用 runtime API | v1.5 / v1.6 |
| D6 | 上下文数据源 | `shellState.contextUsage` 渲染时实时读 | 新增 runtime 轮询 / 解析 `/context` 输出 | v2.1.0 |
| D7 | 刷新节奏 | TTL 轮询 + `requestRefresh()` 去抖 | 每次渲染都拉 / 事件订阅 | v1.x |
| D8 | 进程风暴防护 | 懒启动 + 熔断 + 进程组 SIGKILL | 只靠超时 | v1.6 / v2.0.0 |
| D9 | 熔断后如何恢复 | 绝对冷却截止时间 | 「是否曾成功」标记 | v2.0.1 |
| D10 | 分隔符 | `│`（U+2502） | `·`（U+00B7） | v2.1.0 |
| D11 | 上下文语义 | **已用**占比（取补数） | 剩余占比（与 mcode 原生一致） | v2.1.0 |
| D12 | 上下文显示格式 | `已用/总量 百分比`（`42K/200K 21%`） | 只显示百分比 | v2.1.1 |
| D13 | 排版取舍 | **明细优先于行数** | 单行优先（丢明细） | v2.1.2 |
| D14 | 怎么证明真的能用 | doctor 自检 + 真实 pty TUI + 宽度扫描 | 只看配置/单测 | v1.x → |

---

## 2. 逐条记录

### D1 — 注入路径：私有 fork + 静态 import

**背景**：状态栏行必须由 mcode 进程自己渲染（数据在它的 V8 isolate 里），所以必须让 sidecar 代码
进入 TUI 进程，并且能挂钩子到它的渲染函数。

**候选**：

1. **直接改 mcode 安装目录** —— 最省事，但升级会被覆盖，且污染官方包；一旦 patch 出错整个
   mcode 都起不来。
2. **`NODE_OPTIONS=--import=<sidecar>`** —— 不用改文件，看着最干净。
3. **私有 fork + `cli.js` 静态 `import`** —— 拷贝一份源码，只改拷贝。

**选择**：3。

**理由**：

- 候选 1 违反硬约束「mcode 本体必须与 npm 官方包字节一致」（doctor 会 `cmp` 校验）。
- 候选 2 是**早期进程风暴的根因**：`NODE_OPTIONS` 会被 mcode 派生的**每个子进程**继承，
  每个子进程都加载 sidecar 并各自 fork `mmx`，进程数指数级爆炸。这个坑踩过一次，不再回头。
- 候选 3 只让真正跑 TUI 入口的进程加载 sidecar，且 mcode 升级只需重建 fork。

**代价**：每个版本多占约 62MB（真实拷贝）；fork 路径写死在 `cli.js` 里，移动项目目录要重跑 patcher
（`mcodex` 会自动检测并重写）。

**证据**：doctor 的 `mcode launcher byte-identical to pristine npm tarball`、
`mcodex does not use NODE_OPTIONS`、`no mmx process storm (concurrent: 0)`。

### D2 — fork 源码来源：npm 官方 tarball

**背景**：fork 要拷贝一份 mcode 源码，拷贝源决定了 fork 是否干净。

**候选**：

1. **复制已安装目录** —— 最快，但如果历史版本往安装目录写过 patch，脏东西会被继承下去。
2. **symlink 到安装目录** —— 省空间，但 Node 默认对模块做 realpath，相对 `import` 会解析回源安装，
   patch 等于失效。
3. **`npm pack @minimax-ai/code@<版本>` 解压** —— 官方来源，但 tarball 不含 `node_modules/`。

**选择**：3，并从已安装目录**真实拷贝** `node_modules/` 补齐。

**理由**：来源可验证（tarball 有 sha256 记录在 `.fork-marker`）；真实拷贝避开 realpath 陷阱。

**兜底**：网络不可用（或 `MCODE_QUOTA_OFFLINE=1`）时回退到已安装 release 目录，但**先校验其
launcher 无 quota 痕迹**，否则拒绝——绝不允许拿被污染的源码去建 fork。

**证据**：`mcode-patch-quota.mjs` 的 `ensurePristine()`；CHANGELOG v2.0.0。

### D3 — 锚点定位：acorn AST 结构特征

**背景**：launcher bundle 是混淆过的，类名/变量名都是 `Xc` / `jf` 这种短名，需要在不依赖名字的
前提下找到「状态栏 widget 类」和它的基类。

**候选**：

1. **硬编码混淆短名**（v1.3）—— 名字一换就失效。
2. **正则 + 花括号计数做结构匹配**（v1.4）—— 不依赖名字了，但遇到模板字符串里的 `}` 就配对错。
3. **acorn 解析成 AST，按结构特征匹配**（v1.6）—— 字节偏移全部来自 AST `source range`。

**选择**：3。

**理由**：抗模板字符串、注释、正则字面量、嵌套函数、混淆器改名。匹配特征（`mcode-find-anchors.mjs`）：

- 找 `class extends <Base>`
- 构造体含 `super(` / `this.runtime` / `this.requestRender` / `this.shellState` / `setInterval`
- `BASE = widget.superClass` 直接派生，不单独匹配

**关键性质**：**改名不影响匹配**。曾用 sed 把 `Xc→Yx` / `jf→kw` 模拟重命名，仍正确识别。
只有当 mcode **结构**变化（不再继承基类 / 不再是 `render(width) → string[]` 的 Ink 契约）才需要
更新特征列表，见 `MAINTENANCE.md §5`。

**证据**：`node mcode-find-anchors.mjs` 的输出 `BASE` / `WIDGET` / `WIDGET_BODY_END` / `CTOR_END`。

### D4 — 渲染回传：覆盖 `render()` + `globalThis`

**背景**：sidecar 要拿到 `runtime` / `shellState`，并把自己的行追加到状态栏。

**候选**：

1. **`setState` prototype wrap**（v1.5）—— 能抓到 `this.runtime`，但强依赖 `setState` 这个名字和签名。
2. **`static {}` 块自动启动**（v1.5/v1.6）—— 类体里唯一能跑任意语句的位置，但依赖启动时机。
3. **覆盖 `widget.render(e)`**（v1.6 起）—— 调用 `super.render(e)` 拿到原行，追加后返回。

**选择**：3。

**理由**：

- `render` 是 Ink 的稳定契约，比 `setState` 稳定得多。
- 覆盖里顺手把 `this.runtime` / `this.shellState` / `this` 挂到 `globalThis`，sidecar 直接取用，
  不需要任何名字约定。
- `super.render(e)` 调的是基类原实现，**不改变原有渲染逻辑**，只是追加行。

**懒启动**（v2.0.0 补上）：sidecar 不在 import 时启动，而在 `render()` **第一次真实调用**时启动轮询器。
这是「真的是 TUI 进程」最可靠的信号——子进程即使 import 了 sidecar 也永不 fork 任何进程。

**证据**：fork 的 `chunks/launcher-*.js` 里 `__mcodeQuotaRender` 恰好出现 1 次；
doctor 的 `fork launcher render hook present`。

### D5 — 会话 token：runtime API + sqlite 兜底

**背景**：要显示当前会话累计 token，公式为「输入 + 输出 + 缓存命中」。

**候选**：

1. **只用 `runtime.getSessionUsageSummary(sessionId)`** —— in-process、最快，但 turn 落库前会返回全 0
   或结构不符预期。
2. **只读 sqlite** —— 数据权威，但每次都要开库，且 runtime 结构变化时才发现问题。
3. **API 优先 + sqlite 兜底**。

**选择**：3。

**口径**：总量 = `input_tokens + output_tokens + cache_read_tokens`。
**不能用 mcode 自己的 `totalTokens`** —— 它是 `input + output + reasoning`（用 fresh input、不含 cache），
与用户要的口径不同。

**证据**：CHANGELOG v1.5「数据源调研」；v1.6 的 sqlite fallback。

### D6 — 上下文数据源：`shellState.contextUsage`

**背景**：要显示上下文窗口用量，判断什么时候该 `/compact`。

**候选**：

1. **新增一个 runtime 轮询**（像 session token 那样）—— 多一份开销，且要多写一套 TTL/兜底。
2. **解析 `/context` 命令的输出** —— 要走命令通道，拿不到实时值，还可能污染会话。
3. **直接读 `globalThis.__mcodeShellState.contextUsage`** —— 这是 mcode 自己渲染
   `Context N% left` 指示器用的**同一份** runtime `getContextSnapshot` 快照。

**选择**：3，**渲染时实时读取，不新增轮询**。

**理由**：零额外开销、与原生指示器同源、天然随渲染刷新。
窗口大小优先取 `contextUsage.contextWindowTokens`，缺失时回落 shellState 顶层的 `contextWindowTokens`。
快照缺失（新会话尚未产生 `contextSnapshot`）时**整块不渲染**，不影响其他行。

**代价**：取数时点与 `/context` 详情可能差一次渲染周期（已在 MAINTENANCE §4 记入诊断表）。

### D7 — 刷新节奏：TTL 轮询 + 去抖

**背景**：状态栏会被高频重绘，不能每次渲染都去拉数据。

| 数据 | 间隔 | 原因 |
|---|---|---|
| 5小时 / 周使用量 | 60s（`MCODE_QUOTA_TTL_MS` 可覆盖） | 要 fork `mmx`，成本高；配额变化本来就慢 |
| 会话 tokens | 10s | 走 in-process API，便宜；要跟得上对话节奏 |
| 上下文 | 随渲染实时读 | 见 D6，零成本 |

- 数据到达后调 `widget.requestRender()` 触发重绘，**500ms 去抖**（`REFRESH_MIN_INTERVAL_MS`）。
- 定时器全部 `unref()`，不阻止 mcode 退出。
- `mmx` 单次超时 20s（原 5s 在慢网络下会误杀，见 CHANGELOG）。

**否决**：每次渲染都拉（风暴）、事件订阅（mcode 没有稳定的事件源）。

### D8 — 进程风暴防护

早期版本出现过 mmx 进程风暴，根因有两条：`NODE_OPTIONS` 继承（D1）和 5s 超时 SIGKILL 留下 watcher 僵尸。

| 防护 | 作用 |
|---|---|
| 不用 `NODE_OPTIONS` | sidecar 只在 TUI 进程加载 |
| 懒启动 | 不渲染就永不 fork（D4） |
| `isMmxOnPath()` | PATH 上没 `mmx` 直接失败返回，不 spawn |
| `detached:true` + `process.kill(-pid)` | 超时按**进程组** SIGKILL，不留孤儿 |
| 失败熔断 | 连续失败 5 次停用；5 分钟后自动恢复（`MCODE_QUOTA_MMX_COOLDOWN_MS` 可覆盖） |
| stderr 截断 | 最多缓存 64KB |
| 定时器 `unref()` | 不阻止退出 |

**证据**：doctor 的 `no mmx process storm (concurrent: 0)`；`/tmp/mcodex-proc-probe.mjs` 的进程探测。

### D9 — 熔断恢复：绝对冷却截止时间

**问题**（v2.0.1）：熔断触发后记录「失败次数」，而恢复条件是「下一次成功」——但熔断期间根本不发请求，
**永远不会有下一次成功**，于是永久停用。会话从头到尾没成功过一次时必现。

**选择**：改为在熔断瞬间记录绝对截止时间 `mmxDisabledUntil = now + 冷却时长`，
入口判定 `if (Date.now() < mmxDisabledUntil) return;`，到期即重试，与「是否曾成功」解耦。

**证据**：`/tmp/mcodex-breaker-test.mjs` 熔断回归测试；CHANGELOG v2.0.1。

### D10 — 分隔符：`·` → `│`

**理由**：mcode 原生状态栏用 `◇ Greeting │ ⎇ master │ FULL` 这种竖线分隔，原来的 `·` 显得突兀、
和上方内容风格不一致。三处统一：段落之间、`剩余 │ 重置`、`(输入 │ 输出 │ 缓存)`。

### D11 — 上下文语义：已用占比

**背景**：mcode 原生显示 `Context N% left`（剩余）。

**选择**：显示**已用**占比（取补数）。

**理由**：心理模型是「涨到 100% 就该压缩了」，比「剩余多少」直观；且用户诉求原话是
「让我更明确我什么时候需要压缩上下文」。

**阈值对齐原生**：mcode 按剩余 25% / 10% 变黄变红，取补数后为 **≥75% 暗橙、≥90% 暗红**，
颜色沿用配额那套柔和配色（深绿 / 暗橙 / 暗红）。

### D12 — 上下文格式：`已用/总量 + 百分比`

**问题**：只有百分比看不出绝对量——13% 到底是 13K 还是 130K，差别很大。

**选择**：`上下文 42K/200K 21%`。数字复用 `会话 tokens` 的同一套 `fmtTok`，
并加 `trimNum()` 去掉无意义的尾随零（`1.00M` → `1M`、`218.0M` → `218M`）。

**位置**：排在 `会话 tokens` 之后（用户指定）。

### D13 — 排版：明细优先于行数

**背景**：加了上下文之后，单行横排需要更宽；v2.1.0 为保住单行，把横排 tail 硬编码成紧凑形式，
**静默丢掉了 `输入/输出/缓存` 明细**。

**选择**：改回来——**明细优先于行数**。横排也用 `tailFor(width)`：放得下明细就保留，
放不下才退化。宁可多一行，也不丢明细。

实测阶梯（会话 223M + 上下文 42K/200K）：

| 终端宽度 | 布局 |
|---|---|
| ≥150 列 | 单行，带明细 |
| 128–149 列 | 两行，带明细 |
| 81–127 列 | 三行，带明细 |
| ≤80 列 | 三行，紧凑（一整行也放不下明细） |

**开关**：`MCODE_QUOTA_TAIL=compact` 恢复「宁可丢明细也要单行」的旧行为（默认 `full`）。

**其他排版约定**：进度条 clamp 到 8–20 字符；CJK 按 2 列算宽；`fit()` 从 20 开始收缩到 8，
仍放不下才拆行。

### D14 — 验证方式：不只看配置

**原则**：状态栏是「眼睛看的东西」，配置正确 ≠ 渲染正确。

| 手段 | 覆盖 |
|---|---|
| `mcode-quota-doctor`（17 项） | 本体纯净、fork 完好、sidecar 语法、真实渲染、分隔符、明细、上下文、进程风暴 |
| 真实 pty 起 `mcodex` | 捕获真 TUI 字节流，确认实际渲染（含 ANSI 剥离后的文本） |
| 宽度扫描 46–220 列 | 逐列断言不溢出、布局阶梯符合预期 |
| 熔断回归测试 | D9 的恢复语义 |
| 进程探测 | D8 的风暴防护 |

**教训**：D13 的回归正是「配置/单测都对，但实际渲染丢了明细」——所以 doctor 里专门加了一项
「140 列下明细仍在」，这类**静默丢失**以后会被自检抓到。

---

## 3. 明确不做 / 否决清单

| 事项 | 原因 |
|---|---|
| 修改 mcode 安装目录 | 硬约束：必须与 npm 官方包字节一致 |
| `NODE_OPTIONS` 注入 | 子进程继承 → 进程风暴（D1） |
| symlink 复用安装目录做 fork | Node realpath 会让 patch 失效（D2） |
| 用 mcode 的 `totalTokens` 做会话总量 | 口径不同，不含 cache（D5） |
| 为上下文新增轮询 | 现有快照零成本且同源（D6） |
| 在渲染热路径里发请求 | 渲染频率远高于数据变化频率（D7） |
| 单行优先、必要时丢明细 | 明细更有用；已改为默认保留（D13） |

---

## 4. 计划

### 已完成（用户诉求闭环）

- [x] 5小时 / 周使用量：剩余百分比 + 进度条 + 重置倒计时
- [x] 会话 tokens：累计总量 + `输入 / 输出 / 缓存` 明细
- [x] 上下文：`已用/总量 + 百分比`，阈值变色提示压缩时机
- [x] 分隔符统一为 `│`
- [x] 隔离架构：mcode 本体零修改、私有 fork、`mcodex` 入口、doctor 17 项自检
- [x] 抗升级：AST 锚点匹配 + 版本变化自动重建 fork + 失败回退官方 mcode

### 待办（按优先级）

- [ ] `mcode-patch-quota.mjs --revert`：一键删除 fork 并还原（目前靠手删目录）
- [ ] 多 TUI 实例共享 `mmx` 轮询：目前每个 mcode 进程独立 fork `mmx`
- [ ] 会话切换立即刷新：现在依赖 10s 轮询
- [ ] 多 model 支持：同时显示 video / general 等其它配额
- [ ] 装饰性图标（nerd font / emoji），可选开关

### 观察中

- mcode 若改动 TUI 状态栏结构（不再继承基类 / `render` 契约变化），需更新
  `mcode-find-anchors.mjs` 特征列表，见 `MAINTENANCE.md §5`
- fork 每个版本约 62MB，版本累积后考虑清理旧 fork
