# Architecture — mcode-hub (v3.4.0 deprecation of launch wrapper)

> **v3.4.0 起 `mcode-hub`(无子命令)是 deprecation 中的 wrapper**。装好
> `mcode-hub-install` 之后**直接用 `mcode` 启动**就好,不需要 `mcode-hub`
> 入口。`mcode-hub` wrapper 还存在的唯一理由是 install / uninstall /
> status / doctor 四个维护子命令。完整 roadmap 见
> [MAINTENANCE.md §10](MAINTENANCE.md#10-mcode-hub-入口-deprecation-路线图v340-起)。

## 0. 启动路径（mcode ≥ 0.4.0, 主流）

```
                            用户
                             │
                          mcode                 ← 直接跑 mcode
                             │
                             ▼
              ┌────────────────────────────┐
              │     mcode 0.4.0+ cli.js    │
              │   读 ~/.minimax/config.yaml│
              │   tui.customStatusLine     │
              │   .command = mcode-hub │
              └──────────┬─────────────────┘
                         │  spawn (stdin JSON,
                         │   每 10s / 切 session)
                         ▼
                  mcode-hub            ← 唯一需要 PATH 入口的脚本
                         │
                         ▼
                  lib/render.mjs (3 行)
```

`mcode-hub-install` 只在**安装期**碰一次 config.yaml(把
`customStatusLine` 两键写进去),之后 mcode 自己读、自己 spawn,
`mcode-hub` 不出现在启动路径上。

## 0.5. legacy fork 路径（mcode < 0.4.0, 维护期)

```
                    mcode-hub [args]
                          │
              ┌───────────┴────────────┐
      mcode >= 0.4.0            mcode < 0.4.0
        （原生）                  （legacy）
              │                        │
   合并 config.yaml 的             patches/_loader.mjs
   tui.statusLine +                ↓ 选 patches/<版本>/
   tui.customStatusLine            patcher 建私有 pristine fork
              │                        │
   exec 官方 bin/mcode             exec fork 的 code/cli.js
              │                        │
   mcode 的 custom-command          fork 的 cli.js
   每 10s / 切 session 跑              静态 import sidecar
   mcode-hub                    （不走 NODE_OPTIONS）
              │                        │
              └───────────┬────────────┘
                          ▼
                lib/render.mjs（唯一渲染核心）
                3 行：4-chunk / 5h-周 / 今日
                          │
              tests/parity.mjs 在 18 个宽度上
              逐字节锁定两条路径输出一致
```

**不变约束**：mcode 本体 0 字节修改。

- 原生路径：只写 mcode 自己的配置文件，mcode 二进制不动。
- legacy 路径：fork 是 pristine npm tarball 的**副本**，patch 只落在副本里。

---

## 1. 原生路径（mcode >= 0.4.0）

mcode 0.4.0 起状态栏渲染在基类 `ba.renderViewport(width, height)`，widget `t1`
只是控制器（实测调用次数 0 vs 22，见 DECISIONS D30）。与其继续注入内部方法，
不如用官方扩展点：

1. `mcode-hub install` 把 `custom-command` 加进 `tui.statusLine`，并写入
   `tui.customStatusLine`（`lib/config-apply.mjs` 做文本级合并，保留注释与排版，
   幂等，install/uninstall 往返字节级一致）。
2. mcode 在 startup / `session-change` / `workspace-change` / 每
   `intervalSeconds`（最小 10）调用 `mcode-hub`，向 stdin 写一行 JSON。
3. `mcode-hub` 取数（`lib/data.mjs`）→ 渲染（`lib/render.mjs`）→ 3 行到
   stdout。mcode 渲染在原生状态栏下方（`position: below`）。

**故障收敛**：脚本退出码非 0 或输出为空时 mcode 只是不显示块，不会影响 TUI。
这与 legacy 路径在注入点包 try/catch 是同一个目标（D29.1）。

## 2. legacy 路径（mcode < 0.4.0）

原样保留：`patches/<版本>/` 目录 + `_loader.mjs` 按 `--current` 分发，AST 推导
锚点（不锁类名/字段名），把 `render()` 覆写追加进 widget 类体，sidecar 由 fork 的
`cli.js` 静态 import。

## 3. 数据流（两条路径共用）

| 数据 | 来源 | 备注 |
|---|---|---|
| session_id / model / 标题 | 原生：stdin JSON；legacy：`shellState` | |
| 会话 tokens + 轮数 | sqlite SUM(`local_runtime_token_usage`) | **必须 SUM**，见 D31.1 |
| 上下文 已用/窗口 | sqlite `context_usage.usedTokens` / `contextWindowTokens` | 实时值，非 config 声明值，见 D31.2 |
| 缓存命中 | cache_read / (cache_read + input) | |
| 今日 按模型 | message_rows(model) × token_usage 按 turn_id | 60s 文件缓存 |
| 5h/周 | `mmx quota show` | 60s 文件缓存 |

## 4. 版本升级时的动作

按策略不同，升级要动的东西差一个数量级：

| 策略 | 升级动作 | 通常要改代码吗 |
|---|---|---|
| 原生（≥0.4.0） | `mcode update && mcode-hub install && mcode-hub doctor` | **不用**。我们依赖的是配置 schema（`tui.statusLine` / `tui.customStatusLine`）与两处 sqlite 表，是外部契约 |
| legacy（<0.4.0） | `mcode update && mcode-hub`（自动重打补丁） | widget 结构真变了才加 `patches/<新版本>/` |

**跨过 0.4.0 那一次**是一次性切换：`mcode-hub install` 写配置，之后可以删掉 fork
释放空间。**结论**：原生路径把「每次升级都要重新适配」变成了「只在 mcode 改
外部契约时才动」。

完整决策树、故障排查、验收清单见 [MAINTENANCE.md](MAINTENANCE.md) §3。

## 5. 排版

## 6. 总原则（两条路径共同）

| 原则 | 实现 |
|---|---|
| mcode 本体只读 | 从不写 `~/.minimax-code/**`；doctor 校验其与 npm 官方包字节一致 |
| 补丁只落在私有 fork | `~/.local/share/mcode-hub/mcode-clone/<版本>/code/` |
| fork 来源必须干净 | 从 npm registry 下载官方 tarball 解压，**不是**复制已安装目录 |
| fork 必须是真实拷贝 | 不用 symlink（Node 默认 realpath，会把相对 import 指回源安装，patch 失效） |
| 可随时推倒重建 | 删掉 fork 目录，下次 `mcode-hub` 自动重建 |

## 7. 目录与来源

### 7.1 项目目录（两条路径共用）

```
mcode-hub/
├── mcode-hub                     入口：按 mcode 版本分发 + install/uninstall/status/doctor
├── mcode-hub              ≥0.4.0 的 custom-command 目标（stdin JSON → 3 行 stdout）
├── mcode-hub-install             新机器一次性安装（跨 OS、装依赖、建 PATH 条目）
├── mcode-hub-doctor         自检（按版本选对应检查集）
├── lib/
│   ├── render.mjs             渲染核心（纯函数，无 I/O）—— 两条路径共用
│   ├── data.mjs               数据层：sqlite 会话/上下文/今日 + mmx 文件缓存
│   └── config-apply.mjs       config.yaml 文本级合并（幂等、可逆、带备份）
├── config/<version>/          配置载荷（≥0.4.0 用；含字段说明）
├── patches/<version>/         fork 补丁（<0.4.0 用）
├── tests/
│   ├── parity.mjs             新旧渲染逐字节一致（跨策略护栏）
│   └── mcode-smoke.mjs        行为回归
└── *.md                       文档（升级手册在 MAINTENANCE.md §3）
```

### 7.2 legacy fork 的落盘位置（<0.4.0 专用）

```
~/.local/share/mcode-hub/mcode-clone/
├── tarballs/minimax-ai-code-<v>.tgz      # npm pack 缓存（官方 tarball）
├── .pristine-<v>/                        # 解压结果（--strip-components=1）
└── <v>/
    ├── .fork-marker                      # 版本 + 来源 + tarball sha256
    └── code/                             # 真实拷贝 + 打了 patch
        ├── cli.js                        # ← patch 2
        └── chunks/launcher-*.js          # ← patch 1
```

获取顺序（`ensurePristine()`）：

1. 命中 `tarballs/*.tgz` 缓存 → 直接解压
2. 否则 `npm pack @minimax-ai/code@<版本> --registry=https://registry.npmjs.org/`
3. 网络不可用（或 `--offline`）→ 回退到已安装 release 目录，但**先校验其 launcher 无 quota 痕迹**，
   否则拒绝（绝不允许拿被污染的源码去 fork）

`npm` tarball 不含 `node_modules/`，所以建 fork 时会从已安装目录**拷贝**一份
（真实拷贝，不与原安装共享 inode）。

## 8. legacy 路径的两处 patch

> **<0.4.0 专用**。0.4.0 起渲染搬到了基类、且官方提供了 `custom-command`，所以不再注入，见 §1。

### 2.1 patch 1 — launcher chunk：`render()` 覆盖

mcode TUI 的状态栏 widget 是 `jf`（混淆短名），继承基类 `Xc`。
原版 `jf` **没有自己的 `render`**，直接用基类的。我们在 `jf` 类体末尾插入一个 `render` 覆盖：

```js
render(e){
  let r=super.render(e);
  if(this&&this.runtime)globalThis.__mcodeRuntime=this.runtime;
  if(this&&this.shellState)globalThis.__mcodeShellState=this.shellState;
  globalThis.__mcodeQuotaWidget=this;
  if(Array.isArray(r)){
    let _qr=typeof globalThis.__mcodeQuotaRender==="function"
      ?globalThis.__mcodeQuotaRender(e)   // e = content width
      :[];
    if(Array.isArray(_qr)&&_qr.length>0)return[...r,..._qr]
  }
  return r
}
```

作用：
- 把 `runtime` / `shellState` 暴露给 sidecar（sidecar 需要 `agentSessionId` 和 runtime API）
- 把 widget 实例暴露出去，sidecar 数据到达时调 `widget.requestRender()` 触发重绘
- 把 sidecar 返回的行追加到状态栏

**锚点怎么找**：`mcode-find-anchors.mjs` 用 acorn 解析整个 bundle 的 AST，
按"WIDGET 特征"（`extends <Base>` + `super(t)` + `this.runtime` + `this.requestRender`
+ `this.shellState` + `setInterval`）定位 widget 类，再取其 `superClass` 作为基类，
输出 `WIDGET_BODY_END` / `CTOR_END` 字节偏移。不依赖任何混淆短名，跨版本更稳。

**为什么安全**：`super.render(e)` 调用的是基类原实现，只是在其结果后追加行，不改变原有渲染逻辑。

### 2.2 patch 2 — `cli.js`：静态 import sidecar

在 `cli.js` 的 shebang 之后插入一行：

```js
import "/home/weekbin/orca/projects/mcode/mcode-hub/sidecar/mcode-hub-fetcher-9f8a7b.mjs"; /* mcode-hub-sidecar */
```

**这是与旧方案最关键的差异**：旧方案用 `NODE_OPTIONS=--import=…`，该变量被 mcode 派生的
所有子进程继承，导致每个子进程都加载 sidecar 并各自 fork `mmx` —— 进程风暴的根因。
改成 cli.js 静态 import 后，只有真正跑 TUI 入口的进程才加载 sidecar。

## 9. legacy 路径的 Sidecar

> **<0.4.0 专用**。原生路径改由 `mcode-hub` 脚本承担同样的角色，但由 mcode 通过 `custom-command` 主动调用，不需要 import 注入。

`sidecar/mcode-hub-fetcher-9f8a7b.mjs` 由 patcher 生成（模板内联在 patcher 里），
与 mcode 共享同一个 V8 isolate，通过 `globalThis` 通信：

```js
globalThis.__mcodeQuotaRender(width) -> string[]   // 渲染行（含 ANSI 颜色）
globalThis.__mcodeQuotaStart()                     // 手动启动（一般不需要）
globalThis.__mcodeRuntime / __mcodeShellState      // 由 patch 1 注入，属性名由 mcode-find-anchors AST 推断
globalThis.__mcodeQuotaWidget                      // 由 patch 1 注入
```

### 3.0 抗升级漂移（v3.0 起）

注入链的每一处"假设 mcode 不变"在 v3.0 全部替换为 AST 推断 / 候选优先级 / 运行时 fallback：

| 位置 | 实现 | 见 D25 |
|---|---|---|
| widget 识别 | 3 个结构化特征（super + setInterval + ctor 模式） | `mcode-find-anchors.mjs` |
| 属性名发现 | 扫描 ctor `this.X = param` / `this.X = param.Y`，按候选优先级匹配 | `discoverPropNames()` |
| `PATCH_RENDER` | 接收 `RUNTIME_PROP` / `SHELLSTATE_PROP`，动态拼接 | `buildPatchRender()` |
| 上下文数据源 | shellState.contextUsage → contextWindowTokens → runtime.getContextSnapshot | `readContextUsage()` |
| session SQL | 运行时 `PRAGMA table_info` + 候选列名 | `resolveSqliteColumns()` / `buildSessionSql()` |

升级回归测试：`node mcode-smoke.mjs` 模拟 5 种 mcode 字段重命名场景 + 1 个端到端 fork 重建，25 个断言全绿。

### 3.1 懒启动（关键）

sidecar **不自动启动**。`__mcodeQuotaRender` 第一次被调用时（即状态栏第一次真实渲染）
才启动两个轮询器。子进程即使 import 了 sidecar，只要不渲染 TUI 就永远不 fork 任何进程。

### 3.2 数据流

```
启动 mcode-hub
  ↓
patcher（幂等）→ fork 就绪
  ↓
exec <node> <fork>/code/cli.js
  ↓
cli.js 静态 import sidecar（仅注册函数，不启动）
  ↓
TUI 第一次渲染状态栏 → jf.render(width)
  ↓
render 注入 runtime/shellState/widget 到 globalThis
  ↓
render 调 __mcodeQuotaRender(width) → sidecar 懒启动轮询器
  ↓
[quota] 每 60s：spawn mmx quota show → 解析 → requestRefresh()
[session] 每 10s：runtime.getSessionUsageSummary → 失败/全0 → sqlite 兜底
  ↓
requestRefresh() → widget.requestRender()（500ms 去抖）→ TUI 重绘
  ↓
__mcodeQuotaRender(width) → 按宽度排版 → Ink 写 stdout
```

### 3.3 排版（两段式：会话 tokens + 上下文 在上，token usage 在下）

- `dw(s)`：去 ANSI 后按 CJK=2 列计算显示宽度
- `fit(bar)` 从 20 字符进度条开始向下收缩，先到 `MIN_BAR_WIDTH=8` 再到 1 字符（极窄屏）
- 段 1 标签天然同宽（v2.4 起：都是 6 字 / 12 列），不再需要任何对齐 padding

**两段独立、v2.5 起段顺序倒置**：

```
[ mcode 原生状态栏 ~/... │ ◇ Greeting │ ⎇ master │ ✦ model ]
─ 段 1: 会话 tokens + 上下文（永远 1 行） ───────────────
会话 tokens 267K 「输入 20K │ 输出 2K │ 缓存 245K」  │  上下文 25K/512K 5%
─ 段 2: token usage（重置常驻） ──────────────────────────
小时会话窗口 [███████████████████░] 97% 剩余  │ 重置 4h 5m  │  周限制使用量 [████████████████░░░░] 82% 剩余  │ 重置 4d 13h
```

**段 1**（会话 tokens + 上下文 + 缓存命中 + 轮数，v2.6 起 4 个 chunk）：

候选列表按"信息量从高到低"排列，逐个试直到有能 fit 当前宽度的：

```
1. 会话[detail] │ 上下文 │ 缓存命中 │ 轮数
2. 会话[detail] │ 上下文 │ 缓存命中
3. 会话[detail] │ 上下文 │ 轮数
4. 会话[detail] │ 上下文
5. 会话[compact] │ 上下文 │ 缓存命中 │ 轮数
6. 会话[compact] │ 上下文 │ 缓存命中
7. 会话[compact] │ 上下文 │ 轮数
8. 会话[compact] │ 上下文
9. 会话[detail]   （无 上下文）
10. 会话[compact] （无 上下文）
11. 上下文
```

`auto` 模式：detail 类候选能 fit 就给 detail，否则降级到 compact。
任何 fit 不下：降级为多行（`会话` 一行，其余按宽度追加）。
`会话 tokens` 永不丢；`上下文` 极端紧张时让位。
明细用全角引号 `「」` 包住。

**段 2**（token usage，小时会话窗口 + 周限制使用量）：

| 行数 | 触发 | 内容 |
|---|---|---|
| 1 | 段 2 总宽 ≤ width（≥98 列） | 1 行带两组重置 |
| 2 | 47–97 | 每行带重置，标签天然对齐 |
| 退化 | <47 | 丢方括号 / 丢百分比 / 截断标签 |

**段 3**（v3.2，今日按 LLM 模型，固定 1 行）：

```
今日 「MiniMax-M3」 867.4M
```

- 数据源：`local_runtime_message_rows.data_json.context_usage_telemetry.model` ×
  `local_runtime_token_usage.turn_id` 关联聚合
  （0.3.11 的 `local_runtime_token_usage.model` 列始终 NULL，必须走 message rows 的 JSON）
- 60s 轮询，跨日自动刷新
- 响应式 top-N：`width >= 100` 最多 5 模型 / `width >= 70` 最多 3 / 否则 1
- mmx 失败时仍能出（与 quota 数据源解耦）

**段顺序（v3.2 重做后）**：1 (会话上下文) → 2 (token usage) → 3 (今日按模型)，
三段各自独立行，不合并。Xc parent 返 `["", r]` 2 元素 + 我们返 3 元素 =
5 元素返回给 framework，全部 paint 到独立 row（D28）。

**开关**：`MCODE_QUOTA_TAIL` = `auto`（默认，≥80 列才给明细）/ `full`（永远保留明细）/
`compact`（永远不显示明细）。

### 3.4 上下文使用率

```js
const cu = globalThis.__mcodeShellState?.contextUsage;   // { usedTokens, contextWindowTokens }
const win = cu.contextWindowTokens || shellState.contextWindowTokens;
pct = Math.round(Math.min(cu.usedTokens, win) / win * 100);   // 已用占比
// 渲染为：上下文 <已用>/<总量> <pct>%，例如 上下文 42K/200K 21%
```

- 数据与 mcode 原生 `Context N% left` 指示器同源，渲染时实时读取，无需额外轮询
- 同时给出**已用/总量**与**已用百分比**：百分比用于判断距离压缩还有多远，绝对量用于判断真实余量
- 阈值对齐 mcode（其按"剩余"判定 10% / 25%），这里取补数：≥75% 暗橙、≥90% 暗红
- 快照缺失（新会话尚未产生 contextSnapshot）时该字段整块不渲染，不影响其他行

### 3.5 会话 token 兜底

```js
if (!summary || sumTotal(summary) === 0) {
  const fb = await fetchSessionFromSqlite(sessionId);
  if (fb && (!summary || sumTotal(fb) > 0)) summary = fb;
}
```

- runtime API 签名：`getSessionUsageSummary(sessionId)`，返回
  `{inputTokens, outputTokens, reasoningTokens, cacheReadTokens, ...}`
- sqlite 兜底：`~/.minimax/v2/sqlite/runtime-state.sqlite` 表 `local_runtime_token_usage`，
  按 `session_id` 聚合
- 总量 = `input_tokens + output_tokens + cache_read_tokens`

## 10. 进程风暴防护（legacy 路径）

| 防护 | 说明 |
|---|---|
| 不用 NODE_OPTIONS | sidecar 只在 TUI 进程加载 |
| 懒启动 | 不渲染就永不 fork |
| `isMmxOnPath()` | PATH 上没 `mmx` 直接失败返回，不 spawn |
| `detached:true` + `process.kill(-pid)` | 超时按进程组 SIGKILL，避免孤儿 |
| 失败上限 | 连续失败 5 次停用；5 分钟无成功自动恢复 |
| stderr 上限 | 最多缓存 64KB |
| 定时器 `unref()` | 不阻止 mcode 退出 |

## 11. legacy 锚点的升级兼容性

> 本节只适用于 **legacy（<0.4.0）** 路径。原生路径的升级动作见 §4 —— 那里
> 通常不需要动代码。下面说明 fork 补丁在 mcode 版本变化时如何自我修复。

mcode 升级后：

1. `mcode-hub` 读到新版本号
2. `.fork-marker` 版本不匹配 → 删除旧 fork
3. 重新从 npm 下载新版本 tarball → 重建 fork → 重新找锚点打 patch

锚点用 AST 结构特征匹配，只要 mcode 的 TUI 状态栏还是
"继承基类的 widget + `render(width)` 返回 string[]" 这套 Ink 契约，就无需人工干预。

如果 mcode 大重构导致锚点找不到，patcher 会明确报错并**回退到未打 patch 的官方 mcode**
（`mcode-hub` 的 fallback 分支），不会把你卡住。

### 5.1 patches/ 版本目录机制（v3.1 起）

> **问题**：v3.0 之前 patcher 是单文件（`mcode-patch-quota.mjs`），当 mcode 升级改了 widget
> 字段后，**老用户拉最新 master 会拿到新版 patcher，但他们的 mcode 是老版**——AST 推断的
> 候选优先级是基于新版决策的，可能对老版不是最优解；严重时甚至不能正确注入。
> 此外排查问题的时候，老 commit 的 patcher 代码和当时跑的 mcode 之间的对应关系被 git history
> 拉平了，不直观。

**方案**：

```
patches/
├── _loader.mjs              # dispatcher：按 --current 选目录
├── 0.3.10/                  # mcode 0.3.10 的 patcher
│   ├── mcode-patch-quota.mjs
│   ├── mcode-find-anchors.mjs
│   └── NOTES.md             # 该版本检测到的 widget 签名 + 决策
└── 0.3.11/                  # mcode 0.3.11 的 patcher
    └── ...
```

`patches/_loader.mjs` 的解析规则：

1. 优先用 `patches/<请求版本>/` 精确匹配
2. 没有精确匹配则选**最高 <= 请求版本**的目录（X.Y.Z 字典序 = 数值序）
3. 都没有 → 报错并列出可用版本

`mcode-hub` 调 `patches/_loader.mjs` 而不是直接的 `mcode-patch-quota.mjs`，**老目录的 patcher
代码不被任何东西覆盖**。新 mcode 改了 widget → 只需在 `patches/0.3.12/` 加新 patcher
（或把现有最新版复制过来再改），loader 自动选。

**对 git history 的影响**：每个 mcode 版本的 patcher 决策可以独立 commit、单独回滚、
单独看 diff；不会因为单文件历史而把"0.3.10 时怎么做"和"0.3.12 时怎么做"挤到同一根 branch
上。

**对 doctor 的影响**：新增 `versioned patches available:` 和 `loader picks patches/X/`
两行，明示当前 mcode 走了哪个 patch 目录、是否有 fallback。

## 12. 已知限制

**原生路径（≥0.4.0）**

- 刷新下限 **10s**（mcode 的 `intervalSeconds` 最小 10）。切 session / 换
  workspace 会立刻触发一次，所以切的时候不用等。
- 每次刷新起一个短命进程（实测 ~30ms 热 / ~90ms 冷）。不在 TUI 事件循环里，
  所以 sqlite 慢也不会卡界面。
- 首次渲染依赖 mcode 的 tick 或 session-change；启动瞬间可能短暂空白。
- `customStatusLine.command` 按 argv 解析，**不是 shell** —— 不支持管道/重定向。
  复杂取数要放进脚本，而不是写在 config 的命令行里。
- 依赖 mcode 的配置 schema 稳定（比依赖压缩后的内部方法名稳定，但仍是外部契约）。

**legacy 路径（<0.4.0）**

- fork 每个版本占约 62MB（真实拷贝，换来无 realpath 陷阱）
- sidecar 路径写死在 fork 的 `cli.js` 里；若移动项目目录，需重跑 patcher
  （`mcode-hub` 会自动检测并重写）
- AST 锚点需要 mcode 保持"继承基类的 widget + `render(width)` 返回 string[]"
  这套契约；变了就要新增 `patches/<新版本>/`

**两条路径共同**

- 24-bit 颜色需要终端支持
- `mmx` 是外部依赖，未登录时 5h/周 行显示缓存值或占位符
- `<unknown>` 桶（今天未能匹配到 turn→model 的 token）在显示时被过滤；
  实测全历史占比 0.01%，可忽略
