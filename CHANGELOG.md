# Changelog — mcode quota patch

记录每次对工具集的修改。新条目加在最上面。

## 2026-09-10 — v3.2.1：今日行 model 名中间省略

### 诉求

> 对于模型名字超长的情况，建议使用中间省略的形式进行展示，不要让模型名字
> 过长，影响最终的展示效果。

### 背景

v3.2.0 引入的今日行直接显示 `data_json.context_usage_telemetry.model` 字段
字面量。Model 名是运行时写入的，没规范化 — 用户的 GGUF 文件名、自定义
fine-tune 名、API key 过期别名（如 `deepseek-v4.1-flash-expires-on-0910`）
经常超过 30 字符。最坏情况：

- `Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf`（56 字符）
- `MiniCPM5-1B-Claude-Opus-Fable5-V2-Thinking`（42 字符）

在 200 列 pty 下，1 个 56 字符 model 就吃掉 1/3 整行；多 model 共存时后面
几个被右边裁掉。

### 变更

- 新增 `shortenModelName(name)`：超过 32 字符时保留 head (19 chars) + `…` (U+2026)
  + tail (12 chars) = 32 字符上限。Family 名（开头）和版本/量化（结尾）都还能
  看到，中间描述性部分被省略
- `renderTodayByModelRow` 在 `buildOne()` 里调用 `shortenModelName(it.model)`，
  每个 model 单独截断后再 join —— 不再让单条占满整行

### 显示示例

截断前（56 字符 GGUF + 35 字符 deepseek）：

```
今日 「MiniMax-M3」 10.7B │ 「glm-5.3-flash」 174.6M │ 「deepseek-v4.1-flash-expires-on-0910」 93.3M │ 「deepseek-v4-flash」 85.3M │ 「Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf」 2.6M
```

截断后：

```
今日 「MiniMax-M3」 10.7B │ 「glm-5.3-flash」 174.6M │ 「deepseek-v4.1-flash…ires-on-0910」 93.3M │ 「deepseek-v4-flash」 85.3M │ 「Qwen3.6-35B-A3B-Unc…-Q4_K_M.gguf」 2.6M
```

200 列下从 5 个 model 全部装下（171 cols → 171 cols，但内部条目都 ≤ 32 字符）。

### 验证

- `tests/mcode-smoke.mjs` 新增 shortenModelName 行为测试（10 个用例），全部通过
- doctor 21/0/0
- smoke 35/35（25 + 10）
- mcode 本体 0 字节修改
- 0.3.10 / 0.3.11 patcher 仍 byte-identical (sha256 `139d1170...`)

## 2026-09-10 — v3.2.0：今日按 LLM 模型 token 统计

### 诉求

> 我想增加一个显示在小时会话和周限制使用量的下方，显示一个统计，今天用过什么模型，
> 每个模型消耗了多少 token 的统计。

数据源 `local_runtime_message_rows.data_json.context_usage_telemetry.model`
关联到 `local_runtime_token_usage.turn_id`（`token_usage.model` 列在 0.3.11
始终为 NULL，只能走 message rows 的 JSON）。

### 变更

- 新增 `fetchTodayByModelFromSqlite()`：取本地 00:00 起的 turn_id→model 映射，
  聚合 token_usage，按 LLM 模型分组
- 新增 `renderTodayByModelRow(width)`：响应式（宽屏多模型，窄屏 top-N），
  输出 `今日 「model」 X.XM`
- 60s 轮询（`TODAY_TTL_MS`），跨日自动刷新
- 数据源与 mmx 独立：mmx 失败时 today 仍能出

### 布局（v3.2.0 重做）

首版 ship（commit `51243ec`）合并 5h/周 + 今日 到一行并删除 4-chunk。用户反馈
4 类数据都是需要的不同维度，要求恢复 4-chunk 并把 今日 单独一行。重做后：

- **4-chunk 行**（独立第一行）：`会话 tokens X.XM 「输入 │ 输出 │ 缓存」 │ 上下文 N% 「X/Y」 │ 缓存命中 N% │ 轮数 N`
- **5h/周 行**（独立第二行）：`小时会话窗口 [bar] N% 剩余 │ 重置 … │ 周限制使用量 [bar] N% 剩余 │ 重置 …`
- **今日 行**（独立第三行）：`今日 「model」 X.XM │ …`（响应式 top-N）

