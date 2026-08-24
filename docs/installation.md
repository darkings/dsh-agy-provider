# 安装与使用（0.10.0）

## 前置条件

- Windows 11（当前实机验证平台，CI 覆盖 Ubuntu/macOS）。
- Node.js `>=20` 和 npm。
- pnpm（DSH `plugin --profile ... add` 会将插件管理转发给 pnpm）。
- AGY CLI 已安装并完成登录，`agy agents` 能列出 `deepseek-proxy`，`agy --version >=1.1.15`。
- DSH `@deepseek-ai/dsh@0.1.0-rc.7`（`rc.8` 隔离 lane 已审计，stable 仍为 rc.7）。

## 安装到 DSH profile

不要只在业务项目目录执行 `npm install dsh-agy-provider`。DSH Web 使用独立的 profile 依赖目录，必须通过 DSH 的 plugin 命令安装：

```powershell
npx @deepseek-ai/dsh plugin --profile web add dsh-agy-provider@0.10.0
```

该命令会将包加入 `web` profile 的依赖和 `dsh.profile.bundles`。验证是否已加载：

```powershell
npx @deepseek-ai/dsh --profile web --dump-config | Select-String dsh-agy-provider
```

然后重启 DSH Web：

```powershell
npx @deepseek-ai/dsh web
```

0.10.0 的 profile bundle 默认（`cordis.patch.yml`）相当于：

```yaml
enabled: true
provider: agy
model: gemini-3.1-pro
agent: deepseek-proxy
toolPolicy: dsh-owned
sessionMode: full
imageInput: off
```

库的 `Config({})` 仍为 `enabled: false / toolPolicy: reject`，只有 `BundleConfig` 为显式可用。无论哪种模式，插件启动都不会自动发送模型请求。

如果只需要在普通 Node.js 项目中导入 Provider，而不是让 DSH Web 加载 bundle，才使用：

```powershell
npm install dsh-agy-provider@0.10.0
```

## 从 GitHub 安装源码包

```powershell
npx @deepseek-ai/dsh plugin --profile web add github:darkings/dsh-agy-provider
```

## 版本与发布状态

`0.10.0` 在 0.9.0 的设置面板、模型可见性和工作区无感基础上增加 optimized full 上下文预算、工具结果确定性淘汰、脱敏诊断和 Windows 无控制台 launcher；默认仍为 `sessionMode: full`。发布使用 npm Trusted Publishing。

## 配置（0.9.0 推荐）

最小可用（设置面板可视化编辑，无需手写 YAML）：

```yaml
enabled: true
provider: agy
agent: deepseek-proxy
model: gemini-3.1-pro              # base 名称，推理强度在 DSH 会话中选 low/medium/high
visibleModels:                      # 设置面板勾选要显示的模型，空=全部
  - gemini-3.1-pro
  - gemini-3.7-flash
toolPolicy: dsh-owned               # recommend，reject | agy-owned(legacy) | dsh-owned
transport: one-shot                 # one-shot(默认) | persistent(opt-in，一 Session 一 worker)
modelDiscovery: auto
```

完整示例：

```yaml
enabled: true
provider: agy
agent: deepseek-proxy
model: gemini-3.1-pro
visibleModels:
  - gemini-3.1-pro
  - gemini-3.7-flash
models:
  - id: gemini-3.1-pro
    name: Gemini 3.1 Pro
    contextWindow: 1000000
toolPolicy: dsh-owned
transport: one-shot
sessionMode: full
modelDiscovery: auto
modelDiscoveryTtlMs: 300000
modelDiscoveryTimeoutMs: 10000
retryPolicy:
  maxRetries: 5
  retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]
imageInput: off
```

兼容说明：

- 旧 `model: gemini-3.7-flash-high` 仍会解析为 `base gemini-3.7-flash + effort high` 并 `DEPRECATED_MODEL_EFFORT_SUFFIX` warning，建议改为 base + 会话级推理强度选择。
- `workspaceRoot` 在 `dsh-owned` 下已废弃（`.deprecated()`，面板隐藏），自动使用 DSH Session 的项目目录；`agy-owned` 仍兼容但提示迁移。
- `reasoningEffort` 为请求级字段（`low/medium/high`），不写入 Provider 配置，作为独立 `--effort` 透传给 AGY。
- DSH Web 可能自动附带 `temperature/stop/maxTokens`；AGY 1.1.17 不支持这些参数，Provider 会忽略它们并使用 AGY 默认采样行为。

