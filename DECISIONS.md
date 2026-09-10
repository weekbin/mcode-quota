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
| D13 | 排版取舍 | 明细优先于行数（**已被 D15 取代**） | 单行优先（丢明细） | v2.1.2 |
| D14 | 怎么证明真的能用 | doctor 自检 + 真实 pty TUI + 宽度扫描 | 只看配置/单测 | v1.x → |
| D15 | 窄屏怎么排 | 响应式打分：**行数 > 进度条宽度 > 明细**（**已被 D16 取代**） | 固定阈值切换 / 明细永远优先 | v2.2.0 |
| D16 | 整体两段式布局 | 行 1=token usage（5h/周），行 2=会话 tokens+上下文 | 之前是 1-3 行交替 | v2.3.0 |
| D17 | 标签与重置时间 | 同字数标签（6 字 + 6 字）+ 重置时间常驻 | 全宽空格补齐 / 1 行丢重置 | v2.4.0 |
| D18 | 段顺序 + 括号风格 | 段 1=会话 tokens（贴近状态栏）/ 段 2=token usage / 明细用「」 | 之前是 token usage 在上 / `()` 括号 | v2.5.0 |
| D19 | 缓存命中 + 轮数 | 段 1 4 chunk 响应式（detail/compact × ctx/hit/turn） | 之前只 2 chunk | v2.6.0 |
| D20 | 上下文显示格式 | `51% 「259.0K/512.0K」`（百分比前置 / 去标签 / 「」括号） | `上下文 42K/200K 21%` | v2.7.0 |
| D21 | 数字精度 | 全部 1 位小数（K / M 都带 1 位） | 1 / 2 / 0 位小数混排（跳变） | v2.7.0 |
| D22 | 启动占位符 | 4 chunk 各自 `…` 占位，import 时 eager-start | 启动空白几行再冒数据 | v2.8.0 |
| D23 | session fetch 并行 | `Promise.allSettled([runtime, sqlite])` | 串行（runtime 失败才走 sqlite） | v2.8.0 |
| D24 | 分隔符/标签间距 | SEP 单空格、reset tail 单空格、`% 「」` 单空格 | 之前所有间距 2 空格 | v2.9.0 |
| D25 | 注入逻辑去硬编码 | 5 特征 / 属性名 / SQL 列全 AST 化 + 容错链 + 升级回归 | 5 特征里有 3 个硬编码属性名；PATCH_RENDER / SQL 全硬编码 | v3.0.0 |
| D26 | async 副作用必须挂 `.catch` | 同步 `try/catch` 抓不到 async reject；必须显式挂 `.catch(()=>{})` 让 Promise 永不能升级 unhandledRejection | v3.0.0 的 `getContextSnapshot()` 无参调用导致 mcode 0.3.10 `TUI stopped unexpectedly` | v3.0.1 |
| D27 | patcher 按 mcode 版本分目录 | `patches/<v>/mcode-patch-quota.mjs` + `_loader.mjs` 按 `--current` 选目录，找不到精确匹配时回退到最近 `<=` 版本 | 单 patcher 文件让"老 mcode 用户拉新 master"不匹配、git history 把 0.3.10/0.3.11 决策混在一根 branch | v3.1.0 |

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
| 小时会话窗口 / 周限制使用量 | 60s（`MCODE_QUOTA_TTL_MS` 可覆盖） | 要 fork `mmx`，成本高；配额变化本来就慢 |
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
和上方内容风格不一致。三处统一：段落之间、`剩余 │ 重置`、`「输入 │ 输出 │ 缓存」`。

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

> **注意**：本条已被 **D15** 取代——「明细永远优先」在窄屏下会把行和进度条宽度都吃掉。

### D14 — 验证方式：不只看配置

**原则**：状态栏是「眼睛看的东西」，配置正确 ≠ 渲染正确。

| 手段 | 覆盖 |
|---|---|
| `mcode-quota-doctor`（20 项） | 本体纯净、fork 完好、sidecar 语法、真实渲染、分隔符、明细、上下文、2 行结构、进程风暴 |
| 真实 pty 起 `mcodex` | 捕获真 TUI 字节流，确认实际渲染（含 ANSI 剥离后的文本） |
| 宽度扫描 46–220 列 | 逐列断言不溢出、布局阶梯符合预期 |
| 熔断回归测试 | D9 的恢复语义 |
| 进程探测 | D8 的风暴防护 |