3 行各占独立行，PATCH_RENDER 用 v3.0.0 风格 `[...r, ..._qr]`。早期 D28 担心的
"framework 裁掉 1 行"在 200 列 pty 上不发生（Xc parent 返 `["", r]` 2 元素，
我们返 3 元素，framework 把 5 元素都画出来）——D28 的具体 ship 决策被推翻，
但"先看 framework 接受几行"这条原则保留（见 DECISIONS.md D28 update）。

显示示例（200 列）：
```
会话 tokens 152.3M 「输入 1.3M │ 输出 366.2K │ 缓存 150.6M」 │ 上下文 28% 「145.0K/512.0K」 │ 缓存命中 99% │ 轮数 984
小时会话窗口 [████████░░░░░░░░░░░░] 41% 剩余 │ 重置 3h 1m │ 周限制使用量 [██████████████████░░] 92% 剩余 │ 重置 3d 7h
今日 「MiniMax-M3」 867.4M
```

数据未到位时（mmx 还没回 / session 还没 fetch）4-chunk / 5h/周 走 placeholder
`…`，今日 走 `今日 …` 或隐藏。

### 抗升级

`fetchTodayByModelFromSqlite()` 用 SQL `json_extract` 在
`local_runtime_message_rows` 上（该表有 `created_at_ms` 普通索引），数据量 30K 行
时单次查询 < 100ms。schema 漂移被 try/catch 兜住，today 行最多回退到不显示。

### 验证

- 真实 pty 200 列：4-chunk / 5h/周 / 今日 3 行各自 re-paint（25s 抓到 ~30 帧）
- 单元 test：`__mcodeQuotaRender(200)` 5 帧连测均返 3 元素
- doctor 21/0/0（含新增的 `4-chunk present` 和 `3 lines painted` 检查）
- smoke 25/25
- mcode 本体 0 字节修改

### 后续整理（5d2beaf 后的 review pass）

- patcher 内遗留首版 ship 时的旧注释（"framework clips to 2 elements"）已替换
  为 v3.2.0 重做后的注释
- `DECISIONS.md` 顶部摘要表里的 D28 旧描述已跟新 D28 详细段对齐
- `patches/<v>/NOTES.md` sha256 重新 pin 到清理后的 `0428cc6c14...`（D27 byte-identical 保持）
- `README.md` 顶部"效果"小节从 2 行结构更新为 3 行结构；
  数据源表新增"今日 按 LLM 模型"行

## 2026-09-10 — v3.1.0：patches/ 版本目录机制 + 测试目录化

### 动机

> 整理优化当前的相关文档和脚本，将状态调整到最佳，然后同步到远程仓库中。
> 另外注意好 mcode 版本的跟踪，即从 0.3.10 开始，如果每个版本的 patch 方式或者
> 脚本有变动，应该有对应的目录做区分，方便回溯问题，或者给老版本的用户安装体验。

v3.0 之前 patcher 是单文件（`mcode-patch-quota.mjs`），mcode 升级改 widget 后
老用户拉 master 会拿到不匹配的 patcher 决策。v3.1 引入**按 mcode 版本分目录的 patcher
仓库**，从 0.3.10 起每个版本都有独立的 finder / patcher / NOTES.md，loader 按
`--current` 选目录，找不到精确匹配时回退到最近 `<=` 版本（D27）。

### 变更

#### 1. 目录重构

```
mcode-quota/
├── mcodex                       # 改调 patches/_loader.mjs
├── mcode-quota-doctor           # 新增 versioned patches / loader picks 行
├── patches/                     # 新：按 mcode 版本分目录
│   ├── _loader.mjs
│   ├── 0.3.10/                  # finder + patcher + NOTES.md
│   └── 0.3.11/
├── tests/                       # 从根移过来
│   ├── mcode-smoke.mjs
│   └── README.md
├── README / ARCHITECTURE / MAINTENANCE / DECISIONS / CHANGELOG
└── package.json (3.1.0)
```

老 patcher / finder 从根目录消失，逻辑上 1:1 搬到 `patches/0.3.10/` 和 `patches/0.3.11/`。
**两个版本的 patcher 当前字节级相同**（widget 字段未改），但作为独立目录存储 —— 未来
分叉时各自演进。

#### 2. patches/_loader.mjs

- 读 `--current=<version>` from argv
- `patches/<v>/` 精确匹配 → 用
- 否则选**最高 `<=`** 请求版本的目录（X.Y.Z 字典序 = 数值序）
- 都没有 → 报错并列出可用版本；`mcodex` 走 fallback 分支跑未打 patch 的官方 mcode

#### 3. tests/ 目录化

