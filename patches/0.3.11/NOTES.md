# mcode 0.3.11 — patch notes

## 适配目标

`mcode@0.3.11` 的 status-bar widget 类。

## AST 检测到的 widget 签名

由 `mcode-find-anchors.mjs` 解析 launcher chunk 得到：

| 字段 | 值 |
|---|---|
| `WIDGET` | `jf` |
| `BASE`（super class） | `Xc` |
| `WIDGET_BODY_END` | 824697 |
| `CTOR_END` | 823576 |
| `RUNTIME_PROP` | `runtime` |
| `SHELLSTATE_PROP` | `shellState` |
| `setInterval` 轮询 | 是（`var o3=1e4` 即 10s 刷新） |

## 与 0.3.10 的差异

**widget 自身字节级一致**。AST 偏移和字段名都相同。launcher chunk 的差异（127 KB diff）全在 widget 类之外 —— 其他类/方法/导入顺序等。

结论：当前 0.3.11 的 patch 逻辑完全复用 0.3.10 的代码（两个目录里的文件字节级相同）。当 0.3.12 真的改了 widget 结构时，**仅在 `patches/0.3.12/` 改 patcher**，老用户继续用老目录。

## Patch 决策（v3.0.x 注入逻辑）

同 0.3.10 —— AST-driven finder + buildPatchRender + 上下文 fallback + SQL 探测。

## 兼容性矩阵

| mcode 版本 | 走的 patch 目录 | 备注 |
|---|---|---|
| ≤ 0.3.9 | ❌ 未测 | finder 5 特征 v3.0.0 引入，更老版本无 mcode 历史 |
| 0.3.10 | `patches/0.3.10/` | v3.0.0+ 适配 |
| 0.3.11 | `patches/0.3.11/` | v3.0.0+ 适配；与 0.3.10 同源 |
| 0.3.12+ | 待加 `patches/<version>/` | 若 widget 改了 finder 应自动报警 |

## 已知问题

- 0.3.10 → 0.3.11 升级时 mcode 本体 launcher 改了 127 KB 但 widget 偏移未变 —— 这说明
  finder 抓的 `WIDGET_BODY_END` 是稳定锚点，patcher 注入位置不会因 chunk 改动而漂移。
- 同 D26：`getContextSnapshot` 必须接 `.catch(()=>{})` 兜底。

## 文件 sha256

```
f267f798bd6bf90a4c1f16c28332e2967877ffcb2a3b708f02a5fe572c400a10  mcode-patch-quota.mjs
b2940f549ccfd703fd3938294c1c492d7dae61c1776b21bcfe1368263398d022  mcode-find-anchors.mjs
```

**与 0.3.10 完全相同**（byte-identical）—— 证明 widget 自身没改，patcher 可共用。

**v3.2 变化**：
- patcher 加了"今日按 LLM 模型"统计行（数据源 `local_runtime_message_rows.data_json.context_usage_telemetry.model` 关联到 token_usage）
- 布局重做为 3 行独立：4-chunk (会话 tokens / 上下文 / 缓存命中 / 轮数) + 5h/周 + 今日
- PATCH_RENDER 用 v3.0.0 风格 `[...r, ..._qr]`（首版 ship 用的 `r.slice(1).concat(_qr)` 被推翻，见 DECISIONS.md D28）
- 4-chunk 行恢复（首版 ship 删掉的，用户反馈需要）

未来分叉时这里改成新 hash 并标注"diverged from 0.3.11 @ f267f798..."。
