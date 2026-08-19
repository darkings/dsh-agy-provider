# dsh-agy-provider

将本机已登录的 AGY CLI 暴露为 DSH 的模型 Provider，使 DSH 可以通过 AGY 使用其账号额度和可用模型。

## 当前状态

`0.5.0` 当前为 release candidate 工作树：V5-M1–M5 的源码、doctor CLI、原生 DSH profile smoke 和无额度验证已完成，npm registry 暂仍为 `latest=0.4.0`，待发布授权后再 bump/tag/publish。0.3.0 未单独占用 registry 版本，其已完成能力随 0.4.0 一并发布。

- `deepseek-proxy` Agent 可被 AGY 识别。
- `agy.exe --output-format stream-json` 可输出逐行 JSON 事件。
- Node.js `child_process.spawn()` 可直接启动 `agy.exe` 并增量解析输出。
- 最小请求可得到 `init`、`step_update` 和 `result` 事件，进程退出码为 `0`。
- 官方 `@deepseek-ai/dsh-llm` runtime 可注册并驱动 `AgyAdapter` 文本流。
- 当前自动化测试 90 个全部通过；bundle dry-run 可见 `cordis.patch.yml`、`lib` 和 doctor CLI 产物。
- V2-M5 quota 复测后继续默认 `sessionMode: full`：`full` 第二轮为 4,529 input tokens，`resume` 为 9,224，未启用持久化 Session。

0.4.0 已完成 V4-M1/V4-M4；真实 AGY 协议采样和自包含 DSH Mock smoke 已验证。V4-M2/V4-M3 因未证明同一 AGY 进程的多轮 stdin 留存，以有证据的 negative result 关闭，正式路径继续使用 one-shot，不暴露 persistent transport 配置。详见 [0.4.0 开发计划](docs/v0.4.0-development-plan.md)。

当前 M4 文本 MVP 支持：

- `agyPath`、`agent`、`model`/`models`、`timeoutMs` 配置；模型目录按 `id` 去重，并保留旧版 `model` 作为 fallback。默认开启 quota-free 动态发现，显式目录的顺序与 metadata 优先。
- DSH 文本消息确定性序列化为 AGY Prompt。
- `step_update.text_delta` 实时映射为 `text-delta`。
- `result.response`、`result.usage`、退出码、超时和取消映射。

当前 M5 会话策略支持：

- DSH `sessionId` 到 AGY `conversation_id` 的进程内映射。
- `sessionMode: full`（默认）：每轮发送 DSH 完整历史，重启后自然创建新 AGY 会话。
- `sessionMode: resume`：后续请求使用显式 `--conversation <id>`，只发送上次 assistant 之后的新消息。
- 同一 Session 串行，不同 Session 并发。
- AGY conversation ID 失效时自动改用完整 DSH 历史重试。

当前 M6 工具边界：

- 默认 `toolPolicy: reject`，DSH 传入非空 `tools` 时仍立即返回 `UNSUPPORTED_TOOLS`，保持 0.2.0 行为。
- 显式设置 `toolPolicy: agy-owned` 时忽略 DSH tool schemas，只把文本上下文交给 AGY；schema 不会按 DSH 工具协议发送给模型。
- AGY 内部工具由 AGY 独占执行，不转换为 DSH tool calls。
- 两种策略检测到权限请求时都立即终止并返回 `PERMISSION_REQUIRED`，不会自动批准或加入 `--dangerously-skip-permissions`。

当前 0.5.0 profile onboarding：

- DSH Web/headless 必须通过 `dsh plugin --profile <profile> add dsh-agy-provider@0.5.0` 安装；普通 `npm install` 只用于 Node.js 代码导入，不会修改 DSH profile。
- DSH `plugin add` 会转发给 pnpm；使用 profile 安装前需确保 `pnpm` 已在 PATH 中。
- profile bundle patch 默认使用 `enabled: true` 与 `toolPolicy: agy-owned`，因此 DSH Web 的默认 tool schemas 不会触发 `UNSUPPORTED_TOOLS`；AGY 仍是唯一工具执行者。
- 直接库调用的 `Config({})` 仍为 `enabled: false`、`toolPolicy: reject`；需要严格模式时，可在 profile patch 中显式覆盖 bundle 配置。
- 安装后可运行 `npx dsh-agy-provider doctor --profile web --json`；doctor 只执行 AGY 版本、Agent、模型目录和 DSH config dump 检查，不发送 Prompt，`quotaUsed` 固定为 `false`。

当前 M7 配置、安全和可观测性：