**教训**：D13 的回归正是「配置/单测都对，但实际渲染丢了明细」——所以 doctor 里专门加了
明细检查项（见 D15，现在分宽屏「有」与窄屏「无」两档断言），这类**静默丢失**以后会被自检抓到。

### D15 — 窄屏响应式：行数 > 进度条宽度 > 明细

**背景**：D13 的规则是「明细永远优先」，结果是窄屏下为了保住明细，既多占一行、又把进度条挤瘦。
用户诉求原话：「当屏幕宽度比较窄的时候，不显示输入、输出、缓存的详细数据，
为其他内容腾出展示空间，这里要做得响应式一点。」

**候选**：

1. **固定阈值**（如 <110 列就丢明细）—— 简单，但阈值是拍脑袋的，且不同会话 token 位数不同，
   同一个宽度在不同会话下"够不够"并不一样。
2. **明细永远优先**（D13）—— 窄屏体验差。
3. **按实际内容打分**—— 对 `full` / `compact` 两种 tail 分别生成候选布局，按优先级排序。

**选择**：3。候选排序（字典序）：

1. **行数最少** —— 省下的垂直空间给其它内容
2. **进度条最宽** —— 行数相同时不为了明细把进度条从 20 挤到 8
3. **保留明细** —— 前两项相同才算"免费"，此时明细显示

实现上 `horizRows(tail)` / `narrowRows(tail)` 是纯函数，返回行数组或 `null`；
完整 tail 只有在 `dw(full) <= width` 时才进入候选。`会话 tokens` / `上下文` 永不丢弃。

**实测阶梯**（会话 231M + 上下文 42K/200K）：

| 宽度 | 行数 | 明细 | 进度条 |
|---|---|---|---|
| ≥172 | 1 | 有 | 20 |
| 135–171 | 1 | 无 | 20 |
| 111–134 | 1 | 无 | 8→19 |
| 89–110 | 2 | 无 | 20 |
| 79–88 | 3 | 有 | 20 |
| ≤78 | 3 | 无 | 8→20 |

注意 79–88 这一段：行数和进度条都一样，明细"免费"，所以显示——响应式不是"窄就一律砍掉"。

**开关**：`MCODE_QUOTA_TAIL` = `auto`（默认）/ `full`（永远保留明细，v2.1.2 行为）/
`compact`（永远不显示，v2.1.0 行为）。

**代价**：逻辑比单一规则复杂（要生成并比较候选）；换行位置在相邻宽度间可能突变，但每个档位
内部是单调的（越宽越好，不会出现"宽 1 列反而更差"）。

**证据**：doctor 18 项含「200 列有明细 / 100 列无明细且上下文仍在」两条；46–260 列逐列扫描
无溢出且阶梯单调。

> **注意**：本条已被 **D16** 取代——`auto` 模式的「最少行数」目标与 D16 的「行 1=token usage
> 永远独占」契约冲突：宽屏单行布局在 D16 下不再生成。新规则下明细仅受「是否 ≥80 列」门控。

### D16 — 始终两段：token usage 行 + 会话 tokens 行

**背景**：之前 D15 的「响应式打分」会在窄屏下让两段挤在一行，结果是：

- token usage 与会话 tokens 在 1 行里同框
- 终端稍微宽点（100 列）就为了明细让 token usage 行反而没空间给进度条

**用户诉求**：「我考虑会话 tokens, 上下文的情况显示和 token usage 还是换行显示，这样屏幕小的时候显示的内容能够更多一点，注意，把 token usage 显示在最后一行，其他信息都显示在 token usage 的上方」

（澄清后：「token usage」= 5小时/周行；「其他信息」= 会话 tokens + 上下文；行序为 token usage 在上、会话+上下文在下。）

**候选**：

1. **保持 D15 不变**—— 1-3 行交替。会话 tokens 与 5h/周共享行；窄屏争空间，宽屏挤瘦进度条。
2. **永远 2 行（推荐）**—— 5h/周永远在状态栏的下一行（紧贴 `~/... │ ✦ model`），会话 tokens + 上下文独立占第 2 行。窄屏退化为 3 行（5h/周拆两行）。

**选择**：2。结构变成**两段式 + 单行 contract**：

- **段 1：token usage 行**（始终独立）。要么 1 行（5h │ 周），要么拆 2 行（5h + 周）。
  拆 2 行时 `周限制使用量` 标签用全宽空格补齐到 5h 同宽，方括号左缘对齐。
