# Architecture — mcode quota patch 原理

这份文档解释 **mcode-patch-quota.sh 是怎么工作的**、**锚点匹配逻辑是什么**、以及 **mcode 升级后怎么继续维护**。

## 0. 背景：mcode TUI 是什么

mcode 是用 [Ink](https://github.com/vadimdemedes/ink)（React for CLI）写的 TUI 应用。TypeScript 源码经 esbuild 打包成 chunks bundle（`chunks/launcher-*.js` 等），Node.js 在用户终端上跑这个 bundle。

TUI 是 React 组件树：

```
Ink render(root)
  └─ Launcher
      ├─ Welcome / Transcript
      ├─ Status bar       ← parts.status
      ├─ Activity bar     ← parts.activity
      ├─ Composer         ← parts.composer (输入框)
      ├─ Tasks / Goal / Interaction / FollowUp / Notice
      └─ Footer
```

每个 `parts.xxx` 是个 widget 类，统一实现 **`{ render(width): string[] }` 接口**：
- 接收 TUI 当前 content width
- 返回一个 string 数组，每个元素是一行
- Ink 把这些行写进 stdout → 用户看到 TUI

Launcher 在 `launcher-U4C3IZNL.js` / `launcher-CVR77P3I.js` 等 bundle 文件里。

## 1. 锚点 1 — `Xc` (base class for status)

### 1.1 原始代码（unpatched）

```js
Xc=class{
  constructor(e){this.state=e}
  setState(e){this.state=e}
  invalidate(){}
  render(e){                       // e = TUI content width
    let t=ma(e);
    if(t===0)return[];
    let i=X6(this.state);
    if(i.length===0)return[];
    let s=i.map(o=>J6(o,this.state)).filter(o=>o!==void 0);
    if(s.length===0)return[];
    let r=t3(s,t);
    return xe(r).trim()?["",r]:[]   // ← 关键: [空行, 渲染好的内容]
  }
}
```

### 1.2 Patch 后的代码

```js
Xc=class{
  constructor(e){this.state=e}
  setState(e){this.state=e}
  invalidate(){}
  render(e){
    let t=ma(e);
    if(t===0)return[];
    let i=X6(this.state);
    if(i.length===0)return[];
    let s=i.map(o=>J6(o,this.state)).filter(o=>o!==void 0);
    if(s.length===0)return[];
    let r=t3(s,t);
    if(!xe(r).trim())return[];

    // ↓↓↓ 注入: 追加 sidecar 提供的 quota 行 ↓↓↓
    let _qr=typeof globalThis.__mcodeQuotaRender==="function"
      ?globalThis.__mcodeQuotaRender(e)
      :[];
    if(!Array.isArray(_qr)||_qr.length===0)return["",r];
    return["",r,..._qr];           // ← 关键: 展开多行 quota
  }
}
```

**只改了一处**：把 `return ...trim()?["",r]:[]` 替换成新版。**`Xc` 类名、`render(e)` 签名、`["",r]` 返回形态都保留**。

### 1.3 为什么这个锚点稳定

- `render(width)` 接受一个数字参数、返回 string 数组 — **这是 React 组件 render 的固定契约**
- `["", r]`（空行 + content）— mcode 在 status bar 上面留空一行作为视觉间距，这个 layout 决策不会变
- 整段都是 `let t=ma(e); if(t===0)return[]; ... return ...trim()?["",r]:[]` 的**结构性代码**，混淆器无法优化

**不稳定的部分**（会变的）：
- `Xc` 这个类名（混淆器可能给成 `Yx`/`Z1` 等）
- `ma` / `X6` / `J6` / `t3` / `xe` 这些内部函数名

所以 patch 锚点是**一长串 literal string**（包含整段 `render` body），而不是只匹配类名。

## 2. 锚点 2 — `jf` (status widget class)

### 2.1 原始代码

```js
var jf=class extends Xc{
  constructor(t,i,s){
    super(t);
    this.runtime=i;                          // ← mcode 运行时接口
    this.requestRender=s;                    // ← 触发 mcode 重绘的回调
    this.statusLineItems=t.statusLineItems;
    this.shellState=t;
    this.refresh();
    this.refreshTimer=setInterval(()=>void this.refresh(),o3);
    this.refreshTimer.unref?.()
  }
  shellState; statusLineItems; workspaceGit;
  refreshTimer; refreshSequence=0; disposed=!1;
  setState(t){...}
  ...
}
```

### 2.2 Patch 后的代码

```js
var jf=class extends Xc{
  constructor(t,i,s){
    super(t);
    this.runtime=i;
    this.requestRender=s;
    this.statusLineItems=t.statusLineItems;
    this.shellState=t;
    this.refresh();
    this.refreshTimer=setInterval(()=>void this.refresh(),o3);
    this.refreshTimer.unref?.();

    // ↓↓↓ 注入: 启动 sidecar fetcher ↓↓↓
    if(typeof globalThis.__mcodeQuotaStart==="function")
      globalThis.__mcodeQuotaStart(()=>{
        if(this.requestRender)setTimeout(()=>this.requestRender(),0)
      });
  }
  ...
}
```

**只加了 1 行（实际是 4 行展开 if 块）**，原有逻辑完整保留。`this.requestRender` 是 mcode 提供的回调，触发后 mcode 会重新调 `Xc.render` 拉新数据。

### 2.3 为什么这个锚点稳定

- `extends Xc` — 状态栏 widget 必须继承 base class（继承是 React 组件的固定模式）
- `super(t)` — 必须调父构造
- 构造体里**7 个赋值**（`runtime`/`requestRender`/`statusLineItems`/`shellState`/`refresh`/`refreshTimer`/`unref`）— 这是 mcode TUI 状态管理的固定 init 序列
- `setInterval(... o3)` — TUI 定时 refresh 是必要的（fetch git metadata）

整个构造体加 `extends Xc` 加 `var jf=class` — **200+ 字符的 literal string**，跨小版本几乎不可能完全重写。

## 3. Sidecar 通信机制

### 3.1 Sidecar 是什么

`mcode-quota-fetcher-9f8a7b.mjs` 是 ESM 模块，**和 mcode 共享同一个 Node.js 进程**。它通过 `NODE_OPTIONS="--import=...mjs"` 在 mcode 启动时 preloaded。

这意味着：
- sidecar 写的 `globalThis.X` 在 mcode bundle 里能直接读（同一个 V8 isolate）
- 不需要 IPC / 进程间通信
- 不需要 HTTP / 文件 IPC
- 不需要修改 mcode 的 import 路径

### 3.2 通信协议

**sidecar 暴露 2 个 globalThis 函数**：

```js
// 1. 启动 fetcher (status widget 构造时调)
globalThis.__mcodeQuotaStart = (onUpdate) => {
  // 立刻 fetch 一次
  // 然后每 60s fetch 一次
  // fetch 完后调 onUpdate() 触发 mcode 重绘
};

// 2. 渲染 quota 行 (Xc.render 时调, 接 width 决定 layout)
globalThis.__mcodeQuotaRender = (width) => {
  if (width >= 88) return [horizontalLine];  // 横排
  return [verticalLine1, verticalLine2];     // 竖排
};
```

**mcode 端只需要 patch 两行调用**，不引入新接口。

### 3.3 数据流（时序图）

```
启动 mcode
  ↓
Node --import 加载 sidecar
  ↓
sidecar 挂 globalThis.__mcodeQuotaStart / __mcodeQuotaRender
  ↓
mcode 启动 launcher
  ↓
jf.constructor 调 __mcodeQuotaStart(requestRender)
  ↓
sidecar 立即 fork mmx quota + 启动 60s 定时器
  ↓
[T=0s] mmx 返回数据 → sidecar 调 requestRender()
  ↓
mcode 重绘 → Xc.render(width)
  ↓
Xc.render 调 __mcodeQuotaRender(width) → 拿到 string[]
  ↓
Ink 写 stdout → 用户看到 quota 行
  ↓
[T=60s] 定时器触发 → 重复 fetch + 重绘
```

## 4. 锚点匹配 — 怎么找、怎么验证

### 4.1 当前锚点（mcode 0.3.10 / @minimax-ai/code 0.2.7）

**RENDER_ANCHOR** (base class):

```js
Xc=class{constructor(e){this.state=e}setState(e){this.state=e}invalidate(){}render(e){let t=ma(e);if(t===0)return[];let i=X6(this.state);if(i.length===0)return[];let s=i.map(o=>J6(o,this.state)).filter(o=>o!==void 0);if(s.length===0)return[];let r=t3(s,t);return xe(r).trim()?["",r]:[]}}
```

**WIDGET_ANCHOR** (status widget):

```js
var jf=class extends Xc{constructor(t,i,s){super(t);this.runtime=i;this.requestRender=s;this.statusLineItems=t.statusLineItems,this.shellState=t,this.refresh(),this.refreshTimer=setInterval(()=>void this.refresh(),o3),this.refreshTimer.unref?.()}
```

### 4.2 升级后怎么找新锚点

如果 patcher 报 `anchor not found`，说明 mcode 改了 launcher 内部结构。重新找：

**找 base class**：

```python
import re
with open('<launcher路径>', 'rb') as f: d = f.read().decode('utf-8', errors='replace')

# 模式: <Name>=class{ ... render(<param>) { ... return ["",r] ... } }
# 关键是: 有 render 方法 + 返回值包含 ["",r]
pattern = r'(\w+)=class\{[^}]{0,300}render\(\w+\)\{[^}]{0,500}\[""",]r\]'
for m in re.finditer(pattern, d):
    name = m.group(1)
    print(f"BASE CLASS: {name}")
    print(m.group(0)[:500])
    print('---')
```

**找 status widget**：

```python
# 模式: var <Name>=class extends <Base> { ... super(...); ... setInterval
pattern = r'var (\w+)=class extends (\w+)\{[^}]{0,500}super\([^)]+\)[^}]{0,500}setInterval'
for m in re.finditer(pattern, d):
    name, base = m.group(1), m.group(2)
    if 'requestRender' in m.group(0) and 'statusLineItems' in m.group(0):
        print(f"STATUS WIDGET: {name} extends {base}")
        print(m.group(0)[:500])
        print('---')
```

### 4.3 为什么不用 AST 解析？

可以，但 mcode chunks 是 esbuild 打包的产物（**不是源码**），格式是 minified single-line JS。AST 工具（acorn/babel）能解析但输出有噪声、匹配也复杂。

**literal string 匹配反而更稳**：
- 锚点必须完整匹配（任何子串都拒绝）→ 不接受近似匹配
- 锚点变化 → patcher 直接退出码 2 → 强制人工 review
- 比 AST "fuzzy match" 安全（AST fuzzy 可能在重构后误命中）

### 4.4 兼容性历史

| mcode 版本 | 锚点 | 状态 |
|---|---|---|
| 0.2.x 早期 | `bc=class{...render(e){...["",r]}}` | ❌ 已知不匹配（变量名 `bc` 不同） |
| 0.3.10 | `Xc=class{...}` + `var jf=class extends Xc{...}` | ✅ 当前 patcher 用这组 |

## 5. 更新流程

### 5.1 简单升级（锚点没变）

```bash
mcode update
mcode-patch-quota.sh   # 自动检测新 release，幂等
mcode-quota-doctor
mcode-with-quota       # 实测
```

### 5.2 锚点变了（需要 rebase）

```bash
# 1. 找新锚点 (用 §4.2 的 python 脚本)

# 2. 编辑 mcode-patch-quota.sh:
#    - RENDER_ANCHOR 替换成新 base class 字面量
#    - WIDGET_ANCHOR 替换成新 widget class 字面量
#    - RENDER_PATCH 里 'Xc=class' 改成 '新base=class'
#    - WIDGET_PATCH 里 'var jf=class extends Xc' 改成 'var 新widget=class extends 新base'

# 3. 验证
mcode-patch-quota.sh
mcode-quota-doctor
mcode-with-quota

# 4. commit
git add mcode-quota/
git commit -m "feat: rebase anchors for mcode <新版本>"
```

### 5.3 大重构（launcher 整体重写）

如果整个 launcher 文件结构变化，patcher 找锚点的正则都要重写。

这种情况很少（每 1-2 年一次），建议**完全重启 patcher** — 备份新 launcher，定位新位置，更新 4 个变量。

## 6. 已知限制

- **mcode update 会重装 release** — 必须每次重跑 patcher（已用 `--import` 注入避免改 mcode 主代码）
- **混淆器每次跑可能产生不同短名** — patcher 必须用 literal string 锚定整段结构
- **sidecar 必须放在 mcode chunks 目录**（npm 包内）— 这是 mcode 加载路径决定的
- **color 24-bit 需要 terminal 支持** — 老 terminal（TERM=xterm）会显示成方块或忽略
- **mmx CLI 是外部依赖** — 必须 PATH 上能找到，且 `mmx auth status` 已登录