- `mcode-smoke.mjs` 从根移过来；自动从 live launcher 路径推断 mcode 版本，自动选
  对应 `patches/<v>/` 的 finder / patcher
- 加 `tests/README.md` 说明各场景

#### 4. 文档

- `ARCHITECTURE.md` §5.1 patches/ 调度 + 版本目录
- `MAINTENANCE.md` §5.5 "加新 mcode 版本" 流程
- `DECISIONS.md` D27（含未做清单）
- `README.md` 文件树 + 入口描述更新
- `package.json` 3.1.0，bin 指向实际入口脚本

### 兼容性

- 老的 `mcodex` 路径（直接调 `mcode-patch-quota.mjs`）不再可用 —— mcodex 已经
  重写为调 loader，外部脚本若有人 hardcode 旧路径会断
- 老的 `mcode-find-anchors.mjs` / `mcode-patch-quota.mjs` 在根目录的引用全部失效
- `mcodex-push-remote` 不变

### 验证

- `mcode-quota-doctor` 22/0/0，新加 `versioned patches available: 0.3.10 0.3.11` 行
  和 `loader picks patches/0.3.11/ (exact match)`
- `node tests/mcode-smoke.mjs` 25/25 pass
- loader 三种路径全过：精确匹配（0.3.11）/ 回退（0.3.12 → 0.3.11）/ 太老报错（0.3.9）
- mcode 本体 0 字节修改（fork 隔离仍成立）

## 2026-09-09 — v3.0.2：双端备份（GitHub 私有 mirror）

- 新建 GitHub 私有仓库 `weekbin/mcode-quota`（默认分支 `master`）
- 历史通过 `git subtree split --prefix=mcode-quota` 从父 monorepo 抽出，
  父仓库的 init commit 正确剔除，24 个内容 commit 全量推上 master
- 新增 `mcodex-push-remote` 脚本：subtree split + 临时 mirror + gh-credential
  helper + push 一条龙；幂等可重跑；父仓库的 remote 不被污染
- 以后改完本地代码只需 `./mcodex-push-remote` 一行就同步到 GitHub

## 2026-09-09 — v3.0.0：硬编码逻辑全面 AST 化 + 升级漂移回归测试

### 动机

> 整理相关文档，脚本内容，并按照 ast 语法的角度进行注入逻辑的优化，sql 查询语句的优化，最终产出就算 mcode update 了之后，仍能够一定程度保持跟踪注入的方式。我们绝对不能把某些逻辑硬编码为正则匹配或者硬编码的逻辑，锁死在当前 mcode 版本上，一旦更新了就不能注入了。

之前 mcode-find-anchors 的 5 特征里有 3 个是**硬编码属性名**（`runtime` / `requestRender` / `statusLineItems`），
sidecar 的 `PATCH_RENDER` 也是手写 `this.runtime` / `this.shellState`。这些在 mcode 重命名 / 改变构造签名时
就会失效。本次整体性替换为 **AST 推断 + 名称候选优先级** + **运行时容错链**。

### 变更

#### 1. mcode-find-anchors：硬编码名称 → AST 推断

- **widget 识别**改为三特征（全部结构化，不依赖属性名）：
  - 存在 `super()` 调用
  - 类体内有 `setInterval(...)` 调用（这是 widget 唯一稳定的结构信号 — 状态栏轮询）
  - 构造器接收 ≥ 2 个参数，并将其中的 ≥ 2 个赋给 `this.X` 字段
- **`render` 方法不再是必需**：mcode widget 可继承基类的 `render`，不应误判。
- **属性名推断**：扫描构造器体，对每个 `this.X = firstParam` 或 `this.X = firstParam.Y`，
  按优先级 `runtime > _runtime > rt > tu > r > context > ctx` 选 `runtime`；按
  `shellState > _shellState > shell > state` 选 `shellState`；找到后 emit `RUNTIME_PROP` / `SHELLSTATE_PROP`。
- **去掉 `BASE = widget.superClass` 的硬编码检查**：基类名也会动态从 `widget.superClass.name` 读取。

#### 2. mcode-patch-quota：动态 PATCH_RENDER

- 不再硬编码 `this.runtime` / `this.shellState`。
- `PATCH_RENDER` 改为 `buildPatchRender(runtimeProp, shellStateProp)` 函数，
  从 `mcode-find-anchors` 拿到的 AST 推断结果拼出方法体。
- 标识符有正则校验（`/^[A-Za-z_$][A-Za-z0-9_$]*$/`），不合法时跳过对应行（不写脏字符串）。