- **段 2：会话 tokens + 上下文**（始终独立、**始终 1 行**）。这一行必须能 fit，
  因此候选 tail 按优先级逐个试：detail → compact → 仅会话 → 仅上下文。

**段 1 在不同宽度下的策略**（段间不耦合，各自响应）：

| 段 1 行数 | 触发条件 | 内容 |
|---|---|---|
| 1 行 | 5h+SEP+周 在宽度内 | `5h [...] 剩余 │ 周 [...] 剩余`（无重置倒计时） |
| 2 行 | 上述塞不下 | `5h [...] 剩余 │ 重置 ...` + `周 [...] 剩余 │ 重置 ...`（带重置，标签对齐） |
| 2 行退化 | < ~50 列 | 丢掉方括号和百分比，标签可压缩到 4/0 全宽空格 |
| 3 行（>2） | < ~20 列 | 单字符进度条 + 标签无 padding |

**段 2 候选 tail 优先级**（按"信息多寡"排序，依次试第一个能 fit 的）：

1. detail+上下文（仅 ≥80 列，且 TAIL_MODE 不是 compact）
2. compact+上下文
3. 仅会话（detail 或 compact）
4. 仅上下文
5. 兜底：截断或单 token

`会话 tokens` 永远保留；`上下文` 在宽度极端紧张时可能让位。

**实测阶梯**（会话 ~250M + 上下文 25K/512K）：

| 宽度 | 行数 | 段 1 形态 | 段 2 形态 |
|---|---|---|---|
| ≥80 | 2 | 1 行 token usage | detail + 上下文 |
| 70–79 | 2 | 1 行 token usage | compact + 上下文 |
| 43–69 | 3 | 2 行 token usage（带重置，标签对齐） | compact + 上下文 |
| ≤42 | 3+ | 退化：丢掉方括号与百分比 | 同上 |

**证据**：46–260 列逐列扫描零溢出；真实 pty 起 `mcodex` 在 250 列 / 100 列实测符合契约。
doctor 22 项：200 列有明细 / 100 列有明细（新阈值 ≥80） / 上下文始终在 / 分隔符为 │ /
**顶部 2 行结构**断言。

**代价**：复杂度（两段独立判断、段 1 标签对齐用全宽空格）；段 2 永远 1 行的契约意味着
极窄屏下必须牺牲上下文。

### D25 — 注入逻辑去硬编码：AST 推断 + 容错链 + 升级回归

**背景**：用户原话：「整理相关文档，脚本内容，并按照 ast 语法的角度进行注入逻辑的优化，
sql 查询语句的优化，最终产出就算 mcode update 了之后，仍能够一定程度保持跟踪注入的方式。
我们绝对不能把某些逻辑硬编码为正则匹配或者硬编码的逻辑，锁死在当前 mcode 版本上，
一旦更新了就不能注入了。」

**审计前**（v2.9）注入链里所有"假设 mcode 不变"的地方：

| 位置 | 硬编码内容 | 风险 |
|---|---|---|
| `mcode-find-anchors.mjs` 5 特征 | `this.runtime =` / `this.requestRender =` / `this.statusLineItems =` | 3 个属性名都依赖 mcode 现状 |
| `mcode-find-anchors.mjs` widget 识别 | 必须有本地 `render` 方法 | mcode widget 可继承基类的 `render`（实际就是） |
| `mcode-patch-quota.mjs` `PATCH_RENDER` | 写死 `this.runtime` / `this.shellState` | 字段名变了注入就失效 |
| `mcode-patch-quota.mjs` `SQLITE_SESSION_SQL` | 写死 `input_tokens` / `output_tokens` / ... 列名 | mcode 重命名列名 sqlite 查询就 0 行 |
| `readContextUsage()` | 只读 `__mcodeShellState.contextUsage` | 旧 mcode 把 context 放在 runtime 上 |
| `fetchSessionFromSqlite` | 已知 SQL + 已知列名 | 一次 schema 漂移就全 0 |

**审计后**（v3.0）：

