# tests/

升级漂移回归 + 端到端 patcher 验证。

## mcode-smoke.mjs

模拟 mcode 升级可能造成的几个具体场景，跑 patches/<current>/ 的 finder + patcher：

| 场景 | 模拟什么 | 期望 |
|---|---|---|
| baseline | 0.3.11 launcher 原文 | finder 仍返回 `WIDGET=jf`, `RUNTIME_PROP=runtime`, `SHELLSTATE_PROP=shellState` |
| this.runtime → this.engine | mcode 把 runtime 字段重命名 | finder 自动发现新名 `engine`，PATCH_RENDER 自动适配 |
| 3 字段全改 | mcode 同时改 runtime/requestRender/statusLineItems | finder 全部走 fallback 优先级 |
| super 参数换序 | mcode 调整构造器签名 | patcher 仍能注入；构造器超参路径不依赖顺序 |
| 删 statusLineItems | mcode 移除某字段 | finder 不依赖该字段，仍识别 widget |
| 改 ctor 参数名 | 纯 cosmetic rename | patcher 通过位置而非名字定位 |

外加 1 个端到端：用 patcher 重建一个全新 fork，验证：
- launcher chunk 注入成功
- cli.js import sidecar 成功
- `__mcodeRuntime` / `__mcodeShellState` 都被赋值

合计 25 个断言。**升级前跑一次**，升级后跑一次，如果哪条变红就是真要修的地方。

## 跑

```bash
node tests/mcode-smoke.mjs
```

不需要 mcode 安装 —— 全部 mock 在 tmpfs 跑。

## 配套

- `mcode-hub-doctor` 跑 live render 验证（端到端）
- `mcode-hub` 第一次启动会建 fork 并 patch launcher（生产路径）