#### 3. sidecar 数据源：上下文容错链

- `readContextUsage()` 现在走 fallback 链：
  1. `__mcodeShellState.contextUsage.usedTokens`（新 mcode）
  2. `__mcodeShellState.contextWindowTokens`（窗口大小回退）
  3. `__mcodeRuntime.getContextSnapshot(sid)`（旧 mcode，runtime 直接提供；只在
     有 `agentSessionId` 时才调；返回 Promise 时显式 `.catch(() => {})` 避免
     unhandledRejection 触发 mcode 0.3.10 的进程级 TUI-stopped 处理）
- 任一可用即采纳，缺失返回 null 并显示占位符。
- **同步路径只采纳同步结果**：mcode 0.3.10 的 `getContextSnapshot` 是 async
  返回 Promise，这里是 render 同步路径，async 结果无法立即使用（让 async
  snapshot 走下次 render 即可），但绝不能因为 reject 而让 Promise 逃逸到
  进程级 unhandledRejection 监听器。

#### 4. SQL 查询：列名 schema 探测

- 之前 `SQLITE_SESSION_SQL` 是**硬编码**列名 `input_tokens` / `output_tokens` / ...
  的聚合查询。
- 现在 `fetchSessionFromSqlite` 走 `resolveSqliteColumns(db)`：运行时 `PRAGMA
  table_info(...)` 拿实际列名，按候选列表 `["input_tokens", "inputTokens", "input"]` 等
  匹配，再用 `buildSessionSql(cols)` 动态生成 SQL。
- mcode 改列名、合并表、引入新表时**自动适应**，不会因列名漂移而静默 0 行。
- 必要列（`input / output / cache_read / session_id`）缺失才返回 null。

#### 5. mcode-smoke.mjs：升级漂移回归测试

- 新增 `mcode-smoke.mjs`，从真实 launcher 拷贝 + 模拟 mcode 改名 / 删字段 / 调换 ctor 顺序，
  跑 finder 和 patcher，断言所有锚点仍能正确发现。
- **5 个场景 + 25 个断言全绿**，覆盖：
  - 基线未改动
  - `this.runtime` → `this.engine` 单字段重命名
  - 三个 widget 字段全部重命名
  - 删除 `statusLineItems` 赋值
  - ctor 参数名 `t` → `ttx` 改名
- 新增 fork 端到端：完整 rebuild 一次 fork，验证 launcher 真的被 patch 上了 render
  override 且 `__mcodeShellState` / `__mcodeRuntime` 都被捕获。
- 跑：`node mcode-smoke.mjs`。

### 验证

- 真实 mcode 0.3.10 launcher：finder 仍正确返回 `WIDGET=jf`, `RUNTIME_PROP=runtime`,
  `SHELLSTATE_PROP=shellState`（与 v2.9 完全等价）
- 模拟 mcode 重命名 widget 字段：finder 自动发现新名（`engine` 等）
- mcode-smoke 25/25 通过
- doctor 22 ok / 0 warn / 0 fail
- 22 项单元断言全绿
- 20–260 列扫描 0 溢出
- 真实 pty 250 列：渲染正常

### 仍非万无一失

这些改进让 mcode 升级后的注入成功率从「依赖具体类名 / 列名」提升到「依赖行为签名」，
但以下场景仍可能需要更新代码：
- mcode 把 widget 移出 launcher-*.js chunk（patcher 找不到 launcher）
- mcode 把 setInterval 改为 requestAnimationFrame / queueMicrotask（finder 漏过 widget 特征）
- mcode 重构 widget 构造器、把 shell state 改为非首参数（finder 仍能识别但 PATCH_RENDER 取错字段）

mcode-smoke 模拟了其中部分情况，但完整覆盖需要真实 mcode 升级验证。

## 2026-09-09 — v3.0.1：fix v3.0.0 unhandledRejection 闪退

### 症状

v3.0.0 上线后 mcodex 启动后约 50s 闪退：

```
Minimax Code TUI stopped unexpectedly: Session not found: undefined. Restart MCode;
if it keeps happening, report it through an available support channel.
```

真实 pty 抓包：崩溃发生在用户输入 "hi" 触发本地 turn 提交之后。

### 根因

v3.0.0 在 `readContextUsage()` 的 fallback 路径里同步调用了 `runtime.getContextSnapshot()`
—— **没有传 sessionId 参数**。该 API 在 mcode 0.3.10 是 async 实现，内部走
`i.getSession({id:undefined})` → `if(!s)throw new Error("Runtime did not return Session undefined.")`。