| 位置 | 实现 | 抗漂移能力 |
|---|---|---|
| `mcode-find-anchors.mjs` widget 识别 | 三特征全结构化：super + setInterval + ctor ≥ 2 参数 ≥ 2 字段赋值 | mcode 改任何属性名都仍能识别 |
| `mcode-find-anchors.mjs` 属性名推断 | 扫描 ctor `this.X = firstParam` / `this.X = firstParam.Y`，按候选优先级匹配 | mcode 改 1-2 个属性名仍正确 |
| `mcode-patch-quota.mjs` `buildPatchRender(runtimeProp, shellStateProp)` | 接收推断出的属性名，拼接方法体 | 跟 finder 同步 |
| `mcode-patch-quota.mjs` `resolveSqliteColumns(db)` + `buildSessionSql(cols)` | 运行时 `PRAGMA table_info` 拿实际列，按候选列表 `["input_tokens", "inputTokens", "input"]` 匹配 | mcode 改列名 / 拆表都自动适应 |
| `readContextUsage()` fallback 链 | shellState.contextUsage → shellState.contextWindowTokens → runtime.getContextSnapshot | 老/新 mcode 都覆盖 |
| `mcode-smoke.mjs` | 5 个模拟升级场景（字段改名 / 删字段 / 改 ctor）+ 1 个端到端 fork 重建 + 25 个断言 | 升级前可先 dry-run 验证 |

**模拟场景实测**（`mcode-smoke.mjs` 全绿）：

- 基线未改动 → finder 正确
- `this.runtime` → `this.engine` 单字段重命名 → finder 自动发现 `RUNTIME_PROP=engine`
- 三个 widget 字段全部重命名 → finder 仍正确
- 删除 `statusLineItems` 赋值 → finder 仍正确
- ctor 参数名 `t` → `ttx` 改名 → finder 仍正确
- 完整 fork 重建（端到端）→ launcher 被 patch 上 `__mcodeQuotaRender` 且 `__mcodeShellState` / `__mcodeRuntime` 都被捕获

**仍未完全解决**（用户原话"一定程度"已知上限）：

- mcode 把 widget 移出 launcher-*.js chunk（patcher 找不到 launcher）—— 缓解：doctor
  检查 launcher 是否在，且 mcode-find-anchors 失败时报清晰错误。
- mcode 把 setInterval 改为 requestAnimationFrame / queueMicrotask —— 缓解：finder 现在
  报告 5 个检测到的结构化特征，给升级时定位问题。
- mcode 重构 widget 构造器、把 shell state 改为非首参数 —— finder 仍识别 widget 但
  PATCH_RENDER 取错字段。缓解：mcode-smoke 会失败，要求人为更新。

**关于文档**（用户原话第一句"整理相关文档"）：

- 现状：README / ARCHITECTURE / MAINTENANCE / DECISIONS / CHANGELOG 共 5 份，无大块
  重复。DECISIONS 是新增的"为什么"层，CHANGELOG 是"改了什么"层，两层分离。
- 本次审计后，D25 把"硬编码 → AST 推断"的决策一次性写进 DECISIONS，避免后续维护者
  把硬编码逻辑"修回去"。

### D26 — 任何 async 副作用必须挂 `.catch(() => {})`

**背景**：v3.0.0 在 `readContextUsage()` 同步路径里调了
`runtime.getContextSnapshot()`（无参）。该 API 在 mcode 0.3.10 是 async，
内部 `i.getSession({id:undefined})` 抛 `"Runtime did not return Session
undefined."`，返回的 Promise 立即 reject。

我们的同步 `try { return rt.getContextSnapshot() } catch { return null }`
只能抓**同步** throw。async reject 逃逸后被 Node 升级成 `unhandledRejection`，
mcode 0.3.10 进程级 handler（`e.once("unhandledRejection", u => c(m(u)))`）
把进程带出 `TUI stopped unexpectedly: Session not found: undefined`。

**规则**（推广到所有"sidecar 调 mcode 内部 API"的场景）：

1. **有 sessionId 才调** —— 永远不要无参调 mcode runtime API。即使 sync 路径
   里只是"试探一下"，也要先确认有合法入参。
2. **如果调了，Promise 必挂 `.then(() => {}).catch(() => {})`** —— 哪怕不用
   它的值。同步路径里"只采纳同步结果"只是说"用不用"，不是说"可以让 reject
   逃逸"。
3. **不要假设调用方会 `.catch` 我们的 Promise** —— Node 进程级 listener
   （包括 mcode 自己装的）是兜底；sidecar 必须自包含。

**反例（v3.0.0 之前）**：

```js
const snap = (() => {
  try { return rt.getContextSnapshot(); }   // returns rejected Promise
  catch { return null; }                     // never runs (no sync throw)
})();
```

