# Changelog — mcode quota patch

记录每次对工具集的修改。新条目加在最上面。

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

**已知问题**：如果 mcode 改 launcher 内部变量名（比如 `Xc` → `Yx`），patcher 退出码 2，需要按 `MAINTENANCE.md §5` 重派生锚点。

---

## 测试矩阵

每个版本做的验证：

| 验证项 | v1.0 | v1.1 | v1.2 | v1.3 | v1.4 | v1.5 |
|---|---|---|---|---|---|---|
| `bash -n` patcher 语法 | ✅ | ✅ | ✅ | ✅ | n/a | n/a |
| `node --check` patcher | n/a | n/a | n/a | n/a | ✅ | ✅ |
| `node --check` launcher | n/a | ✅ | ✅ | ✅ | ✅ | ✅ |
| `node --check` sidecar | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| doctor 10/10 | ✅ | ✅ | ✅ | ✅ | n/a | n/a |
| sidecar 单独运行（输出格式） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| mcode TUI 渲染（narrow 80 cols） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| mcode TUI 渲染（wide 120 cols） | n/a | n/a | ✅ | n/a | n/a | n/a |
| mcode TUI 渲染（wide 160 cols） | n/a | n/a | n/a | ✅ | ✅ | ✅ |
| bridge layer（globalThis.__mcodeRuntime） | n/a | n/a | n/a | n/a | n/a | ✅ |
| 第三行 session tokens 渲染 | n/a | n/a | n/a | n/a | n/a | ✅（mock 验证） |

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