- 配置默认 `maxConcurrent: 4`、`maxQueue: 32`、`queueTimeoutMs: 30000`，超出后分别返回 `QUEUE_FULL` 或 `QUEUE_TIMEOUT`。
- `npm run diagnose` 只执行 `agy --version`、`agy agents` 和 `agy models`，检查路径、最低版本、配置 Agent 和模型目录，不消耗模型额度，也不执行工具。
- AGY 请求日志通过 Cordis `ctx.logger` 输出结构化 JSON 元数据，包含 request ID、conversation ID、耗时、退出码、事件计数、`toolPolicy` 和 DSH schema 数量。
- V2-M3 日志增加固定事件类别计数和最终 AGY status；V3-M3 只记录工具策略与 schema 数量，不输出工具参数或原始事件 payload。
- 日志采用白名单字段并再次脱敏，不包含 Prompt、stderr 原文、环境变量、可执行文件路径或凭据。

当前 V2-M3 事件与错误兼容：

- 已覆盖 `init`、`step_update`、`checkpoint`、`agent_response`、`result`、工具、权限、错误和未知事件 fixture；未知事件保留并归类为 `unknown`。
- 认证、额度、速率限制、未知模型、Agent 缺失、上下文超限、权限、超时、取消、解析和输出上限映射为稳定 `LlmError.code`。
- 未发现稳定的 AGY 输出 reasoning envelope，因此不把思考文本猜测性映射为 `reasoning-delta`；V3-M2 仅映射 reasoning 控制参数，不改变输出事件边界。

当前 M8 测试、兼容性和性能：

- Parser 和 Process Adapter 有单条事件/总输出上限，恶意超长输出返回 `LINE_TOO_LONG` 或 `AGY_OUTPUT_LIMIT`。
- 已覆盖 shell metacharacters 参数注入回归、配置边界、版本兼容、两种工具策略下的权限/工具事件和限流行为。
- `npm run benchmark` 提供不调用 AGY 的 Parser、serializer 和 limiter 基线，结果记录在 [性能基线](docs/performance-baseline.md)。
- AGY/DSH 的已验证组合记录在 [兼容性矩阵](docs/compatibility-matrix.md)。
- V2-M4 CI 已覆盖 Windows、Ubuntu、macOS 与 Node.js 20/22/24；timeout/abort 使用父子 Node 进程 fixture 验证整棵进程树退出。

当前 V3-M2 reasoning effort 支持：

- `resolveModel()` 为 AGY 模型公开 `low`、`medium`、`high` 三档 reasoning metadata，不设置 `defaultEffort`。
- 请求级 `reasoningEffort` 经过白名单校验后，以独立 `--effort <value>` argv 传给 AGY。
- 未指定 effort 时不传入 `--effort`；非法值在启动 AGY 前返回 `UNSUPPORTED_REASONING_EFFORT`。

当前 V3-M3 AGY-owned 工具策略：

- `toolPolicy` 默认值为 `reject`；不配置时与 0.2.0 完全一致。
- `toolPolicy: agy-owned` 只改变 DSH schema 的入口策略，不建立 DSH ↔ AGY 双向工具桥；AGY 仍是唯一工具执行者。
- 日志只保留 `toolPolicy` 和 `toolSchemaCount`，不会记录 schema 参数、Prompt、stderr 或凭据。

当前 V3-M4 持久 stream transport 实验：

- 已在隔离 fixture 中验证 worker-per-session、NDJSON framing、request/session correlation、最大 worker、idle TTL、crash recovery、abort/timeout/output-limit 和进程树回收。
- prototype 不接入 `AgyAdapter`、`Config` 或默认 `sessionMode`；正式路径仍是 one-shot。
- fixture gate 不消耗 AGY 额度；真实 3+3 对照和 AGY `--input-format stream-json` 协议验证尚未执行。

当前 V3-M5 诊断与安全加固：

- `modelCatalog.source` 区分 `static`、`discovered`、`merged`、`cache` 和 `fallback`，发现失败提供稳定 `warningCode`，`quotaUsed` 始终为 `false`。
- reasoning effort、tool policy 和 model discovery 的日志字段只允许白名单枚举；日志 sanitizer 不会转发运行时附加字段。
- 完整用户路径、spawn 失败 executable path、Prompt、stderr 和凭据不会进入诊断或结构化日志。

当前 0.5.0 发布状态：

- 当前源码 package version 为 `0.5.0`；npm registry 的 `latest` 仍为 `0.4.0`，因此 registry 安装请继续使用已发布版本，或等待 0.5.0 发布。
- `.github/workflows/publish.yml` 要求 `v*.*.*` tag 与 `package.json` 版本完全匹配，并使用 npm Trusted Publishing，不在仓库保存长期 token。
- 0.5.0 已完成本地版本 bump、`npm run verify`、pack/原生 plugin-add smoke 预检；尚未执行 npm publish。

