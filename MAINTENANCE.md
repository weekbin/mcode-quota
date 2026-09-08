# mcode quota patch — 维护指南

这份文档说明当 mcode 升级后，patch 应该怎么**重新应用**、**验证**、**重派生**，以及**彻底还原**的完整流程。

## 1. TL;DR

```bash
# 升级 mcode
mcode update

# 重跑 patcher
/home/weekbin/orca/projects/mcode/mcode-quota/mcode-patch-quota.sh

# 自检
/home/weekbin/orca/projects/mcode/mcode-quota/mcode-quota-doctor

# 启动验证
mcode-with-quota
```

如果上面任何一步报错，看 §4（patch 失败诊断）。

---

## 2. 架构回顾（出问题先看这里）

```
┌─────────────────────────── mcode process ─────────────────────────────┐
│                                                                        │
│  Node.js (--import=sidecar)                                            │
│    │                                                                   │
│    ├── launcher-CVR77P3I.js   ←── 打了 patch                          │
│    │     │                                                             │
│    │     ├── class Xc { render(width) {...} }   ←── 改过:调渲染器     │
│    │     │     return [..., r, ...globalThis.__mcodeQuotaRender(w)]  │
│    │     │                                                             │
│    │     └── class jf extends Xc {...}          ←── 改过:启动 hook    │
│    │           constructor { globalThis.__mcodeQuotaStart(cb) }        │
│    │                                                                   │
│    └── mcode-quota-fetcher-9f8a7b.mjs        ←── sidecar              │
│          │                                                             │
│          ├── globalThis.__mcodeQuotaRender(width) → string[]          │
│          │     决定横排/竖排 + 注入 ANSI 24-bit 颜色                  │
│          │                                                             │
│          └── globalThis.__mcodeQuotaStart(onUpdate)                    │
│                周期性 fork `mmx quota show --output json`              │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

**两个 patch 锚点**（mcode-patch-quota.sh）：

1. `Xc.render(e)` — 状态栏渲染基类
2. `jf.constructor(t, i, s)` — 状态栏 widget 类

---

## 3. 常规升级流程

### 3.1 升级 mcode

```bash
mcode update
```

`mcode update` 会：
- 通过 npm 拉新 release
- 把 `~/.minimax-code/current` 指向新版本
- 把新 launcher 写到 `~/.minimax-code/releases/<新版本>/lib/node_modules/@minimax-ai/code/chunks/launcher-*.js`
- **旧 release 目录保留**（包括之前的 patch 痕迹）

### 3.2 重跑 patcher

```bash
/home/weekbin/orca/projects/mcode/mcode-quota/mcode-patch-quota.sh
```

patcher 行为：
- 读 `~/.minimax-code/current` 拿新版本号
- 找新 release 的 launcher
- 如果新 launcher 是**未被 patch 的**（对比 backup）→ 注入两个锚点 + 写 sidecar
- 如果**已被 patch**（之前跑过）→ 静默跳过（幂等）
- 如果**锚点找不到** → 退出码 2 + 明确报错

### 3.3 自检

```bash
/home/weekbin/orca/projects/mcode/mcode-quota/mcode-quota-doctor
```

期望输出：
```
[ok]  mcode current pointer: 0.3.x
[ok]  Launcher: launcher-XXX.js
[ok]  Backup present
[ok]  Render hook patched
[ok]  Widget hook patched
[ok]  Sidecar present
[ok]  mmx on PATH
[ok]  Sidecar live render: ...
[ok]  Wrapper present
[ok]  mmx appears logged in

