# Architecture — mcodex 隔离架构

本文解释 mcodex 如何在不修改 mcode 本体的前提下，把配额 / token 行注入 TUI 状态栏。
**「为什么选这个方案、否决了哪些」见 [DECISIONS.md](DECISIONS.md)**，本文只讲实现。

## 0. 总原则

| 原则 | 实现 |
|---|---|
| mcode 本体只读 | 从不写 `~/.minimax-code/**`；doctor 校验其与 npm 官方包字节一致 |
| 补丁只落在私有 fork | `~/.local/share/mcode-quota/mcode-clone/<版本>/code/` |
| fork 来源必须干净 | 从 npm registry 下载官方 tarball 解压，**不是**复制已安装目录 |
| fork 必须是真实拷贝 | 不用 symlink（Node 默认 realpath，会把相对 import 指回源安装，patch 失效） |
| 可随时推倒重建 | 删掉 fork 目录，下次 `mcodex` 自动重建 |

## 1. 目录与来源

```
~/.local/share/mcode-quota/mcode-clone/
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

## 2. 两处 patch

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
import "/home/weekbin/orca/projects/mcode/mcode-quota/sidecar/mcode-quota-fetcher-9f8a7b.mjs"; /* mcode-quota-sidecar */
```

**这是与旧方案最关键的差异**：旧方案用 `NODE_OPTIONS=--import=…`，该变量被 mcode 派生的
所有子进程继承，导致每个子进程都加载 sidecar 并各自 fork `mmx` —— 进程风暴的根因。
改成 cli.js 静态 import 后，只有真正跑 TUI 入口的进程才加载 sidecar。

## 3. Sidecar

`sidecar/mcode-quota-fetcher-9f8a7b.mjs` 由 patcher 生成（模板内联在 patcher 里），
与 mcode 共享同一个 V8 isolate，通过 `globalThis` 通信：

```js
globalThis.__mcodeQuotaRender(width) -> string[]   // 渲染行（含 ANSI 颜色）
globalThis.__mcodeQuotaStart()                     // 手动启动（一般不需要）
globalThis.__mcodeRuntime / __mcodeShellState      // 由 patch 1 注入
globalThis.__mcodeQuotaWidget                      // 由 patch 1 注入
```

### 3.1 懒启动（关键）

sidecar **不自动启动**。`__mcodeQuotaRender` 第一次被调用时（即状态栏第一次真实渲染）
才启动两个轮询器。子进程即使 import 了 sidecar，只要不渲染 TUI 就永远不 fork 任何进程。

### 3.2 数据流

```
启动 mcodex
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

**段 1**（会话 tokens + 上下文，永远 1 行）—— 候选 tail 按优先级逐个试，直到有 fit 的：

1. detail（输入/输出/缓存）+ 上下文（仅 ≥80 列 & TAIL_MODE ≠ compact）
2. compact（仅总量）+ 上下文
3. 仅会话 tokens（detail 或 compact）
4. 仅上下文
5. 兜底

`会话 tokens` 永不丢；`上下文` 极端紧张时让位。明细用全角引号 `「」` 包住。

**段 2**（token usage，小时会话窗口 + 周限制使用量）：

| 行数 | 触发 | 内容 |
|---|---|---|
| 1 | 段 2 总宽 ≤ width（≥98 列） | 1 行带两组重置 |
| 2 | 47–97 | 每行带重置，标签天然对齐 |
| 退化 | <47 | 丢方括号 / 丢百分比 / 截断标签 |

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

## 4. 进程风暴防护

| 防护 | 说明 |
|---|---|
| 不用 NODE_OPTIONS | sidecar 只在 TUI 进程加载 |
| 懒启动 | 不渲染就永不 fork |
| `isMmxOnPath()` | PATH 上没 `mmx` 直接失败返回，不 spawn |
| `detached:true` + `process.kill(-pid)` | 超时按进程组 SIGKILL，避免孤儿 |
| 失败上限 | 连续失败 5 次停用；5 分钟无成功自动恢复 |
| stderr 上限 | 最多缓存 64KB |
| 定时器 `unref()` | 不阻止 mcode 退出 |

## 5. 升级兼容性

mcode 升级后：

1. `mcodex` 读到新版本号
2. `.fork-marker` 版本不匹配 → 删除旧 fork
3. 重新从 npm 下载新版本 tarball → 重建 fork → 重新找锚点打 patch

锚点用 AST 结构特征匹配，只要 mcode 的 TUI 状态栏还是
"继承基类的 widget + `render(width)` 返回 string[]" 这套 Ink 契约，就无需人工干预。

如果 mcode 大重构导致锚点找不到，patcher 会明确报错并**回退到未打 patch 的官方 mcode**
（`mcodex` 的 fallback 分支），不会把你卡住。

## 6. 已知限制

- fork 每个版本占约 62MB（真实拷贝，换来无 realpath 陷阱）
- sidecar 路径写死在 fork 的 `cli.js` 里；若移动项目目录，需重跑 patcher（`mcodex` 会自动检测并重写）
- 24-bit 颜色需要终端支持
- `mmx` 是外部依赖，未登录时只显示会话 tokens / 上下文
