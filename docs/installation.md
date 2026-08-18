# 安装与使用

## 前置条件

- Windows 11（当前实机验证平台）。
- Node.js `>=20` 和 npm。
- AGY CLI 已安装并完成登录，`agy agents` 能列出 `deepseek-proxy`。
- DSH 使用与插件兼容的 `@deepseek-ai/dsh-llm` runtime。

## 从 npm 安装

公开包可以直接安装：

```powershell
npm install dsh-agy-provider
```

安装包会通过 `dsh.bundle.patch` 暴露插件入口。pnpm 用户需要按自己的 pnpm 版本允许该依赖的构建脚本。

## 从 GitHub 安装源码包

开发分支也可以直接安装：

```powershell
npm install github:darkings/dsh-agy-provider
```

## 配置

最小配置：

```yaml
enabled: true
provider: agy
agent: deepseek-proxy
model: gemini-3.1-pro-high
models:
  - id: gemini-3.1-pro-high
    name: Gemini 3.1 Pro High
    contextWindow: 1000000
  - id: gemini-3.6-flash
    name: Gemini 3.6 Flash
```

`model` 继续兼容 0.1.0，并作为默认/回退模型；`models` 是可选的显式模型目录，按 `id` 去重。请求方明确传入的未知模型 ID 会原样交给 AGY，不会被 Provider 静默替换。

推荐的资源边界：

```yaml
minimumAgyVersion: 1.1.13
maxConcurrent: 4
maxQueue: 32
queueTimeoutMs: 30000
maxOutputBytes: 8388608
maxEventLineLength: 1048576
sessionMode: full
```

`sessionMode: full` 是默认值。它每轮发送 DSH 完整 history，不依赖 AGY 会话映射跨进程持久化；`resume` 仅在明确测量过 quota 成本后启用。

## 诊断

在源码目录运行：

```powershell
npm run diagnose
```

诊断只执行 `agy --version` 和 `agy agents`，不会发送模型 Prompt、消耗 AGY 额度或执行工具。默认输出适合人工查看；使用 `--json` 可获得 `schemaVersion: 1`、组件状态、模型能力和稳定错误码：

```powershell
npm run diagnose -- --json
```

可用以下环境变量覆盖检查目标。`AGY_MODELS` 必须是 JSON 数组：

```powershell
$env:AGY_PATH = 'C:\Users\Jie\.local\bin\agy.exe'
$env:AGY_AGENT = 'deepseek-proxy'
$env:AGY_MINIMUM_VERSION = '1.1.13'
$env:AGY_MODELS = '[{"id":"gemini-3.1-pro-high"},{"id":"gemini-3.6-flash"}]'
npm run diagnose
```

诊断结果不会返回 `AGY_PATH` 的完整路径，也不会包含 Prompt、凭据或 Token；`quotaUsed` 固定为 `false`。

## 开发验证

```powershell
npm ci
npm run verify
npm run benchmark
```

真实 AGY 请求会消耗已登录账号额度；自动化测试和 benchmark 使用 fake runner/本地数据，不需要 AGY 请求。

## 已知边界

V1 不桥接 DSH tools 与 AGY 内部 tools。DSH 传入非空 `tools` 时返回 `UNSUPPORTED_TOOLS`；AGY headless 请求权限时返回 `PERMISSION_REQUIRED`。完整约束见 `docs/tool-capability-matrix.md`。