**正例（v3.0.1+）**：

```js
const sid = globalThis.__mcodeShellState?.agentSessionId || ...;
if (sid && typeof rt?.getContextSnapshot === "function") {
  try {
    const maybe = rt.getContextSnapshot(sid);
    if (maybe && typeof maybe.then === "function") {
      maybe.then(() => {}).catch(() => {});   // <- critical line
    }
    if (maybe && typeof maybe === "object" && Number.isFinite(maybe.usedTokens)) {
      cu = maybe;                              // sync adoption only
    }
  } catch {}
}
```

**已波及**：`readContextUsage()` 全路径已审计。`fetchSessionOnce` 早就是 async
函数 + `Promise.allSettled`，本身就 catch 所有 settle，**不受 D26 规则约束**。

### D27 — patcher 按 mcode 版本分目录

**背景**：v3.0 之前 `mcode-patch-quota.mjs` 是单文件根目录的 patcher。mcode 升级
改 widget 字段后会出现两个问题：

1. **老用户拉最新 master 会拿到基于新 mcode 决策的 patcher**，但他们跑的是老 mcode
   —— AST 候选优先级是基于新 widget 决策的，对老 widget 不是最优；严重时不能正确注入。
2. **git history 不可读**：排查"当时 mcode 0.3.10 的 patcher 是怎么写的"得手动找 commit，
   而且单文件的所有改动挤在一条 branch 上。

**方案**：

```
patches/
├── _loader.mjs              # 按 --current 选 patches/<v>/
├── 0.3.10/                  # mcode 0.3.10 适配（NOTES.md + finder + patcher）
└── 0.3.11/                  # mcode 0.3.11 适配（与 0.3.10 同源；未来若分叉则独立）
```

`patches/_loader.mjs` 的解析规则：

1. 优先 `patches/<请求版本>/` 精确匹配
2. 没有则选**最高 `<=` 请求版本**的目录（X.Y.Z 字典序 = 数值序）
3. 都没有 → 报错并列出可用版本

`mcodex` 调 `_loader.mjs` 而不是直接的 patcher。**老目录的 patcher 代码不被任何东西
覆盖** —— 新 mcode 改了 widget 只需在 `patches/0.3.12/` 加新 patcher（或拷最新版再改），
loader 自动选；老用户继续拿老 patcher 跑。

**NOTES.md 每个版本目录都有一份**，记录：

- 该版本检测到的 widget AST 签名（class / super / 字段名 / 偏移）
- 与上一版的差异（哪些字段 / 偏移 / 决策变了）
- 已知问题（与该 mcode 版本绑定）

**git history 影响**：每个 mcode 版本的 patcher 决策可以独立 commit、单独回滚、单独看
diff；不会因为单文件历史而把"0.3.10 时怎么做"和"0.3.12 时怎么做"挤到同一根 branch 上。

**doctor 影响**：新增 `versioned patches available:` 和 `loader picks patches/X/`（精确
匹配或 `<=` fallback）两行，明示当前 mcode 走了哪个 patch 目录、是否有 fallback。

**对同步的影响**：`mcodex-push-remote` 不变；patches/ 目录随 master 一起推到 GitHub
私有 mirror。老用户从 GitHub clone 后 `patches/<他们的 mcode 版本>/` 自然可用。

**对回滚的影响**：如果新 mcode 改得 patcher 完全不能工作，老用户只需 `git checkout
<上一个好的 commit>` 即可，patches/ 目录会回到那个 commit 的状态，自动用对应版本的
patcher。

**未做**：

- ❌ patcher 之间共享代码（用 `_shared/` 之类的目录）。理由：每个版本的 patcher 是
  独立 snapshot，共享会引入跨版本耦合；当前 0.3.10 / 0.3.11 字节级相同也没合并。
- ❌ 自动检测 mcode 版本 + 自动 clone patches/ 模板。理由：版本目录本质是代码决策
  的版本化，不应该自动生成 —— 自动生成会失去"人 review 决策"的机会。

**已波及**：

- `mcodex` 调 `patches/_loader.mjs`（原调 `mcode-patch-quota.mjs`）
- `mcode-quota-doctor` 加 loader 选择行（精确 vs fallback）
- `tests/mcode-smoke.mjs` 从 live launcher 路径推断 mcode 版本，自动选对应 patches/ 目录
- `mcodex-push-remote` 不变（patches/ 在仓库根下，自动随同步走）