我们的同步 `try/catch` 只能抓同步抛错，async 返回的 Promise 是**已经 rejected** 的
—— 而且我们既没 await，也没在 Promise 上挂 `.catch`，于是 Node.js 的 `unhandledRejection`
事件触发 mcode 0.3.10 的进程级 handler：

```js
e.once("unhandledRejection", u => c(m(u)))
```

最终以 `TUI stopped unexpectedly` 形式退出。错误信息中的 "Session not found: undefined"
是 mcode 内部 unhandledRejection 落地时输出的非首要文案。

### 修复

1. `getContextSnapshot` 只在有 `agentSessionId` 时才调（之前是无条件调）
2. 一旦调，无论结果用不用，Promise 都接 `.then(() => {}).catch(() => {})`，让
   reject 永远无法升级为 unhandledRejection
3. 同步路径只采纳同步结果（async snapshot 走下次 render）

### 验证

- 真实 pty 140 列：TUI 不再闪退，`会话 tokens 25.1K` / `上下文 21% 「42.0K/200.0K」` /
  `缓存命中 13%` / `轮数 61` 全部正常出数
- mcode-smoke 25/25 通过
- doctor 22 ok / 0 warn / 0 fail
- mcode 本体 0 字节修改（fork 隔离成立）

## 2026-09-09 — v2.9.0：缩减多余空格

### 诉求

> 排查一下现在的整体逻辑，不必要的空格减少一点，只要有呼吸感就可以了，不用空太多

### 变更

- **`SEP`**：左右各 2 空格 → **各 1 空格**。` │ ` 替代 `  │  `。段 1 的 N 个 chunk 共享这 N-1 个分隔符，整行直接省 2(N-1) 列。
- **段 2 标签后空格**：重置倒计时前的 2 空格 → 1 空格。stack 模式下节省一列。
- **段 1 `上下文 X% 「…」`**：百分比和「」之间留 1 空格，与「输入 │ 输出 │ 缓存」内部 `│` 周围的视觉节奏一致。

### 视觉对比

```
v2.8 (250 列):
会话 tokens 312.1M 「输入 4.8M │ 输出 819.2K │ 缓存 306.5M」  │  上下文 21% 「42.0K/200.0K」  │  缓存命中 98%  │  轮数 58
小时会话窗口 [...] 84% 剩余  │  重置 3h 15m  │  周限制使用量 [...] 81% 剩余  │  重置 4d 12h

v2.9 (250 列):
会话 tokens 316.4M 「输入 4.8M │ 输出 823.7K │ 缓存 310.8M」 │ 上下文 21% 「42.0K/200.0K」 │ 缓存命中 98% │ 轮数 58
小时会话窗口 [...] 83% 剩余 │ 重置 3h 12m │ 周限制使用量 [...] 81% 剩余 │ 重置 4d 12h
```

段 1 单行宽 ≈ 187 → 175 列（-12）。段 2 单行宽 ≈ 92 → 88 列（-4）。

### 验证

- 真实 pty 250 列实测：紧凑度提升，呼吸感保留
- 22 项单元断言全绿
- doctor 22 ok / 0 warn / 0 fail
- 20–260 列扫描 0 溢出

## 2026-09-09 — v2.8.0：启动占位符 + session fetch 性能优化

### 诉求

> 我重启了，但是刚启动的时候内容显示不全，能不能考虑有展位的显示替代显示一下告知正在获取呢？或者 sql 查询相关的逻辑能不能优化一下，速度更快一点

> 另外我发现，现在实际的展示效果里，上下文三个字没有了

### 变更

#### 1. 启动占位符

- 新增 `pendingPlaceholders = { quota, session, context }`：每个数据源第一次填充时清除对应标志。
- 渲染时若该数据源尚未填充，返回 `muted("标签 …")` 占位（例如 `会话 tokens …`、`上下文 …`）。
- 第一次渲染就能看到**完整结构**（4 个 chunk 都在），不会像之前那样"先空白几行再逐个冒出来"造成视觉跳变。
- 真实 pty 实测：前 ~500ms 显示 `会话 tokens … │ 上下文 … │ 缓存命中 … │ 轮数 …`，数据到位后无缝替换。

#### 2. 启动时立即触发数据拉取

