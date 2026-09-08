# mcode status-bar quota patch

在 mcode TUI 状态栏下面显示当前套餐的日 / 周使用量（带进度条 + 颜色）。

## 效果

**宽 TUI（≥88 cols）** — 单行横排：

```
~/projects/... │ Permissions │ ✦ no model
5-hour [███████████████████████░░░░░░░░░░░░░░░] 61% left  ·  Weekly [██████████████████████████████████░░░░] 90% left
```

**窄 TUI（<88 cols）** — 自动 fallback 为两行（带 reset time）：

```
~/projects/... │ Permissions │ ✦ no model
5-hour [█████████████████████░░░░░░░░░░░]  61% left  · resets in 2h 21m
Weekly [███████████████████████████░░░]  90% left  · resets in 5d 11h
```

**颜色（按 remaining % 自动分级，色调调柔和了）**：

| remaining | 颜色 | RGB | 用途 |
|---|---|---|---|
| > 30% | 深绿 (success) | `(60,160,90)` | 充足 |
| 11-30% | 暗橙 (warning) | `(200,150,40)` | 偏低 |
| ≤ 10% | 暗红 (error) | `(200,80,80)` | 即将耗尽 |
| 无数据 | 灰 (muted) | `(140,140,140)` | 缺数据 |

进度条 fill 部分和百分比文字按上面规则上色；empty 部分始终灰色。

**进度条宽度**：clamp 到 **[12, 20] 字符**，无论终端多宽都不会拉成超长条。

## 文件

```
/home/weekbin/orca/projects/mcode/mcode-quota/        # 工具集（single source of truth）
├── README.md
├── mcode-patch-quota.sh     # 升级 mcode 后重跑
├── mcode-with-quota         # 一键启动 wrapper
└── mcode-quota-doctor       # 自检（10 项）

/home/weekbin/.minimax/bin/mcode-with-quota            # PATH 入口（328 字节，exec 项目目录 wrapper）
~/.minimax-code/.../chunks/mcode-quota-fetcher-9f8a7b.mjs  # sidecar（patcher 写入，mcode update 后需重建）
~/.minimax-code/.../chunks/launcher-CVR77P3I.js.unpatched.bak  # 备份
```

## 安装 / 使用

```bash
# 第一次：跑 patcher（在 launcher 注入 quota 钩子 + 写 sidecar）
/home/weekbin/orca/projects/mcode/mcode-quota/mcode-patch-quota.sh

# 之后：启动 mcode（任何目录都行）
mcode-with-quota
```

`mcode-with-quota` 在 `~/.minimax/bin/`（PATH 上），内部 `exec` 项目目录里的 wrapper。

## 升级 mcode

```bash
mcode update
/home/weekbin/orca/projects/mcode/mcode-quota/mcode-patch-quota.sh
```

如果 mcode 改 launcher 内部结构，patcher 退出码 2 + 报错信息提示重新派生锚点。

## 自检

```bash
/home/weekbin/orca/projects/mcode/mcode-quota/mcode-quota-doctor
```

期望 `10 ok, 0 warnings, 0 failures`。

## 还原

```bash
LAUNCHER=~/.minimax-code/releases/<v>/lib/node_modules/@minimax-ai/code/chunks/launcher-*.js
cp "$LAUNCHER.unpatched.bak" "$LAUNCHER"
rm "$LAUNCHER"/*.unpatched.bak 2>/dev/null
rm ~/.minimax-code/releases/<v>/lib/node_modules/@minimax-ai/code/chunks/mcode-quota-fetcher-*.mjs
```

## 数据源

- `mmx quota show --output json` — 通过 `child_process.spawn` fork
- 缓存 TTL：60s
- 单次 fetch 超时：5s（超时 SIGKILL）
- sidecar fetch 完成后通过 `requestRender()` 触发 TUI 重绘

## 工作原理

1. **Launcher patch**（mcode-patch-quota.sh）：替换 launcher bundle 里两个稳定锚点
   - `Xc.render` (status 渲染基类) — 渲染结束时调 `globalThis.__mcodeQuotaRender(width)` 拿到 string[]，追加到 status bar
   - `jf.constructor` (status widget 类) — 构造时调 `globalThis.__mcodeQuotaStart(cb)` 注册更新回调
2. **Sidecar**：`--import=...mjs` 在 mcode 启动时加载
   - 每 60s 跑 `mmx quota show --output json`
   - 解析成 raw 数据存闭包
   - 暴露 `__mcodeQuotaRender(width)`：根据 width 决定横排 / 竖排 layout，注入 ANSI 24-bit 颜色
3. **mcode TUI** 调用 patched `Xc.render` 时拿到 width（content width），传给 sidecar 的渲染器

## 已知 trade-offs

- 每 60s fork `mmx` 一次（~30ms 开销，可忽略）
- 首次启动 mcode 时 quota 行会先空 ~1s（首次 fetch 还没完成），sidecar 完成后 `requestRender()` 触发重绘
- `script -qfc` 伪 TTY 默认 80 列，所以 CI 测出来的总是两行 layout
- 颜色阈值 30/10 是从 mcode 内部 `ef()` 函数抄的；如果 mcode 改了这个阈值，patch 颜色规则不会自动跟着变
