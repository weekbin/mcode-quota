# mcodex — 维护指南

## 1. TL;DR

```bash
# 升级 mcode
mcode update

# 直接启动（自动重建 fork）
mcodex

# 自检
/home/weekbin/orca/projects/mcode/mcode-quota/mcode-quota-doctor

# 启动实测
mcodex
```

绝大多数情况下**不需要手动跑 patcher** —— `mcodex` 每次启动都会做幂等检查。

---

## 1.5 原生路径（mcode >= 0.4.0）—— 日常大多数情况

```bash
mcodex status      # 看当前策略 / 配置是否就位
mcodex install     # 写入/刷新 config.yaml（幂等）
mcodex uninstall   # 移除我们的两个键（往返字节级一致）
mcodex doctor      # 自检
```

排障顺序：

1. **状态栏没有我们的 3 行**
   - `mcodex status` 看 `config applied`。否 → `mcodex install`。
   - 确认 `tui.statusLine` 里有 `custom-command`，且 `tui.customStatusLine.command`
     指向一个**可执行**文件。
   - 手动跑一次，看它到底输出什么：
     ```bash
     printf '{"protocol":1,"event":"interval","session_id":"<某个 mvs_…>","workspace_dir":"/tmp","model":"-","tui_version":"0.4.0"}\n' | COLUMNS=200 ./mcodex-status
     ```
     有输出 → 问题在 mcode 侧（配置没生效/被覆盖）；无输出 → 见下一条。
   - `MCODEX_STATUS_DEBUG=1` 再跑一次，stderr 会说明是取数失败还是渲染失败。

2. **只有部分行**（例如缺 5h/周）
   - 那是 mmx 的问题：`mmx quota show --output json --quiet` 手动跑一次。
   - 配额与今日统计各有 60s 文件缓存，清掉 `~/.cache/mcodex/` 可强制刷新。

3. **数字不对**
   - 先清 `~/.cache/mcodex/` 重试。
   - 会话 token 很小 → 检查 sqlite 是否有该 session 的 `local_runtime_token_usage`。
   - 上下文百分比与 mcode 原生 `Context N% left` 不互补 → 取该 session 最新
     assistant 行的 `context_usage` 对比：
     ```bash
     sqlite3 ~/.minimax/v2/sqlite/runtime-state.sqlite \
       "SELECT json_extract(data_json,'$.context_usage') FROM local_runtime_message_rows \
        WHERE session_id='<sid>' ORDER BY id DESC LIMIT 1"
     ```

4. **改完 config 想还原**
   - `mcodex uninstall`，或恢复一次性备份 `~/.minimax/config.yaml.mcodex-backup`。

---

## 2. 架构速览

```
mcode 官方安装（只读）        私有 fork（可随时删）
~/.minimax-code/releases/<v>/  ~/.local/share/mcode-quota/mcode-clone/<v>/code/
   lib/.../chunks/launcher.js     cli.js            ← 静态 import sidecar
        │                         chunks/launcher.js ← render() 覆盖
        │                              │
        └──── 从不写入 ────────────────┘
                                       │
                    sidecar（项目目录）← 懒启动：第一次渲染才 fork mmx
```

- patcher：`mcode-patch-quota.mjs`（Node，幂等）
- 锚点发现：`mcode-find-anchors.mjs`（acorn AST）
- 入口：`~/.minimax/bin/mcodex` → 项目目录 `mcodex`
- 自检：`mcode-quota-doctor`

---

## 3. 常规升级流程

### 3.1 升级

```bash
mcode update
```

### 3.2 启动

```bash
mcodex
```

`mcodex` 内部流程：

1. 读 `~/.minimax-code/current`
2. 跑 `mcode-patch-quota.mjs --src=... --fork-base=... --sidecar=... --current=<版本>`
   - `.fork-marker` 版本不匹配 → 删除旧 fork
   - 从 `tarballs/minimax-ai-code-<版本>.tgz` 解压；没有就 `npm pack` 下载
   - 真实拷贝到 `<fork>/code`
   - 打两处 patch + 重写 sidecar