## 工作区与权限（0.9.0 无感化）

0.9.0 `dsh-owned` 不要求在 Provider 中重复配置 `workspaceRoot`。项目目录来自 DSH 当前 Session 的 canonical `cwd`（`header.cwd → workspaceRegistry → sandboxPolicy` 三方一致校验）；`read-only`、`workspace-write`、`danger-full-access` 由 DSH UI/Session 选择并由 sandbox/approval 强制执行。

- `read-only`：read/search 可用，write/edit/shell 写入被 DSH 拒绝。
- `workspace-write`：允许项目 workspace 内的 write/edit/shell 写入，越界仍由 DSH 拒绝或要求 approval。
- `danger-full-access`：只有 DSH 明确选择后才可越过 workspace 边界；Provider 不自行提升权限。

Provider 不执行 DSH tools，不传 `--dangerously-skip-permissions`，不把工具参数/结果写入日志。纯文本请求无需 workspace；有工具请求在无 workspace 时返回 `DSH_WORKSPACE_MISMATCH` 可操作错误，doctor 建议“请先在 DSH 中打开项目文件夹”。迁移见 [0.9.0 迁移说明](migration-0.9.0.md)、[0.7.0 迁移说明](migration-0.7.0.md)。

推荐的资源边界：

```yaml
minimumAgyVersion: 1.1.15
maxConcurrent: 4
maxQueue: 32
queueTimeoutMs: 30000
maxOutputBytes: 8388608
maxEventLineLength: 1048576
sessionMode: full
transport: one-shot
persistentIdleTtlMs: 30000
persistentReadyTimeoutMs: 10000
persistentFallback: before-accept
modelDiscovery: auto
modelDiscoveryTtlMs: 300000
modelDiscoveryTimeoutMs: 10000
```

`sessionMode: full` 为默认（每轮完整 history）；`transport: persistent` 仅显式启用才起 worker。

以下是仅在 profile 的 `cordis.patch.yml` 中 `dsh-agy-provider` 段编辑的高级字段，设置面板会隐藏它们：

| 字段 | 默认值 | 作用 |
|---|---:|---|
| `inputFrameLimitBytes` | `262144` | 单次 AGY stdin 输入帧上限；实际发送前会按 UTF-8 字节数检查 |
| `maxSingleToolResultBytes` | `32768` | 单个历史 DSH 工具结果的保留上限 |
| `maxHistoricalToolResultBytes` | `98304` | 所有历史 DSH 工具结果合计保留上限 |
| `toolProtocolRepairRetries` | `1` | DSH 工具协议返回非 JSON 时，追加一次修复指令并重试 |
| `toolProtocolPlainTextFallback` | `final-message` | 修复后仍返回普通文本时，将其安全当作最终消息；`off` 为严格失败 |

工具结果超出上限时只裁剪历史结果，不修改 DSH 原始会话记录；若非工具提示本身仍超过帧上限，会返回 `AGY_INPUT_TOO_LARGE`。

## 设置面板与中英切换

DSH Web 的设置面板由 `Config` schema 的 `title/description` 与 `ctx.llm.registerConfigurableProviders(settingsNs dsh-agy-provider)` + `registerModelDiscovery` 驱动：

- 模型列表为多选勾选框，勾选结果写回 `visibleModels`；未勾选不在选择器出现，但显式请求仍兼容。
- 推理强度为独立下拉（`reasoningEffort: low/medium/high`），`listModels` 仅返回 base 并带 `reasoning.efforts`。
- 每个字段通过 `schemastery .i18n({'zh-CN':{},en:{}})` 提供双语，DSH 按当前 locale 自动切换；英文为 fallback。

## 诊断

在源码目录运行：

```powershell
npm run diagnose
```

