# 安装与使用

## 前置条件

- Windows 11（当前实机验证平台）。
- Node.js `>=20` 和 npm。
- pnpm（DSH `plugin --profile ... add` 会将插件管理转发给 pnpm）。
- AGY CLI 已安装并完成登录，`agy agents` 能列出 `deepseek-proxy`。
- DSH 使用与插件兼容的 `@deepseek-ai/dsh-llm` runtime。

## 安装到 DSH profile

不要只在业务项目目录执行 `npm install dsh-agy-provider`。DSH Web 使用独立的 profile 依赖目录，必须通过 DSH 的 plugin 命令安装：

```powershell
npx @deepseek-ai/dsh plugin --profile web add dsh-agy-provider@0.6.1
```

该命令会将包加入 `web` profile 的依赖和 `dsh.profile.bundles`。验证是否已加载：

```powershell
npx @deepseek-ai/dsh --profile web --dump-config | Select-String dsh-agy-provider
```

然后重启 DSH Web：

```powershell
npx @deepseek-ai/dsh web
```

0.5.0 起，显式通过 `dsh plugin add` 安装的 bundle 默认是 `enabled: true`、`toolPolicy: agy-owned`。这不会在安装阶段发送模型请求；确认 AGY 已登录、`deepseek-proxy` 可用后即可启动 Web：

```yaml
- id: dsh-agy-provider
  config:
    enabled: false
    provider: agy
    agent: deepseek-proxy
    model: gemini-3.1-pro-high
    toolPolicy: reject
    sessionMode: full
```

上面的 patch 仅用于需要严格拒绝 DSH tool schemas 的用户；不需要严格模式时不要添加这段覆盖配置，直接使用 bundle 默认值即可。无论哪种模式，插件启动都不会自动发送模型请求。

如果只需要在普通 Node.js 项目中导入 Provider，而不是让 DSH Web 加载 bundle，才使用：

```powershell
npm install dsh-agy-provider@0.6.1
```

## 从 GitHub 安装源码包

开发分支也可以直接安装到 DSH profile：

```powershell
npx @deepseek-ai/dsh plugin --profile web add github:darkings/dsh-agy-provider
```

## 版本与发布状态

当前 0.6.1 是 0.6.0 的兼容性修复版；修复 DSH profile 缺少 `AttachmentStore` 时的插件 loader 启动错误。发布使用 npm Trusted Publishing。

## 配置

最小配置：

```yaml
enabled: true
provider: agy
agent: deepseek-proxy
model: gemini-3.1-pro-high
toolPolicy: reject       # reject | agy-owned
models:
  - id: gemini-3.1-pro-high
    name: Gemini 3.1 Pro High
    contextWindow: 1000000
  - id: gemini-3.6-flash
    name: Gemini 3.6 Flash
modelDiscovery: auto
modelDiscoveryTtlMs: 300000
modelDiscoveryTimeoutMs: 10000
```

`model` 继续兼容 0.1.0，并作为默认/回退模型；`models` 是可选的显式模型目录，按 `id` 去重。请求方明确传入的未知模型 ID 会原样交给 AGY，不会被 Provider 静默替换。

默认 `modelDiscovery: auto` 会以无 Shell 的方式执行 `agy models`，并将发现到的模型追加到显式目录之后。显式目录的顺序和 metadata 优先；发现结果只缓存在当前 Provider 进程内，默认 TTL 为 5 分钟，单次发现命令默认超时为 10 秒。设置 `modelDiscovery: off` 可恢复 0.2.0 的静态目录行为。

`reasoningEffort` 是请求级字段，不写入上述 Provider 配置。可选值为 `low`、`medium`、`high`，Provider 会将其作为独立 `--effort` 参数传给 AGY；未指定时不传该参数。`temperature`、`stop` 和 `maxTokens` 仍会返回不支持错误。

Provider 配置 `toolPolicy` 默认为 `reject`。只有在确认 AGY Agent 是唯一工具执行者时，才显式设置 `toolPolicy: agy-owned`；该模式忽略 DSH tool schemas，不产生 DSH tool chunks，也不会自动批准 AGY 权限请求。