3. `exec <mcode 官方 node> <fork>/code/cli.js "$@"`

patcher 失败 → **自动回退到未打 patch 的官方 mcode**，不会卡住你。

### 3.3 自检

```bash
/home/weekbin/orca/projects/mcode/mcode-quota/mcode-quota-doctor
```

期望 `22 ok, 0 warnings, 0 failures`。关键项：

```
[ok] mcode launcher pristine (no quota hooks)
[ok] mcode launcher byte-identical to pristine npm tarball
[ok] fork launcher render hook present
[ok] fork cli.js imports sidecar statically
[ok] mcodex does not use NODE_OPTIONS
[ok] breakdown shown at 200 cols
[ok] breakdown dropped at 100 cols, 上下文 kept
[ok] context usage: 上下文 42K/200K 21%
[ok] separator is │ (U+2502)
[ok] no mmx process storm (concurrent: 0)
```

（`MCODE_QUOTA_TAIL=compact` / `=full` 时对应的明细项会从 ok 降为 info，属预期。）

---

## 4. 故障诊断

| 现象 | 原因 | 处理 |
|---|---|---|
| `mcodex` 启动后是**原版界面**（无 quota 行） | patcher 失败已回退 | `MCODE_QUOTA_DEBUG=1 mcodex` 看 stderr |
| quota 行完全不显示 | sidecar 未加载 / fork 未建 | 跑 doctor；确认 `fork cli.js imports sidecar` 为 ok |
| 只有会话 tokens，无 5小时/周 | `mmx` 不在 PATH 或未登录 | `which mmx`；`mmx auth status` |
| 无 上下文 字段 | 该会话还没产生 `contextSnapshot`（新会话、或 runtime 未就绪） | 正常；跑完一个 turn 后自动出现。doctor 用合成快照单独验证该路径 |
| 上下文百分比与 `/context` 对不上 | 两者取数时点不同（这里是渲染时实时读 shellState） | 以 `/context` 详情为准，差异应在一次渲染周期内收敛 |
| 会话 tokens 恒为 0 | runtime 与 sqlite 都无该会话数据 | 确认会话有完成的 turn；`SELECT * FROM local_runtime_token_usage WHERE session_id=...` |
| doctor 报 `mcode launcher is PATCHED` | 历史遗留污染 | 用 npm tarball 覆盖该 launcher（见 §6） |
| doctor 报 fork 相关 FAIL | fork 半成品 | 删掉 fork 目录，重跑 `mcodex` |
| 进度条颜色不显示 | 终端不支持 24-bit | 设置 `COLORTERM=truecolor` 或换终端 |
| 升级后锚点找不到 | mcode 大重构 | §5 重派生 |

### 4.1 打开诊断日志

```bash
MCODE_QUOTA_DEBUG=1 mcodex
```

### 4.2 强制重建 fork

```bash
node -e 'require("fs").rmSync(process.env.HOME+"/.local/share/mcode-quota/mcode-clone/0.3.10",{recursive:true,force:true})'
mcodex
```

（把 `0.3.10` 换成实际版本；版本号见 `cat ~/.minimax-code/current`。）

### 4.3 离线模式

```bash
MCODE_QUOTA_OFFLINE=1 mcodex    # 只用已缓存 tarball 或已安装源码，不联网
```

---

## 5. 重派生锚点（mcode 大重构时）

patcher 报 `anchor finder failed` / `anchor parse failed` 时：

```bash
MCODE_FIND_ANCHORS_DEBUG=1 \
node /home/weekbin/orca/projects/mcode/mcode-quota/patches/<当前版本>/mcode-find-anchors.mjs \
     ~/.local/share/mcode-quota/mcode-clone/<版本>/code/chunks/launcher-*.js
```

输出示例：