## 3. 明确不做 / 否决清单

| 事项 | 原因 |
|---|---|
| 修改 mcode 安装目录 | 硬约束：必须与 npm 官方包字节一致 |
| `NODE_OPTIONS` 注入 | 子进程继承 → 进程风暴（D1） |
| symlink 复用安装目录做 fork | Node realpath 会让 patch 失效（D2） |
| 用 mcode 的 `totalTokens` 做会话总量 | 口径不同，不含 cache（D5） |
| 为上下文新增轮询 | 现有快照零成本且同源（D6） |
| 在渲染热路径里发请求 | 渲染频率远高于数据变化频率（D7） |
| 单行优先、必要时丢明细 | 明细更有用（D13） |
| 明细永远优先于行数与进度条宽度 | 窄屏既多占行又挤瘦进度条，已改为响应式打分（D15） |
| 单一布局（v2.2.0） | 与「段 2 永远 1 行」契约冲突，已改为两段式（D16） |
| 用固定宽度阈值决定是否丢明细 | 不同会话 token 位数不同，固定阈值不通用（D15） |
| 用全宽空格补齐标签宽度 | 中间空格过多；已改为同字数的标签（D17） |
| 1 行 token usage 模式丢重置 | 用户希望始终看到重置时间；已改为常驻（D17） |
| token usage 行放在最上 / `()` 括号 | 与「贴近 mcode 状态栏 = 自身会话数据」的视觉分组不符，已交换顺序并改用「」（D18） |
| 段 1 只 2 chunk | 缓存命中/轮数是有用信息；段 1 扩为 4 chunk 响应式（D19） |
| `上下文 42K/200K 21%` 旧格式 | 视觉上"上下文"标签冗余、括号风格不一致；改 `51% 「259.0K/512.0K」`（D20） |
| 1/2/0 位小数混排 | 跨越量级时列宽跳变；改 1 位小数统一（D21） |
| 启动时空白几行再逐个冒数据 | 数据在拉，但渲染要"无跳变"；引入占位符 + eager-start（D22） |
| runtime 失败/全 0 才走 sqlite | 串行最坏 ~5s+50ms；改并行（先到先得）（D23） |
| 误删 `上下文` 标签（v2.7） | 用户希望保留；v2.8 恢复（v2.7 误判） |
| 之前所有间距都用 2 空格 | 段 1/段 2 各节省 8–12 列；用户要求"只要呼吸感"（D24） |
| widget 字段 / SQL 列名 / 数据源位置硬编码 | mcode 升级会断；改 AST 推断 + 候选优先级 + 运行时容错链 + 升级回归测试（D25） |
| 同步 `try/catch` 包住 async 调用 | 抓不到 reject；必须显式 `.then(()=>{}).catch(()=>{})` 让 Promise 不能升级 unhandledRejection（D26） |

### D19 — 段 1 增加「缓存命中」+「轮数」

**背景**：用户希望增加两个数据：

1. **缓存命中** = `cache_read / (cache_read + fresh_input)`，判断 prompt cache 的有效性
2. **轮数** = `COUNT(DISTINCT turn_id)`，判断本会话做了多少轮

**调研**：`local_runtime_token_usage` 表同时有 `cache_read_tokens`、`input_tokens`、`turn_id`，
两个数据都从 sqlite 拿得到。当前真实数据：53 轮、缓存命中 98.24%。

**用户对位置的要求**：

> 显示在上下文的后面，屏幕小换行，不小则追加显示
> 放在上下文后，屏幕小换行，否则追加显示，整体布局考虑到，输入输出缓存可以不显示细节，逻辑要做到响应式，屏幕宽显示的详细，屏幕小，显示的粗略，尽可能保持单行，实在放不下就换行，但是换行意味着空间大了，内容又可以便详细了，所以要考虑周全

**候选**：

1. **固定位置**（v2.3 风格：固定模板，按宽度退化）—— 段 1 永远 1 行，宽度不够就丢 chunk。
2. **响应式候选列表**—— 4 chunk 排列成"信息量从高到低"的 11 条候选，逐个试直到有 fit 的。
   fit 不下时降级为多行（`会话` 一行，其余按宽度追加）。

**选择**：2。理由：