推荐的资源边界：

```yaml
minimumAgyVersion: 1.1.13
maxConcurrent: 4
maxQueue: 32
queueTimeoutMs: 30000
maxOutputBytes: 8388608
maxEventLineLength: 1048576
sessionMode: full
modelDiscovery: auto
modelDiscoveryTtlMs: 300000
modelDiscoveryTimeoutMs: 10000
```

`sessionMode: full` 是默认值。它每轮发送 DSH 完整 history，不依赖 AGY 会话映射跨进程持久化；`resume` 仅在明确测量过 quota 成本后启用。

## 诊断

在源码目录运行：

```powershell
npm run diagnose
```

诊断只执行 `agy --version`、`agy agents`、`agy models` 和可选 DSH `--dump-config`，不会发送模型 Prompt、消耗 AGY 额度或执行工具。默认输出适合人工查看；使用 `--json` 可获得 `schemaVersion: 1`、组件状态、模型能力、`modelCatalog.source`、`modelCatalog.stale`、`modelCatalog.warning`、`modelCatalog.warningCode` 和稳定错误码。指定 profile 时额外包含 `profileSchemaVersion: 2`、effective Agent/session/retry/purpose/workspace/image 状态和只读 repair suggestions。

```powershell
npm run diagnose -- --json
```

从 npm 安装产物运行 profile-aware doctor：

```powershell
npx dsh-agy-provider doctor --profile web --json
```

如果 DSH CLI 不在 profile 或 PATH 中，显式传入 DSH JavaScript entry：

```powershell
npx dsh-agy-provider doctor --profile web --dsh-bin C:\path\to\node_modules\@deepseek-ai\dsh\lib\bin.js --json
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

`modelCatalog.source` 的含义为：`static` 表示关闭动态发现，`discovered` 表示没有静态目录且本次命令成功，`merged` 表示静态目录与本次发现目录合并，`cache` 表示发现失败但使用了最近成功目录，`fallback` 表示没有可用缓存而使用静态配置。`warningCode` 会稳定标记发现失败原因。发现命令失败不会阻断基础文本请求；运行中的目录变化会在下一次 `listModels()` 触发刷新，DSH UI 若已缓存目录则需要重新加载 profile。

## 开发验证

```powershell
npm ci
npm run verify
npm run benchmark
```

发布前的无额度预检至少应包含：

```powershell
npm run verify
npm run benchmark
npm run diagnose -- --json
npm pack --dry-run
```

不依赖预先配置的 `DSH_HOME`/`DSH_BIN` 时，运行自包含 DSH Mock smoke：

```powershell
npm run smoke:dsh:self-contained
```

该脚本在临时目录安装固定 `@deepseek-ai/dsh@0.1.0-rc.7`，使用 DSH 原生 `plugin --profile web/headless add` 安装当前 Provider tarball，检查 Web bundle defaults、运行 doctor，并在 headless profile 执行 `agy-mock` 文本请求后自动清理。它不会调用 AGY，结果固定标记 `quotaUsed: false`。

这些命令不会发送模型 Prompt；`diagnose` 只读取 AGY 版本、Agent 和模型目录，`benchmark` 与测试使用本地数据或 fake runner。完整的版本 bump、tag、Trusted Publisher 和 registry 复验步骤见 [发布检查清单](release-checklist.md)。

真实 AGY 请求会消耗已登录账号额度；自动化测试和 benchmark 使用 fake runner/本地数据，不需要 AGY 请求。

## 已知边界

默认不桥接 DSH tools 与 AGY 内部 tools；DSH 传入非空 `tools` 时返回 `UNSUPPORTED_TOOLS`。显式 `toolPolicy: agy-owned` 时只忽略 DSH schemas，AGY 仍独占内部 tools；AGY headless 请求权限时返回 `PERMISSION_REQUIRED`。完整约束见 `docs/tool-capability-matrix.md`。