- sidecar import 末尾新增 `queueMicrotask(() => start())`。
- sidecar 只由 TUI 进程的 `cli.js` 静态 import，加载等同于「TUI 即将渲染」，立即拉取数据是安全的。
- 旧逻辑：第一次 `__mcodeQuotaRender` 调用才触发 `start()`，fetch 是 async，所以前 1–3 帧数据都还没到。
- 新逻辑：import 时就 fire 数据拉取，第一帧渲染时 fetches 已经在路上。

#### 3. 渲染时 re-kick 会话拉取

- TUI 的 widget.render 是在它**第一次真正渲染**时才通过 `globalThis.__mcodeShellState = ...` 暴露 `agentSessionId`。
- 修复：sidecar 的 `__mcodeQuotaRender` 检测到 `agentSessionId` 首次出现时，立即重置 session cache 并 fire `fetchSessionOnce()`。
- 之前是：sidecar 启动早于 TUI，所以 `fetchSessionOnce` 看到 `shell=null` 直接返回，要等 10s 定时器才再次尝试。

#### 4. 上下文显示恢复 `上下文` 标签

- v2.7 误删了 `上下文` 三个字，v2.8 恢复。
- 现在格式：`上下文 21% 「42.0K/200.0K」`（标签 + 百分比前置 + 「」括号）。

#### 5. session fetch 并行化（性能优化）

- 之前：`getSessionUsageSummary` → 等结果 → 若空再走 sqlite（串行，最坏 ~5s+50ms）。
- 现在：`Promise.allSettled([runtime, sqlite])` 并行跑，**先到的赢**，慢的那个结果丢弃。
- 实测：sqlite 通常 50ms 内返回，runtime 有时更快；最坏情况下并行让首次 fetch 至少省 50ms。

### 验证

- 真实 pty 250 列：早期帧显示 `会话 tokens … │ 上下文 … │ 缓存命中 … │ 轮数 …`，数据到位后无缝替换
- 22 项单元断言全绿
- doctor 22 ok / 0 warn / 0 fail
- 20–260 列扫描 0 溢出

## 2026-09-09 — v2.7.0：上下文显示格式优化 + 数字精度统一

### 诉求

> 上下文 51% 「259K/512K」 这样子显示效果比现在更加清晰
> 为了保证不会有动态跳跃的效果出现，建议每个数据的精度都统一固定，现在小数点后两位有时候有有时候没有，不是非常一致

### 变更

#### 上下文显示格式

- **百分比前置** + **去 `上下文` 标签** + **括号用 `「」`**。
- 旧：`上下文 42K/200K 21%`；新：`51% 「259.0K/512.0K」`。
- 颜色逻辑不变：≥90% 暗红、≥75% 暗橙、否则深绿。
- 仍然排在 `会话 tokens` 之后。

#### 数字精度统一

- `fmtTok` 改为**全部 1 位小数**（K / M 都有 1 位小数；纯整数 < 1000 保持原样）。
- 旧：`218M / 4.3M / 4.30M / 42K / 42.0K / 618`（1 / 2 / 0 位小数混排）。
- 新：`218.0M / 4.3M / 42.0K / 618`（统一 1 位小数或纯整数）。
- 副作用：**列宽稳定**——之前 `4.3M` 突然变 `218M` 时数字列会跳变；现在 `4.3M` → `218.0M` 也只多 2 字符。

### 验证

- 真实 pty 250 列实测：`会话 tokens 24.9K 「输入 550 │ 输出 95 │ 缓存 24.3K」  │  5% 「24.9K/512.0K」  │  缓存命中 98%  │  轮数 1`
- 20–260 列逐列扫描 0 溢出
- 22 项单元断言全绿
- doctor 22 ok / 0 warn（上下文期望值同步改为 `21% 「42.0K/200.0K」`）

## 2026-09-09 — v2.6.0：新增「缓存命中」 + 「轮数」两字段，段 1 响应式重做

### 诉求

> 缓存平均命中这个数据可以增加吗？另外就是当前会话总共跑了多少轮的数据，是否能够增加？调研一下这两个数据能否从 sqlite 中获取到，我也想增加进去

### 调研

`local_runtime_token_usage`（sqlite）字段：

- `input_tokens`（fresh input，不命中 cache）
- `output_tokens`
- `cache_read_tokens`（命中）
- `cache_write_tokens`
- `turn_id`（每次 turn 一个）

可推导：

- **缓存命中** = `cache_read_tokens / (cache_read_tokens + input_tokens)`
- **轮数** = `COUNT(DISTINCT turn_id)`

实测当前会话：53 轮、缓存命中 98.24%。

### 变更