- 用户的原话明确要求"屏幕宽显示的详细，屏幕小，显示的粗略"，最贴切是候选列表打分。
- 11 条候选覆盖了"detail/compact × {ctx, hit, turn} × {with/without 上下文}"的所有组合。
- 多行降级让"实在放不下就换行，换行后又能变详细"自洽：宽屏 1 行 4 chunk、中屏 1 行 3 chunk、
  窄屏 1 行 2 chunk、极窄多行。

**SQL 修复**：原来是 `COUNT(*)`，会把同一 turn 的多行都计上（实测会话行数比轮数大很多倍，
错把每次落库都算一轮）。改为 `COUNT(DISTINCT turn_id)`，与"轮数"语义对齐。

**配色**：

- 缓存命中：≥90% 深绿、≥70% 暗黄绿、否则暗橙（提示"该改 prompt 让 cache 命中更准"）。
- 轮数：中性灰（无明显"好/坏"判断）。

**实测阶梯**（当前真实数据：会话 274M，缓存命中 98%，轮数 54）：

| 宽度 | 段 1 渲染 |
|---|---|
| 40 | `上下文 ...`（仅 上下文） |
| 55 | `会话 │ 上下文 │ 轮数 54` |
| 70 | `会话 │ 上下文 │ 缓存命中 98%` |
| 80 | `会话 │ 上下文 │ 缓存命中 98% │ 轮数 54`（全有但无明细） |
| 100 | `会话「明细」│ 上下文 │ 缓存命中 98%` |
| 140+ | `会话「明细」│ 上下文 │ 缓存命中 98% │ 轮数 54`（全有） |

**验证**：

- 20–260 列扫描 0 溢出
- 真实 pty 250 列实测：`会话 tokens 25K 「输入 549 │ 输出 87 │ 缓存 24K」  │  上下文 25K/512K 5%  │  缓存命中 98%  │  轮数 1`
- doctor 22 ok / 0 warn（新增 `缓存命中` / `轮数` 两条断言）
- 22 项单元断言全绿

### D17 — 同字数标签 + 重置时间常驻

**背景**：D16 实现"两段式"后，段 1 在 1 行 / 2 行时仍要做两件事：

1. 让两个标签视觉上对齐（`5小时使用量` 5 字 = 10 列 vs `周使用量` 4 字 = 8 列）
2. 1 行模式下为了塞下整行丢掉了重置倒计时

用户原话：「在屏幕足够宽的情况下，也没有显示具体的刷新时间，理论上 5小时使用量，周使用量是有刷新时间的」「为了保证一致性，我们可以考虑使用 [新标签名]… 文字上字数保持一致，就不用做多于的排版设计了，逻辑更加简单一点」

**候选**：

1. **继续用全宽空格补齐**（v2.3 现状）—— 中间挤 4 个全宽空格，视觉上仍松散；且 `paddedLabel` 逻辑绕。
2. **同字数新标签 + 重置常驻**（推荐）—— 把 `5小时使用量` → `小时会话窗口`，`周使用量` → `周限制使用量`，都是 6 字 / 12 列。

**选择**：2。`小时会话窗口` + `周限制使用量` 都是 6 字 / 12 列，**两个标签天然对齐**——
`paddedLabel` 的 padding 退化到 0（不需要），段 1 内部不再有任何对齐代码。

**重置常驻**：

- 删掉 `q5h` / `qwh`（无重置的 1 行变体）。1 行 token usage 始终用 `q5(bar)+SEP+qw(bar)`，自带 `│ 重置 4h 5m`。
- 代价：1 行所需的最低宽度从 ~80 列升到 ~98 列（带两组重置）。这正好是 2026 年实际终端的常见宽度，没问题。
- 段 1 退化阶梯（带重置）：
  | 段 1 行数 | 触发 | 内容 |
  |---|---|---|
  | 1 | ≥98 | `小时会话窗口 [...] 剩余 │ 重置 4h 5m │ 周限制使用量 [...] 剩余 │ 重置 4d 13h` |
  | 2 | 47–97 | 每行各带重置，标签天然对齐 |
  | 3+ | <47 | 退化（丢方括号 / 丢百分比 / 截断标签） |

**验证**：

- 46–260 列扫描 0 溢出（<20 列终端属 best effort）
- 真实 pty 250 列实测：`小时会话窗口 [███] 95% 剩余 │ 重置 4h 5m │ 周限制使用量 [███] 82% 剩余 │ 重置 4d 13h`
- 单元 22 项断言全绿
- doctor 22 项全 ok

**收益**：