当前明确不支持：

- DSH tool-call bridge、图像内容、采样参数、`temperature`、`stop` 和 `maxTokens`；显式 `toolPolicy: agy-owned` 仅允许忽略 DSH schemas，不产生 DSH tool chunks。
- 会跨插件进程重启持久化的 AGY Conversation 映射；重启后会使用完整 DSH 历史降级创建新会话。
- `--continue` 自动选择的最近会话；为避免多个 DSH Session 串话，Provider 不使用它。
- 生产级持久 stream transport；当前仅有隔离实验 prototype，未形成 public 配置或兼容性承诺。

## 目标架构

```text
DSH
  ↓
dsh-agy-provider
  ├─ DSH Provider Adapter
  ├─ AGY Process Adapter
  ├─ stream-json Parser
  └─ Session Mapping
  ↓
agy.exe --agent deepseek-proxy
  ↓
AGY 账号额度与模型
```

最终运行链路保留 AGY，不直接调用 Gemini API。Python/OpenAI Proxy 仅可作为调试参考，不属于目标架构。

## 项目结构

```text
dsh-agy-provider/
├─ docs/
│  ├─ development-plan.md
│  ├─ compatibility-matrix.md
│  ├─ performance-baseline.md
│  ├─ verified-baseline.md
│  └─ migration-0.5.0.md
├─ src/
│  ├─ agy/          # 子进程、参数、事件解析、模型发现、诊断、限流和脱敏
│  │  ├─ experimental-transport.ts # V3-M4 隔离持久 worker prototype
│  │  └─ redact.ts / log.ts / models.ts # V3-M5 脱敏、日志和目录诊断边界
│  ├─ diagnostics.ts # Provider/DSH/Node.js/AGY 聚合诊断
│  ├─ doctor.ts      # 发布包可直接运行的 profile-aware doctor
│  ├─ provider/     # DSH Provider、文本序列化和 AGY 映射
│  ├─ session/      # DSH Session 与 AGY Conversation 映射
│  └─ index.ts
├─ scripts/
│  ├─ benchmark.mjs  # 不调用 AGY 的本地性能基线
│  ├─ diagnose.mjs    # 只读 AGY 版本/Agent 诊断
│  ├─ dsh-smoke.mjs   # 已安装 profile 的 DSH bundle/Mock runtime smoke test
│  ├─ dsh-smoke-self-contained.mjs # 原生 plugin add 的 Web/headless smoke
│  └─ quota-experiment.mjs # 人工触发的 full/resume quota 对照
├─ tests/
├─ task_plan.md
├─ findings.md
└─ progress.md
```

## 开发原则

- 在确认 DSH 的真实 Provider API 前，不提交猜测性的框架调用代码。
- 通过 `spawn(executable, args)` 启动 AGY，不经过 shell 拼接命令。
- 将 AGY 输出视为外部数据，逐行解析并验证事件结构。
- 第一版先完成文本流、取消、超时和错误映射，再扩展工具调用与持久化会话恢复。
- 不记录凭据、Token、完整用户 Prompt 或敏感环境变量。

## 配置与诊断

Provider 默认配置保持 `sessionMode: full`，并发和诊断相关配置示例：

```yaml
enabled: true
provider: agy
agent: deepseek-proxy
model: gemini-3.1-pro-high
toolPolicy: reject       # reject | agy-owned
models:
  - id: gemini-3.1-pro-high
    name: Gemini 3.1 Pro High
    description: High quality Gemini model through AGY
    contextWindow: 1000000
  - id: gemini-3.6-flash
    name: Gemini 3.6 Flash
minimumAgyVersion: 1.1.13
maxConcurrent: 4
maxQueue: 32
queueTimeoutMs: 30000
maxOutputBytes: 8388608
maxEventLineLength: 1048576
modelDiscovery: auto
modelDiscoveryTtlMs: 300000
modelDiscoveryTimeoutMs: 10000
```

`model` 仍表示默认请求模型，并兼容 0.1.0 配置。`models` 是可选的显式目录；目录按 `id` 去重，若默认 `model` 未列出会自动补入。未配置但由请求方明确传入的模型 ID 会原样保留，不会被静默改写成默认模型。

`modelDiscovery: auto` 是默认值。Provider 会以无 Shell 的方式执行 `agy models`，将动态目录中未配置的模型补到显式目录之后；显式 `models` 的顺序、名称和其他 metadata 优先。发现结果只保存在进程内，默认 TTL 为 5 分钟，单次命令默认超时为 10 秒。设置 `modelDiscovery: off` 可完全恢复 0.2.0 的静态目录行为。

