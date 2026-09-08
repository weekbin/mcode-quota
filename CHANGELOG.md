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

| 验证项 | v1.0 | v1.1 | v1.2 | v1.3 |
|---|---|---|---|---|
| `bash -n` patcher 语法 | ✅ | ✅ | ✅ | ✅ |
| `bash -n` wrapper 语法 | ✅ | ✅ | ✅ | ✅ |
| `bash -n` doctor 语法 | ✅ | ✅ | ✅ | ✅ |
| `node --check` launcher | n/a | ✅ | ✅ | ✅ |
| `node --check` sidecar | ✅ | ✅ | ✅ | ✅ |
| doctor 10/10 | ✅ | ✅ | ✅ | ✅ |
| sidecar 单独运行（输出格式） | ✅ | ✅ | ✅ | ✅ |
| mcode TUI `script -qfc` 渲染（narrow 80 cols） | ✅ | ✅ | ✅ | ✅ |
| mcode TUI 渲染（wide 120 cols） | n/a | n/a | ✅ | n/a |
| mcode TUI 渲染（wide 160 cols） | n/a | n/a | n/a | ✅ |

---

## 文件清单

```
/home/weekbin/orca/projects/mcode/mcode-quota/
├── README.md                  # 用户文档
├── MAINTENANCE.md             # 维护指南（升级 / 失败 / 还原 / 自定义）
├── CHANGELOG.md               # 本文件
├── mcode-patch-quota.sh       # 升级后重跑
├── mcode-with-quota           # 一键启动 wrapper
└── mcode-quota-doctor         # 自检

/home/weekbin/.minimax/bin/mcode-with-quota     # PATH 入口（328B stub，exec 项目 wrapper）
~/.minimax-code/.../mcode-quota-fetcher-9f8a7b.mjs   # sidecar
~/.minimax-code/.../launcher-*.js.unpatched.bak      # 备份
```

---

## 未来可能的工作

- [ ] 把 `mcode-quota/` 纳入 git 版本管理
- [ ] patcher 加 `--revert` 一键还原选项
- [ ] sidecar 支持 multiple model（同时显示 video / general / 其他）
- [ ] 添加图标（用 nerd font 或 emoji 装饰标签 / 进度条）
- [ ] 把锚点查找自动化（脚本能自动定位 `Xc.render` + `jf.constructor` 而不依赖固定字符串匹配）
- [ ] 多个 TUI 实例同时跑时 sidecar 共享（目前每个 mcode 进程独立 fork mmx）