```
BASE='Xc'
WIDGET='jf'
RENDER_METHOD_END=824661
WIDGET_BODY_END=824662
CTOR_END=823576
RUNTIME_PROP='runtime'
SHELLSTATE_PROP='shellState'
```

`mcode-find-anchors.mjs` 的匹配特征（`WIDGET`，v3.0 起改为 AST 推断）：

- 存在 `super()` 调用
- 类体内有 `setInterval(...)` 调用（widget 唯一稳定的结构信号）
- 构造器接收 ≥ 2 个参数，并将其中的 ≥ 2 个赋给 `this.X` 字段
- 字段名按候选优先级推断（`runtime > _runtime > rt > tu > r > context > ctx`）

不需要 `render` 方法存在（widget 可继承基类 render）。

## 5.5 加新 mcode 版本（patcher 跟随升级）

mcode 升级后 mcodex 跑得起来不代表 patcher 是最优的。当以下任一情况发生时
（应该都能从 mcode-find-anchors 输出看出来）：

- `WIDGET_BODY_END` / `CTOR_END` 偏移变了
- `RUNTIME_PROP` / `SHELLSTATE_PROP` 名字变了
- 构造器参数个数变了
- widget 类名变了

**操作**：

```bash
# 1. 在 patches/ 下建新版本目录
NEW="0.3.12"
mkdir -p "patches/$NEW"
cp patches/0.3.11/mcode-patch-quota.mjs  "patches/$NEW/"
cp patches/0.3.11/mcode-find-anchors.mjs "patches/$NEW/"

# 2. 跑 mcode 0.3.12 实际 launcher，验证 finder 还能识别
MCODE_FIND_ANCHORS_DEBUG=1 \
  node patches/$NEW/mcode-find-anchors.mjs \
       ~/.local/share/mcode-quota/mcode-clone/$NEW/code/chunks/launcher-*.js

# 3. 起一次 mcodex，确认 fork 注入成功
mcodex --help
mcode-quota-doctor

# 4. 跑回归
node tests/mcode-smoke.mjs

# 5. 写 patches/$NEW/NOTES.md，记录该版本与上一版的差异
# 6. commit + push
./mcodex-push-remote
```

**如果 patcher 不需要改**（widget 字段和偏移都没变，比如 0.3.10 → 0.3.11），
loader 也能直接走老目录——`patches/0.3.11/` 自动成为 0.3.12 的 fallback。
但建议还是建 `patches/0.3.12/` 并 NOTES 里说"与 0.3.11 同源"，便于回溯。

**如果没建新目录 + 也没老目录 <= 当前版本**，loader 报错并列出可用版本，
mcodex 走 fallback 分支跑**未打 patch 的官方 mcode**（不卡你）。

如果 mcode 改了这些特征，需要更新 `mcode-find-anchors.mjs` 里的特征列表。
**patcher 本体不需要改** —— 它只消费 `WIDGET_BODY_END` / `CTOR_END` 两个偏移。

验证：

```bash
node patches/_loader.mjs --fork-base=... --sidecar=... --current=<版本> --offline
node --check ~/.local/share/mcode-quota/mcode-clone/<版本>/code/chunks/launcher-*.js
```

---

## 6. 把 mcode 还原到纯净状态

正常情况下**不需要**做这件事（我们从没写过 mcode 本体）。
如果历史版本留下了污染，用官方 tarball 覆盖：

```bash
V=0.3.10
TB=~/.local/share/mcode-quota/mcode-clone/tarballs/minimax-ai-code-$V.tgz
DST=~/.minimax-code/releases/$V/lib/node_modules/@minimax-ai/code
mkdir -p /tmp/restore-$V && tar -xzf "$TB" -C /tmp/restore-$V --strip-components=1
cp -f /tmp/restore-$V/chunks/launcher-*.js "$DST/chunks/"
# 删除遗留文件
node -e 'const fs=require("fs");const d="'"$DST"'/chunks";for(const f of fs.readdirSync(d))if(/quota|unpatched\.bak|stormquake/.test(f)){fs.unlinkSync(d+"/"+f);console.log("removed",f)}'
```