- SQL 改为 `COUNT(DISTINCT turn_id)`（原来是 `COUNT(*)`，会把同一 turn 的多行都计上）。
- `session` 新增 `cacheHit`（0–1 浮点，`null` = 无数据）。
- 新增 `renderCacheHitChunk()`：显示 `缓存命中 N%`，配色按 `≥90 深绿 / ≥70 暗黄绿 / 否则暗橙`。
- 新增 `renderTurnCountChunk()`：显示 `轮数 N`，中性灰。
- 段 1 **响应式重做**：候选列表按"信息量从高到低"排列，逐个试直到有能 fit 当前宽度的：
  ```
  会话[detail] │ 上下文 │ 缓存命中 │ 轮数
  会话[detail] │ 上下文 │ 缓存命中
  会话[detail] │ 上下文 │ 轮数
  会话[detail] │ 上下文
  会话[compact] │ 上下文 │ 缓存命中 │ 轮数
  会话[compact] │ 上下文 │ 缓存命中
  会话[compact] │ 上下文 │ 轮数
  会话[compact] │ 上下文
  会话[detail]
  会话[compact]
  上下文
  ```
  `auto` 模式：能 fit detail 就给 detail，fit 不了就降级到 compact。
  任何 fit 不下的情况：降级为多行（`会话` 一行、`上下文/缓存命中/轮数` 后续按宽度追加）。
- `MCODE_QUOTA_TAIL` 仍然控制是否给 detail：影响"明细」括号里有无 `输入/输出/缓存`"，不影响缓存命中/轮数的显隐。

### 实测阶梯（当前真实数据：会话 274.4M，缓存命中 98%，轮数 54）

| 宽度 | 段 1 渲染 |
|---|---|
| 40 | `上下文 42K/200K 21%`（仅 上下文） |
| 55 | `会话 274.4M │ 上下文 ... │ 轮数 54` |
| 70 | `会话 274.4M │ 上下文 ... │ 缓存命中 98%` |
| 80 | `会话 274.4M │ 上下文 ... │ 缓存命中 98% │ 轮数 54`（全有但无明细） |
| 100 | `会话 274.4M 「输入 │ 输出 │ 缓存」 │ 上下文 ... │ 缓存命中 98%`（明细但无轮数） |
| 140+ | `会话 274.4M 「输入 │ 输出 │ 缓存」 │ 上下文 ... │ 缓存命中 98% │ 轮数 54`（全有） |

### 验证

- 20–260 列逐列扫描 **0 溢出**
- 真实 pty 250 列实测：`会话 tokens 25K 「输入 549 │ 输出 87 │ 缓存 24K」  │  上下文 25K/512K 5%  │  缓存命中 98%  │  轮数 1`
- 22 项单元断言全绿
- doctor 22 ok / 0 warn（新增「缓存命中 / 轮数」两条断言）

## 2026-09-09 — v2.5.0：调换段顺序 + 明细括号改「」

### 诉求

1. 调换段顺序：`会话 tokens + 上下文` 移到最上面（紧贴 mcode 状态栏），
   `小时会话窗口 / 周限制使用量` 移到下面。
2. 明细括号 `()` 改成 `「」`，更符合中文排版习惯。

### 变更

- **段顺序交换**：v2.4 的段 1（token usage）下移到段 2；段 2（会话 tokens + 上下文）上移到段 1。
  紧贴 mcode 状态栏的那一行变成「这条会话累计花了多少 token + 上下文还剩多少」——
  跟 mcode 自身的会话进度信息属于同一类，比配额配额更相关。
- **明细括号**：`「输入 4K │ 输出 187 │ 缓存 17K」`，全角引号风格。

### 实际渲染（250 列）

```
会话 tokens 265.1M 「输入 4.51M │ 输出 768K │ 缓存 259.8M」  │  上下文 42K/200K 21%
小时会话窗口 [███████████████████░] 93% 剩余  │ 重置 3h 57m  │  周限制使用量 [████████████████░░░░] 82% 剩余  │ 重置 4d 12h
```

### 验证

- 真实 pty 250 列实测：`会话 tokens 21K 「输入 4K │ 输出 187 │ 缓存 17K」  │  上下文 21K/512K 4%`
- doctor 段顺序断言改写为「会话 tokens 在上 / token usage 在下」
- 20 ok / 0 warn / 0 fail
- 单元 22 项断言全绿

## 2026-09-09 — v2.4.0：标签重命名为「小时会话窗口 / 周限制使用量」+ 重置时间常驻