诊断只执行 `agy --version`、`agy agents`、`agy models` 和可选 DSH `--dump-config`，不会发送模型 Prompt、消耗 AGY 额度或执行工具。默认输出适合人工查看；使用 `--json` 可获得 `schemaVersion: 1`、组件状态、模型能力、`modelCatalog.source`、`modelCatalog.stale`、`modelCatalog.warning`、`modelCatalog.warningCode` 和稳定错误码。指定 profile 时额外包含 `profileSchemaVersion: 4`、effective Agent/DSH context/bridge/retry/purpose/workspace/visibleModels/image 状态和只读 repair suggestions；静态 doctor 不伪造 live Session。

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
$env:AGY_MINIMUM_VERSION = '1.1.15'
$env:AGY_MODELS = '[{"id":"gemini-3.1-pro"},{"id":"gemini-3.6-flash"}]'
npm run diagnose
```

诊断结果不会返回 `AGY_PATH` 的完整路径，也不会包含 Prompt、凭据或 Token；`quotaUsed` 固定为 `false`。

`modelCatalog.source`：`static`(关闭发现) / `discovered`(无静态且成功) / `merged`(静态+发现合并) / `cache`(失败用缓存) / `fallback`(无缓存用静态)。`warningCode` 稳定标记失败原因。`visibleModels` 为空时 `raw:null/count:null`，非空时报告过滤数量与 `DEPRECATED_*` 警告。

## Windows 长请求与 `AGY_REQUEST`

0.9.0 的 DSH-owned 请求会把工具契约附加到提示词。若仍使用旧实现的 `agy -p <完整 prompt>`，25 个工具就可能让 Windows CreateProcess 命令行超过上限，Node 同步抛出 `ENAMETOOLONG`，旧错误归一化最终只显示 `AGY_REQUEST`。修复后的 one-shot transport 使用 `-p '' --input-format stream-json`，完整 prompt 通过 stdin NDJSON 发送，不再占用 argv。

Windows 上 AGY 是 console-subsystem 可执行文件。为避免新 Session 的 `session-title` one-shot 启动时短暂闪出 `conhost.exe`，Provider 在 Windows 通过随插件发布的 `bin/win32-x64/agy-launcher.exe` GUI-subsystem 启动器启动 AGY；启动器使用 `CreateProcessW + CREATE_NO_WINDOW`、Job Object 和继承的 stdin/stdout/stderr 管道，Prompt 仍只走 stdin，不会进入启动器命令行。macOS/Linux 直接使用 Node `spawn`，并通过 POSIX process group 管理取消和子进程清理。

同版本本地 tgz 不会保证 profile 自动刷新。源码构建后应先移除再安装，并重启 DSH Desktop：

```powershell
npm run build
npm pack
npx @deepseek-ai/dsh plugin --profile web remove dsh-agy-provider
npx @deepseek-ai/dsh plugin --profile web add file:C:/Users/Jie/Projects/dsh-agy-provider/dsh-agy-provider-0.9.0.tgz
```

复测时先打开项目文件夹，再创建新 Session。若仍失败，F12 的 `llm/stream` Preview 应保留具体 code：启动失败为 `AGY_SPAWN_FAILED`，stdin 写入失败为 `AGY_INPUT_FAILED`，输入帧超过上限为 `AGY_INPUT_TOO_LARGE`，工具响应协议错误为 `TOOL_PROTOCOL_*`，工作区不匹配为 `DSH_WORKSPACE_MISMATCH`；不应再无信息地落成 `AGY_REQUEST`。

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

完整 7 层测试（`docs/v0.9.0-release-checklist.md`）：L1 单元(160+) → L2 集成(fake) → L3 自包含Mock → L4 权限矩阵 → L5 设置面板(i18n/可见性/强度) → L6 跨平台 → L7 真实抽样(预算内)。这些命令不会发送模型 Prompt；`diagnose` 只读版本、Agent 和目录，`benchmark` 与测试使用本地数据或 fake runner。完整的 tag、Trusted Publisher 和 registry 复验步骤见 [0.9.0 发布检查清单](v0.9.0-release-checklist.md)。

真实 AGY 请求会消耗已登录账号额度；自动化测试和 benchmark 使用 fake runner/本地数据，不需要 AGY 请求。

## 已知边界

0.9.0 bundle 默认 `toolPolicy: dsh-owned`：AGY 只生成经过本地校验的 DSH tool call，文件、shell、网络和 MCP 由 DSH ToolRuntime 执行。程序化默认仍为 `reject`，非空 `tools` 返回 `UNSUPPORTED_TOOLS`；显式 `toolPolicy: agy-owned` 仅用于 legacy，AGY 独占内部 tools；AGY headless 请求权限时返回 `PERMISSION_REQUIRED`。`workspaceRoot` 在 `dsh-owned` 下已废弃，纯文本无需 workspace。完整约束见 `docs/tool-capability-matrix.md` 与 `docs/dsh-provider-contract.md`。