Result: 10 ok, 0 warnings, 0 failures
```

### 3.4 启动验证

```bash
mcode-with-quota
```

进入 mcode TUI，看状态栏下面**是否多了一行 quota**：

```
~/path/... │ Permissions │ ✦ model
5-hour [████████████░░░░░░░░] 61% left  ·  Weekly [██████████████████░░] 90% left
```

如果显示正常 → 升级完成。

---

## 4. Patch 失败诊断

patcher 退出码 2 通常是 `RENDER_ANCHOR` 或 `WIDGET_ANCHOR` 找不到。可能原因：

| 现象 | 原因 | 下一步 |
|---|---|---|
| `Base class anchor not found` | mcode 重命名了 `Xc` 类（之前观察到 U4C3IZNL → CVR77P3I 切换时也变了） | §5 重派生锚点 |
| `Status widget anchor not found` | mcode 重命名了 `jf` 类或改了构造签名 | §5 重派生锚点 |
| patcher 静默跳过（"already patched"）但实际未生效 | launcher hash 变了但文件名模式没变 | 删 backup 强制重 patch |

### 4.1 强制重新 patch

```bash
# 删掉 backup 让 patcher 重新当作未 patch 的 launcher
rm ~/.minimax-code/releases/<v>/lib/node_modules/@minimax-ai/code/chunks/launcher-*.unpatched.bak
/home/weekbin/orca/projects/mcode/mcode-quota/mcode-patch-quota.sh
```

### 4.2 验证 launcher 是否真的被 patch

```bash
LAUNCHER=~/.minimax-code/releases/<v>/lib/node_modules/@minimax-ai/code/chunks/launcher-*.js
grep -c "__mcodeQuotaRender\|__mcodeQuotaStart" "$LAUNCHER"
# 期望 >= 2（每个名字至少一处定义 + 一处调用）
```

### 4.3 验证 launcher 语法

```bash
LAUNCHER=~/.minimax-code/releases/<v>/lib/node_modules/@minimax-ai/code/chunks/launcher-*.js
node --check "$LAUNCHER" && echo "syntax OK"
# 期望 exit 0 + "syntax OK"
```

---

## 5. 重派生锚点（mcode 改了 launcher 内部时）

如果 patcher 报"anchor not found"，需要**重新找到两个锚点**。

### 5.1 找到 base class 锚点

在 launcher 里找 status 渲染基类（**`render(width)` 方法返回 `["", content]` 数组**的类）：

```bash
LAUNCHER=~/.minimax-code/releases/<v>/lib/node_modules/@minimax-ai/code/chunks/launcher-*.js
# 找 class 定义 + render 方法
python3 -c "
with open('$LAUNCHER', 'rb') as f: d = f.read().decode('utf-8', errors='replace')
import re
# Match: Xc=class{...render(width){...}}
# 在 0.2.7 0.3.10 是 Xc；未来可能改名字
for m in re.finditer(r'(\w+)=class\{[^}]*?render\(\w+\)\{[^}]{0,400}\}\}', d):
    print(m.group(0)[:400])
    print('---')
"
```

**重点找**：

```js
XXXX=class{constructor(e){this.state=e}setState(e){this.state=e}invalidate(){}render(e){let t=XXXXX(e);...return XXXXX(r).trim()?["",r]:[]}}
```

`XXXX` 是被混淆后的短名（之前观察过 `bc` → `Xc`）。模式特征：
- `render(e)` 接受一个 width 参数
- 末尾返回 `["",r]`（空行 + content）

### 5.2 找到 widget class 锚点

找继承自 base class 的**状态栏 widget** 类（构造时调 `super(t)` + 设 `this.runtime` + `this.requestRender` + `setInterval`）：

```bash
# 找 extends Xc 的类
python3 -c "
with open('$LAUNCHER', 'rb') as f: d = f.read().decode('utf-8', errors='replace')
import re
# Match: var YYYY=class extends XXXX{...}
for m in re.finditer(r'var (\w+)=class extends \w+\{[^}]{0,800}\}', d):
    if 'super(' in m.group(0) and 'setInterval' in m.group(0) and 'requestRender' in m.group(0):
        print(m.group(0)[:500])
        print('---')