然后 `mcode-quota-doctor` 应显示 `byte-identical to pristine npm tarball`。

---

## 7. 自定义

全部改动都在 `mcode-patch-quota.mjs` 的 `SIDECAR_BODY` 模板里，改完重跑 `mcodex` 即生效。

### 7.1 颜色阈值

```js
const colorFor = (rem) =>
  rem == null ? C_MUTED : rem <= 20 ? C_ERROR : rem <= 50 ? C_WARNING : C_SUCCESS;
```

### 7.2 颜色 RGB

```js
const C_SUCCESS = "38;2;60;160;90";    // 深绿
const C_WARNING = "38;2;200;150;40";   // 暗橙
const C_ERROR   = "38;2;200;80;80";    // 暗红
```

### 7.3 进度条宽度 / 布局阈值

```js
const MAX_BAR_WIDTH = 20;
const MIN_BAR_WIDTH = 8;
const HORIZ_MIN_WIDTH = 110;
const NARROW_MIN_WIDTH = 80;
```

### 7.4 刷新节奏

```js
const CACHE_TTL_MS = Number(process.env.MCODE_QUOTA_TTL_MS || 60_000);       // quota 轮询间隔
const SESSION_TTL_MS = 10_000;                                                // 会话 token 轮询间隔
const FETCH_TIMEOUT_MS = 20_000;                                              // mmx 单次超时
const MMX_FAILURE_RESET_MS = Number(process.env.MCODE_QUOTA_MMX_COOLDOWN_MS || 5 * 60_000);  // 熔断冷却
const TAIL_MODE = (() => {                                                      // 排版模式
  const v = String(process.env.MCODE_QUOTA_TAIL || "").toLowerCase();
  return v === "compact" || v === "full" ? v : "auto";                          // 默认 auto
})();
```

前两个环境变量只为测试而存在（缩短到秒级），生产不要设置。
`MCODE_QUOTA_TAIL` 是给用户的排版开关：

- 不设置 / `auto`（默认）— 响应式：按 **行数 > 进度条宽度 > 明细** 打分，
  明细只在「不多占一行、不挤瘦进度条」时才显示
- `full` — 永远保留明细，宁可换行（v2.1.2 的行为）
- `compact` — 永远不显示明细（v2.1.0 的行为）

### 7.5 文案

```js
const L_LABEL_5H = "小时会话窗口";
const L_LABEL_WEEK = "周限制使用量";
const L_LABEL_SESSION = "会话 tokens";
const L_CONTEXT = "上下文";        // 显示「已用/总量 百分比」，≥75% 暗橙、≥90% 暗红
const L_IN = "输入";
const L_OUT = "输出";
const L_CACHE = "缓存";
const L_LEFT = "剩余";
const L_RESET = "重置";
```

分隔符为 `│`（U+2502），定义在 `dot()` 与 `SEP`。

---

## 8. 卸载

```bash
# 1. 删 PATH 入口
node -e 'require("fs").unlinkSync(process.env.HOME+"/.minimax/bin/mcodex")'

# 2. 删 fork 与缓存（约 130MB）
node -e 'require("fs").rmSync(process.env.HOME+"/.local/share/mcode-quota",{recursive:true,force:true})'

# 3. 工具集本身在 git 仓库里，按需保留
```

mcode 本体从未被修改，卸载后 `mcode` 照常工作。

---

## 9. 已知限制

- fork 每版本约 62MB 真实拷贝（换掉 realpath 陷阱）
- sidecar 路径写死在 fork 的 `cli.js`；移动项目目录需重跑 patcher（`mcodex` 自动处理）
- `mmx` 输出 schema 变化时需更新 `fetchQuotaOnce` 里的字段名
- `script` 伪 TTY 默认 80 列，自动化测试会看到三行紧凑布局（明细放不下）；想看单行带明细需 ≥150 列