- 标签中无任何填充字符，视觉上"自然分隔"
- `paddedLabel` 在 1 行/2 行场景下不再被使用（`labelWidth` 仅作为窄屏退化的内部参考）
- 段 1 逻辑简化（去掉 `q5h` / `qwh` 两份变体）

---

## 4. 计划

### 已完成（用户诉求闭环）

- [x] 5小时 / 周限制使用量：剩余百分比 + 进度条 + 重置倒计时（v2.4 起标签改为「小时会话窗口 / 周限制使用量」，重置时间常驻）
- [x] 会话 tokens：累计总量 + `输入 / 输出 / 缓存` 明细
- [x] 上下文：`已用/总量 + 百分比`，阈值变色提示压缩时机
- [x] 分隔符统一为 `│`
- [x] 响应式排版：窄屏自动放弃明细，把空间让给进度条与上下文（D15）
- [x] 隔离架构：mcode 本体零修改、私有 fork、`mcodex` 入口、doctor 22 项自检
- [x] 抗升级：AST 锚点匹配 + 版本变化自动重建 fork + 失败回退官方 mcode

### 待办（按优先级）

- [ ] `mcode-patch-quota.mjs --revert`：一键删除 fork 并还原（目前靠手删目录）
- [ ] 多 TUI 实例共享 `mmx` 轮询：目前每个 mcode 进程独立 fork `mmx`
- [ ] 会话切换立即刷新：现在依赖 10s 轮询
- [ ] 多 model 支持：同时显示 video / general 等其它配额
- [ ] 装饰性图标（nerd font / emoji），可选开关

### D18 — 段顺序倒置 + 明细括号 `「」`

**背景**：v2.3 / v2.4 的段顺序是：

```
[ mcode 状态栏 ]
段 1: 小时会话窗口 / 周限制使用量
段 2: 会话 tokens + 上下文
```

用户诉求：「调换一下顺序，会话 tokens, 上下文，和现在的小时会话窗口，周使用量的上下顺序调换一下」；
并附：明细括号 `()` 改成「」（更符合中文排版习惯）。

**候选**：

1. **保持原顺序**——`会话 tokens` 离 mcode 状态栏远一行，离"自身会话进度"也远一行。
2. **倒置**——`会话 tokens + 上下文` 移到段 1（最贴近状态栏），`小时会话窗口 / 周限制使用量` 移到段 2。

**选择**：2。理由：

- 段 1（紧贴 mcode 状态栏）显示与 mcode 自身**同一类**的数据：当前会话进度。
  段 2 显示 mcode 之外的外部数据：MiniMax 配额。
  视觉上「先看见自己的数据，再看见配额」，与 mcode 内部的状态栏语义更连续。
- 旧顺序反过来：先看配额再看会话，会让人误以为这是 MiniMax 配额提示行（其实 mcode 自身的 TUI 状态栏已经在显示 token 进度了）。

**括号风格**：

- `()` 在中文里有"说明 / 旁注"语义，但英文括号本身在中文里很常见，不一定错。
- 用户明确偏好 `「」`（全角直角引号），更符合中文排版习惯；**直接照做**。
- 改动只 1 行：`" (" + ... + ")"` → `" 「" + ... + "」"`。

**实现要点**：

- 段顺序：`lines.push(...bottom); lines.push(...topRows);`（v2.3 是反过来）。
- 段 2 渲染逻辑（候选 tail 优先级）**完全没动**——它本来就独立于段 1。
- doctor 段顺序断言改写为「会话 tokens 在上 / token usage 在下」。

**实测**（250 列）：

```
会话 tokens 265.1M 「输入 4.51M │ 输出 768K │ 缓存 259.8M」  │  上下文 42K/200K 21%
小时会话窗口 [███████████████████░] 93% 剩余  │ 重置 3h 57m  │  周限制使用量 [████████████████░░░░] 82% 剩余  │ 重置 4d 12h
```

**验证**：

- 真实 pty 250 列实测：`会话 tokens 21K 「输入 4K │ 输出 187 │ 缓存 17K」  │  上下文 21K/512K 4%`
- doctor 20 ok / 0 warn
- 单元 22 项断言全绿
- 46–260 列扫描 0 溢出

### 观察中

- mcode 若改动 TUI 状态栏结构（不再继承基类 / `render` 契约变化），需更新
  `mcode-find-anchors.mjs` 特征列表，见 `MAINTENANCE.md §5`
- fork 每个版本约 62MB，版本累积后考虑清理旧 fork