"
```

### 5.3 更新 patcher

把新找到的 `XXXX` 替换旧 `Xc`，新 `YYYY` 替换旧 `jf`，更新 `mcode-patch-quota.sh` 里的：

- `RENDER_ANCHOR`
- `WIDGET_ANCHOR`
- `RENDER_PATCH`（把 `Xc=class` 替换成 `XXXX=class`，`Xc.render` 不用动）
- `WIDGET_PATCH`（把 `var jf=class extends Xc` 替换成 `var YYYY=class extends XXXX`）

### 5.4 复测

```bash
/home/weekbin/orca/projects/mcode/mcode-quota/mcode-patch-quota.sh
/home/weekbin/orca/projects/mcode/mcode-quota/mcode-quota-doctor
mcode-with-quota
```

---

## 6. 彻底还原

如果想完全回到原始 mcode（不带 quota 行）：

### 6.1 当前版本

```bash
LAUNCHER=~/.minimax-code/releases/<v>/lib/node_modules/@minimax-ai/code/chunks/launcher-*.js
cp "$LAUNCHER.unpatched.bak" "$LAUNCHER"
rm "$LAUNCHER.unpatched.bak" "$LAUNCHER.unpatched.bak.stamp"
rm ~/.minimax-code/releases/<v>/lib/node_modules/@minimax-ai/code/chunks/mcode-quota-fetcher-*.mjs
```

### 6.2 全部 release 都还原

```bash
# 谨慎：会还原所有 mcode 版本
for release in ~/.minimax-code/releases/*/; do
  for bak in "$release"lib/node_modules/@minimax-ai/code/chunks/launcher-*.unpatched.bak; do
    [[ -f "$bak" ]] || continue
    target="${bak%.unpatched.bak}"
    echo "Restoring: $target"
    cp -p "$bak" "$target"
    rm "$bak"
  done
  rm -f "$release"lib/node_modules/@minimax-ai/code/chunks/mcode-quota-fetcher-*.mjs
done
```

### 6.3 卸载工具集

```bash
rm -rf /home/weekbin/orca/projects/mcode/mcode-quota
rm -f /home/weekbin/.minimax/bin/mcode-with-quota
```

下次想用就从 git 历史（如果项目版本化了）恢复。

---

## 7. 自定义扩展

### 7.1 改颜色阈值

`mcode-patch-quota.sh` 的 sidecar 模板里：

```js
const colorFor = (rem) =>
  rem == null ? C_MUTED : rem <= 10 ? C_ERROR : rem <= 30 ? C_WARNING : C_SUCCESS;
```

改 `10` / `30` 切换点（比如想 15% / 50%）即可。

### 7.2 改颜色 RGB

```js
const C_SUCCESS = "38;2;60;160;90";    // 改 RGB 三元组
const C_WARNING = "38;2;200;150;40";
const C_ERROR   = "38;2;200;80;80";
```

### 7.3 改进度条宽度

```js
const MAX_BAR_WIDTH = 20;   // 改这里
const MIN_BAR_WIDTH = 12;
```

### 7.4 改缓存 TTL

```js
const CACHE_TTL_MS = 60_000;   // 默认 60s，改这里
```

### 7.5 加新字段（比如 token 总量）

1. 改 sidecar 模板的 `raw` 对象加新字段
2. 改 `fetchOnce` 解析新字段（从 `mmx quota` JSON）
3. 改 `renderOne` 在横排 / 竖排时输出新内容

### 7.6 改横排/竖排切换阈值

```js
const HORIZ_MIN_WIDTH = 88;   // 改这里（< 这个宽度 → 竖排）
```

### 7.7 改完怎么生效

直接跑 patcher：

```bash
/home/weekbin/orca/projects/mcode/mcode-quota/mcode-patch-quota.sh
# 它会检测"已 patch"并跳过 launcher patch，但 sidecar 模板会被覆盖重写
# （注：当前 patcher 对 sidecar 始终重写，覆盖已有）
```

如果只想改 sidecar 不动 launcher：手动复制 patcher 里 sidecar 模板内容到 `~/.minimax-code/.../mcode-quota-fetcher-9f8a7b.mjs`。

---

## 8. Troubleshooting 速查表

| 症状 | 原因 | 修复 |
|---|---|---|
| mcode 启动报 "Invalid or unexpected token" | launcher 语法被破坏（patch 失败残留） | 还原 backup，重跑 patcher |
| quota 行完全不显示 | sidecar 没启动（NODE_OPTIONS 没设） | 用 `mcode-with-quota` 启动，不要直接 `mcode` |
| quota 行显示为灰色"no data" | mmx 没登录 / mmx quota 拿不到数据 | 跑 `mmx auth status` 确认登录 |
| 进度条颜色不显示 | terminal 不支持 24-bit color | 终端设置 `COLORTERM=truecolor` 或换终端 |
| mcode 启动时 sidecar 报 fetch 错误 | mmx 没在 PATH 上 | `which mmx` 确认；或 symlink 到 `/usr/local/bin` |
| 切换 release 后 quota 不显示 | 新 release 的 launcher 没 patch | 跑 `mcode-patch-quota.sh`（§3.2） |
| 切换 release 后 patcher 报 anchor not found | mcode 内部 anchor 改名 | §5 重派生锚点 |
| 升级 mcode 后 quota 行颜色变了 | mcode 内部 theme 改了 | 不用管 — 我们的 RGB 是写死的（§7.2） |
| 进度条后面"resets in"被截断 | terminal 太窄 + mcode 内部 truncate | 拉宽 terminal（§7.6 改切换阈值） |

---

## 9. 备份策略建议

工具集本身放在 `~/orca/projects/mcode/mcode-quota/`（用户工作区）— 但**项目目录本身没版本化**。强烈建议把整个目录纳入 git：

```bash
cd /home/weekbin/orca/projects/mcode
git init
git add mcode-quota/
git commit -m "init: mcode quota status-bar patch tools"
```

以后 patcher 脚本改了可以直接 `git diff` 看变化；mcode 升级后出问题也能 `git log` 找回归点。

---

## 10. 已知限制

- **sidecar 必须放在 mcode chunks 目录**（`~/.minimax-code/.../chunks/`）— 这是 mcode npm 包内的固定位置，mcode update 会清空
- **进度条颜色只在支持 24-bit color 的终端显示**（绝大多数现代 terminal 都支持）
- **`script` 伪 TTY 默认 80 列**，所以 CI / 自动化测试看到的总是竖排 layout
- **mmx CLI 是 mmx 独立产品**，跨 mcode 版本稳定；但如果 mmx 改了 `quota show` 输出 schema，需要改 `fetchOnce` 里的字段名
- **patcher 不验证 sidecar 运行**（只验证文件存在），需要 `mcode-quota-doctor` 做运行时检查