`reasoningEffort` 是请求级能力，不是 Provider 配置项。可选值为 `low`、`medium`、`high`；未指定时保持 AGY/模型自身默认值，`temperature`、`stop` 和 `maxTokens` 仍会被拒绝。

`toolPolicy` 是 Provider 配置项，程序化默认值为 `reject`。通过 0.5.0 bundle 安装到 DSH profile 后，`cordis.patch.yml` 显式使用 `agy-owned`，因为该场景已确定由 AGY Agent 独占工具执行；DSH `tools` 仅作为上游 schema 元数据被忽略，文本上下文仍按原路径交给 AGY，AGY 内部工具事件不会转换为 DSH tool chunks。

在项目目录执行：

```powershell
npm run diagnose
```

默认输出保留人类可读格式；增加 `--json` 可得到带 `schemaVersion`、`quotaUsed`、组件状态、模型能力和稳定 `errors[].code` 的机器可读结果：

```powershell
npm run diagnose -- --json
```

诊断只执行 `agy --version`、`agy agents` 和 `agy models`，不会发送模型 Prompt、消耗 AGY 额度或执行工具。JSON 输出中的 `modelCatalog.source` 会标记 `static`、`discovered`、`merged`、`cache` 或 `fallback`，`stale`、`warning` 和 `warningCode` 用于说明是否使用了过期缓存、静态回退或发现失败原因。也可以通过 `AGY_PATH`、`AGY_AGENT`、`AGY_MODEL`、`AGY_MODELS` 和 `AGY_MINIMUM_VERSION` 覆盖检查目标；`AGY_MODELS` 必须是 JSON 数组，例如：

```powershell
$env:AGY_AGENT = 'deepseek-proxy'
$env:AGY_MODELS = '[{"id":"gemini-3.1-pro-high","name":"Gemini 3.1 Pro High"},{"id":"gemini-3.6-flash"}]'
npm run diagnose -- --json
```

诊断输出只返回可执行文件来源标签（`explicit`/`environment`/`path`），不返回本机完整路径，也不包含 Prompt、凭据或 Token。

### DSH 安装 smoke test

V2-M1 的 DSH 验证需要一个已安装目标 profile 的隔离 `DSH_HOME`。在 PowerShell 中设置该目录和 DSH CLI 入口后执行：

```powershell
$env:DSH_HOME = '<isolated-dsh-home>'
$env:DSH_BIN = '<dsh-project>\node_modules\.bin\dsh.cmd'
npm run smoke:dsh
```

该命令只使用 `agy-mock`，成功结果会标记 `quotaUsed: false`，不会调用真实 AGY 或输出 token、Prompt 和用户路径。

不依赖已有 `DSH_HOME`/`DSH_BIN` 时，可运行自包含版本。它会在临时目录安装固定的 `@deepseek-ai/dsh@0.1.0-rc.7`、打包并安装当前 Provider、创建隔离 `headless` profile，验证 bundle/config/Mock 响应后自动清理：

```powershell
npm run smoke:dsh:self-contained
```

输出包含 DSH/Provider 版本、模型、`toolPolicy`、bundle inventory 和 `quotaUsed: false`；该流程不登录、不调用 AGY、不使用模型额度。

安装、升级和发布检查见 [安装文档](docs/installation.md)、[0.2.0 迁移说明](docs/migration-0.2.0.md)、[0.3.0 迁移说明](docs/migration-0.3.0.md)、[0.5.0 迁移说明](docs/migration-0.5.0.md)、[Changelog](CHANGELOG.md) 和 [发布检查清单](docs/release-checklist.md)。在 DSH 中使用时，必须把包安装到目标 profile：`npx @deepseek-ai/dsh plugin --profile web add dsh-agy-provider@0.5.0`；仅在普通项目目录执行 `npm install` 不会自动修改 DSH profile。

详细里程碑、验收标准和风险见 [0.1.0 开发计划](docs/development-plan.md)、[0.2.0 开发计划](docs/v0.2.0-development-plan.md)、[0.3.0 开发计划](docs/v0.3.0-development-plan.md)、[0.4.0 开发计划](docs/v0.4.0-development-plan.md) 和 [0.5.0 开发计划](docs/v0.5.0-development-plan.md)。已验证事实见 [基线记录](docs/verified-baseline.md)。Provider 契约见 [DSH Provider 契约](docs/dsh-provider-contract.md)。兼容性与性能见 [兼容性矩阵](docs/compatibility-matrix.md) 和 [性能基线](docs/performance-baseline.md)。
