# mcode 0.3.10 — patch notes

## 适配目标

`mcode@0.3.10` 的 status-bar widget 类。

## AST 检测到的 widget 签名

由 `mcode-find-anchors.mjs` 解析 launcher chunk 得到（用 `MCODE_FIND_ANCHORS_DEBUG=1` 验证）：

| 字段 | 值 |
|---|---|
| `WIDGET` | `jf` |
| `BASE`（super class） | `Xc` |
| `WIDGET_BODY_END` | 824697 |
| `CTOR_END` | 823576 |
| `RUNTIME_PROP` | `runtime` |
| `SHELLSTATE_PROP` | `shellState` |
| `setInterval` 轮询 | 是（`var o3=1e4` 即 10s 刷新） |

## Patch 决策（v3.0.x 注入逻辑）

- 走通用 AST-driven finder（不锁类名 / 字段名）
- 通用 `buildPatchRender(runtimeProp, shellStateProp)` 动态拼 `PATCH_RENDER`
- 上下文 fallback 链：shellState.contextUsage → shellState.contextWindowTokens → runtime.getContextSnapshot
- SQL 列名探测：PRAGMA table_info 动态拿 input/output/cache 列名

## 不变约束

- mcode 本体 0 字节修改
- sidecar 由 cli.js 静态 import，不走 NODE_OPTIONS
- 仅在真实 TUI 进程加载，不污染子进程（无进程风暴）

## 已知问题

- `getContextSnapshot()` 旧版 mcode 接受 sync 调用，新版必传 sessionId 且返回 Promise；
  patcher 已通过 `sid` 守卫 + `.then(()=>{}).catch(()=>{})` 兜底（D26）。

## 文件 sha256

```
071494fc7c371e4225432b8d626edadf69423b9ec3727e010c00cdd834a8f07a  mcode-patch-quota.mjs
b2940f549ccfd703fd3938294c1c492d7dae61c1776b21bcfe1368263398d022  mcode-find-anchors.mjs
```

**v3.2 变化**：
- patcher 加了"今日按 LLM 模型"统计行（数据源 `local_runtime_message_rows.data_json.context_usage_telemetry.model` 关联到 token_usage）
- 布局重做为 3 行独立：4-chunk (会话 tokens / 上下文 / 缓存命中 / 轮数) + 5h/周 + 今日
- v3.2.4：注入点 try/catch 兜底（D29.1）；today 查询改 rowid 增量（D29.2）；
  窄屏 model 名按宽度预算截断；session 抓取 in-flight 守卫（带 15s 年龄上限）；
  sidecar 原子写入 + 内容相同时跳过；loader 用 fileURLToPath
- PATCH_RENDER 用 v3.0.0 风格 `[...r, ..._qr]`（首版 ship 用的 `r.slice(1).concat(_qr)` 被推翻，见 DECISIONS.md D28）
- 4-chunk 行恢复（首版 ship 删掉的，用户反馈需要）

v3.3.0：sidecar 的 session SQL 补上 SUM（见 DECISIONS D31），hash 因此变化。

未来分叉时这里改成新 hash 并标注"diverged from 0.3.10 @ 071494fc..."。