### 诉求

1. 屏幕够宽时也没显示「重置」时间——5小时/周配额是有刷新时间的，应该一直显示。
2. 原来用全宽空格补齐标签宽度的方案，视觉上仍然有大量空格，希望改成**字数一致**的标签，
   逻辑更简单。

### 变更

- **标签**：`5小时使用量` → **`小时会话窗口`**（6 字 / 12 列），`周使用量` → **`周限制使用量`**（6 字 / 12 列）。
  两边同宽同列宽，**不再需要任何 padding 逻辑**——把 `paddedLabel` 的全宽空格部分用得最简化，
  段 1 的 1 行 / 2 行 / 退化三档现在天然对齐。
- **重置时间常驻**：删掉 `q5h`/`qwh`（无重置的 1 行变体），1 行 token usage **始终带重置**。
  这意味着 1 行所需的最低宽度变大（从约 80 列升到约 98 列），但用户能一直看到「下次什么时候重置」。

### 实测阶梯（重命名后）

| 宽度 | 段 1 行数 | 内容 |
|---|---|---|
| ≥98 | 1 | `小时会话窗口 [...] 剩余 │ 重置 4h 5m │ 周限制使用量 [...] 剩余 │ 重置 4d 13h` |
| 47–97 | 2 | `小时会话窗口 [...] 剩余 │ 重置 4h 5m` + `周限制使用量 [...] 剩余 │ 重置 4d 13h` |
| <47 | 3+ | 退化（丢方括号 / 丢百分比 / 截断标签） |

### 验证

- 46–260 列逐列扫描 0 溢出（<20 列的极少数终端属 best effort）
- 真实 pty 250 列实测：`小时会话窗口 [...] 剩余 │ 重置 4h 5m │ 周限制使用量 [...] 剩余 │ 重置 4d 13h`
- 22 项单元断言全绿
- doctor 22 项全 ok

## 2026-09-09 — v2.3.0：两段式排版（token usage 行 + 会话 tokens 行）

### 诉求

> 我考虑 会话 tokens, 上下文的情况显示和 token usage 还是换行显示，这样屏幕小的时候显示的内容能够更多一点，注意，把 token usage 显示在最后一行，其他信息都显示在 token usage 的上方

澄清后：「token usage」= 5小时/周行；「其他信息」= 会话 tokens + 上下文；行序为 token usage 在上、会话+上下文在下。

### 变更

之前 D15 的响应式打分会让两段挤在同一行（窄屏争空间、宽屏挤瘦进度条），改为**两段独立**：

- **段 1：token usage 行**（始终独立）。要么 1 行（5h │ 周，无重置），要么拆 2 行（5h + 周，带重置、标签对齐）。拆 2 行时 `周限制使用量` 标签用全宽空格（U+3000）补齐到与 `小时会话窗口` 同宽、方括号左缘对齐。
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
于是宽终端下 `会话 tokens` 的 `「输入 │ 输出 │ 缓存」` 明细**无声消失**了。
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
- 真实 TUI（pty）实测渲染出 `会话 tokens 25K 「输入 614 │ 输出 134 │ 缓存 25K」  │  上下文 25K/200K 13%`

## 2026-09-08 — v2.1.0：分隔符改 `│` + 新增「上下文」使用率

### 分隔符

`·`（U+00B7）→ `│`（U+2502），三处统一：状态栏各段之间、`剩余 │ 重置`、`「输入 │ 输出 │ 缓存」`。
理由：和 mcode 原生状态栏（`◇ Greeting │ ⎇ master │ FULL`）风格一致。

### 新增 上下文

排在 `会话 tokens` 之后，显示**已用**百分比：

```
会话 tokens 25K 「输入 618 │ 输出 33 │ 缓存 25K」  │  上下文 13%
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
- `5-hour` → **小时会话窗口**
- `Weekly` → **周限制使用量**
- 附带：`left` → 剩余、`resets in` → 重置、`(no data)` → （无数据）、
  `in/out/cache` → 输入/输出/缓存

### 显示正确性

- 新增 CJK 宽度计算（CJK 按 2 列），排版按真实显示宽度收缩进度条，修复 95 列溢出。
- 会话 token 兜底修正：runtime API 返回全 0 或结构异常时，自动回落到 sqlite
  （`local_runtime_token_usage`），避免把有数据的会话显示成 0。
- 实测：新会话 `会话 tokens 25K 「输入 619 · 输出 13 · 缓存 25K」`，与 sqlite 的 25,208 一致。

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
