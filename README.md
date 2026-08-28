# dsh-agy-provider

[简体中文](README.md) · [English](README.en.md)

把本机已经登录的 **AGY CLI** 暴露为 [DSH](https://github.com/darkings/dsh) 的模型 Provider。

它的核心用途是：让 DSH 继续使用 AGY 账号中的模型和额度，同时保留 DSH 的对话、Session、Web/headless 运行方式。Provider 不直接调用 Google Gemini API，也不保存 OAuth 凭据；认证和模型选择由本机 agy 负责，工具执行由 DSH ToolRuntime 负责。

## 项目状态

**0.10.0 已发布到 npm，`latest=0.10.0`。** 0.10.0 在 0.9.0 的设置面板、工作区无感化和模型/推理强度分离基础上，加入 **optimized full 上下文预算、确定性工具结果淘汰、脱敏诊断和 Windows 无控制台 launcher**；默认仍为 `sessionMode: full`。

**0.7.0 / 0.8.0 已合并**：`v0.7.0 → b94fa32`（`latest=0.7.0` 已发布）、`v0.8.0 → b7c9a45` 已合入主线。0.7.0 起 `dsh-owned` 为 bundle 默认（DSH Session/ToolRuntime/sandbox/approval 接管项目与权限）。

0.10.0 的公开能力重点是：

- 上下文与工具安全：DSH-owned structured prompt 固定 56 KiB fail-closed 上限，超限返回 `AGY_INPUT_TOO_LARGE`；压缩后可恢复，工具结果按整段淘汰，避免历史前缀漂移。
- 性能与观测：稳定前缀、canonical tool schema、step usage 口径和 fingerprint 诊断提升缓存资格与可观测性；不把后端 `cacheRead` 命中率当作保证。

- DSH 设置面板：`Config` 全量 `zh-CN/en` i18n（schemastery `.i18n`），`registerConfigurableProviders(settingsNs dsh-agy-provider)` + `registerModelDiscovery`，模型为多选勾选列表，推理强度为独立下拉。
- 工作区无感：`dsh-owned` 下废弃 `workspaceRoot`（`.deprecated()`，面板隐藏，`resolveAgyAgentRuntime` 强制 `undefined`），工具请求走 DSH Session `header.cwd + workspaceRegistry + sandboxPolicy` 自动校验；纯文本无需 workspace，工具无 workspace 时返回 `DSH_WORKSPACE_MISMATCH` 可操作错误。
- 模型与推理强度分离：`gemini-3.7-flash` 为 base，`reasoningEffort: low|medium|high` 独立选择；`listModels` 仅返回 base 并带 `reasoning.efforts`，旧 `-high/-medium/-low` 后缀自动兼容并 `DEPRECATED_MODEL_EFFORT_SUFFIX` 警告。
- 模型可见性：`visibleModels: string[]` 空=全部，非空仅显示勾选的 base，未勾选显式请求仍兼容。
- 保持 0.7.0 的 DSH-owned 工具桥、Agent presets、doctor v5（`profileSchemaVersion: 4`）、零重试、quota-free 诊断与跨平台门禁；`imageInput: experimental` 已打通受限多模态闭环。

图片输入为受限 experimental bridge：开启后公开 `inputModalities: ['text', 'image']`，通过独立 `dsh-agy-image-view` Agent 读取临时暂存图片。已在 DSH Desktop 完成真实像素回答、同会话追问、失败格式和清理验证；它仍不是无条件的生产级图片能力。

## 工作方式

~~~text
用户 / DSH Web / DSH headless
              │
              ▼
      dsh-agy-provider
      ├─ DSH LlmAdapter
      ├─ Prompt / Stream 映射
      ├─ Session / Conversation 映射
      ├─ Model discovery / retry / telemetry
      └─ Agent 与 workspace 安全边界
              │
              ▼
      agy --output-format stream-json
              │
              ▼
      AGY 账号额度、模型和 Agent 工具
~~~

Provider 使用 spawn(executable, args) 启动 AGY，不经过 shell 拼接命令。AGY 输出按行增量解析，再转换为 DSH 的文本、usage、finish 和稳定错误事件。

## 当前能力矩阵

| 能力 | 当前状态 | 默认值 |
|---|---|---|
| DSH 文本对话 | 已实现 | 开启（profile bundle） |
| AGY 额度/认证 | 已实现 | 由本机 AGY 管理 |
| 动态模型发现 | 已实现 | modelDiscovery: auto |
| reasoning effort | 已实现 | `low/medium/high` 不设隐式值，DSH 独立选择 |
| 模型可见性 | 0.9.0 已实现 | `visibleModels: []` 空=全部，非空仅显示勾选 base |
| DSH 设置面板 | 0.9.0 已实现 | `zh-CN/en` i18n，`visibleModels` 多选 + base/推理强度分离 |
| 工作区无感 | 0.9.0 已实现 | `dsh-owned` 下 `workspaceRoot` 已废弃，走 DSH Session cwd |
| DSH tool-call bridge | 0.7.0 已实现并通过跨平台门禁 | 0.7.0 起 bundle 为 dsh-owned |
| read-only Agent | 已实现 | 显式安装/配置 |
| workspace-write Agent | 已实现 | 0.9.0 `dsh-owned` 下无需手配 `workspaceRoot`，legacy `agy-owned` 仍需显式目录 |
| 图片 staging bridge | 0.9.0 experimental，桌面闭环已验证 | imageInput: experimental（bundle） |
| image modality | 受限公开 | experimental 时 text+image，off 时 text-only |
| persistent stream transport | 0.8.0 已实现 opt-in | 默认 `one-shot`，显式 `transport: persistent` 才复用 worker |

## 安装与使用

### 前置条件

- Node.js >=20。
- 已安装并登录本机 AGY CLI，且 agy 可以在 PATH 中找到。
- 使用 DSH profile 安装插件时，确保 pnpm 在 PATH 中，因为 DSH plugin manager 会转发到 pnpm。

### 安装到 DSH profile

普通 npm install 只安装 Node.js 包，不会把 Provider 写入 DSH profile。DSH Web/headless 应使用原生 plugin manager：

~~~powershell
npx @deepseek-ai/dsh plugin --profile web add dsh-agy-provider@0.10.0
npx @deepseek-ai/dsh plugin --profile headless add dsh-agy-provider@0.10.0
~~~

0.9.0 bundle 默认（`cordis.patch.yml`）相当于：

~~~yaml
enabled: true
provider: agy
model: gemini-3.1-pro
agent: deepseek-proxy
toolPolicy: dsh-owned
sessionMode: full
imageInput: off
~~~

直接使用库的 `Config({})` 仍保持 `enabled: false、toolPolicy: reject`，不会因 import 而修改 profile；`BundleConfig` 为显式 `enabled: true / dsh-owned`。

### Agent preset 配置

只读配置（`dsh-owned` 无需 `workspaceRoot`）：

~~~yaml
agentPreset: read-only
toolPolicy: dsh-owned
# 无需 workspaceRoot，打开文件夹的 DSH Session 即项目
~~~

工作区写入（`dsh-owned` 仍无需手配目录，权限由 DSH 切换）：

~~~yaml
agentPreset: workspace-write
toolPolicy: dsh-owned
# dsh-owned 下 workspaceRoot 已废弃，DSH 的 workspace-write / danger-full-access 决定可写边界
~~~

legacy `agy-owned` 如需显式目录（不推荐）：

~~~yaml
agentPreset: workspace-write
toolPolicy: agy-owned
workspaceRoot: C:\work\my-project
~~~

写入能力由 DSH 权限 preset 与 sandbox 强制执行，Provider 不绕过。

### 配置示例（0.9.0 推荐）

~~~yaml
enabled: true
provider: agy
agent: deepseek-proxy
model: gemini-3.7-flash            # base 名称，推理强度在 DSH 会话中选 low/medium/high
visibleModels:                      # 设置面板勾选要显示的模型，空=全部
  - gemini-3.7-flash
  - gemini-3.1-pro
models:
  - id: gemini-3.7-flash
    name: Gemini 3.7 Flash
  - id: gemini-3.1-pro
    name: Gemini 3.1 Pro
toolPolicy: dsh-owned
transport: one-shot                 # 或 persistent（opt-in，一 Session 一 worker）
sessionMode: full
modelDiscovery: auto
retryPolicy:
  maxRetries: 5
  retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]
imageInput: off
~~~

> 兼容：旧 `model: gemini-3.7-flash-high` 仍可解析为 `base + high` 并 warning，建议改为 base + 会话级 `reasoningEffort`。

重试默认遵循 DSH normal 策略：首次请求失败后最多重试 5 次；`TIMEOUT` 会进入重试，最终总计最多 6 次 AGY 请求。可通过 `retryPolicy` 在 `settings.yaml` 中收窄次数和错误码白名单。

## 诊断与开发

不消耗模型额度的诊断：

~~~powershell
npm run diagnose -- --json
npx dsh-agy-provider doctor --profile web --json
npx dsh-agy-provider agents list
~~~

本地开发：

~~~powershell
npm ci
npm run verify
npm run benchmark
npm run smoke:dsh:self-contained
~~~

需要真实 AGY 的实验不会自动运行。0.9.0 多模态闭环已在用户授权额度下完成；后续仍不应在无明确授权时重复消耗真实模型额度。

## 未来规划

未来版本会继续以“可验证、可回退、额度可控”为前提，重点包括：

### 0.7.0：由 DSH 控制项目、权限与工具（已实现）

- DSH-owned tool bridge 已完成：AGY 只产生经过本地严格校验的 DSH tool call，文件、shell、网络和 MCP 统一由 DSH ToolRuntime 执行。
- V7-M4 权限矩阵、V7-M5 doctor v3/allowlisted telemetry/安全回归、V7-M6 packed artifact/Web/headless/跨平台发布门禁均已完成。
- 直接采用 DSH Session 的项目 `cwd`，以及 `read-only`、`workspace-write`、`danger-full-access` 权限选择，不在插件内复制第二套开关。
- 保持 sandbox、approval、MCP 凭据和实际副作用位于 DSH；Provider 不传 `--dangerously-skip-permissions`。
- 详细范围、安全门禁、额度预算和里程碑见 [0.7.0 开发计划](docs/v0.7.0-development-plan.md)。

### 0.8.0：Persistent transport 与 DSH next 兼容（已实现）

- 以 AGY 1.1.15 正式 `stream-json` 输入协议为基础，一 Session 一 worker 的 persistent transport 已做成稳定 opt-in；默认仍 `one-shot`（`transport: persistent` 显式启用）。
- 同时验证 DSH rc.7 stable 与 rc.8 next 隔离 lane，不以升级 next 为代价破坏现有用户；warm-turn 实测 79% 改善，`145/145` 通过。
- 图片 modality 作为 0.9.0 受限 experimental 能力交付，Desktop 像素回答、追问、失败格式与清理均已验证。
- 详细范围、go/no-go、额度预算和发布门禁见 [0.8.0 开发计划](docs/v0.8.0-development-plan.md)。

### 0.9.0：设置面板 + 工作区无感 + 模型平权（已实现）

- DSH 设置面板：`Config` i18n（`zh-CN/en`）+ `registerConfigurableProviders` + `registerModelDiscovery`，`visibleModels` 多选与 `base + reasoningEffort` 分离。
- 工作区无感：`dsh-owned` 废弃 `workspaceRoot`，项目目录由 DSH Session 自动接管，纯文本无需 workspace。
- 完整 7 层测试（L1 单元 160+ / L2 集成 / L3 自包含 / L4 权限矩阵 / L5 设置面板 / L6 跨平台 / L7 真实抽样）与 `doctor v5`（`profileSchemaVersion 4`）。
- 详细范围与发布门禁见 [0.9.0 开发计划](docs/v0.9.0-development-plan.md) 与 [0.9.0 迁移说明](docs/migration-0.9.0.md)。

### 后续版本：图片与工具体验加固

- 继续加固 DSH Web AttachmentStore → AGY 像素答案路径的性能、更多格式与跨平台证据。
- 继续完善 workspace-write 的冲突处理、备份、回滚和 tool-call 展示体验。
- 不会因为工具目录中存在 write 就绕过 DSH 权限；实际写入始终服从会话 permission preset 和项目边界。

### 后续版本：传输与成本优化

- 0.8.0 的持久 transport 已在真实 AGY 协议、串线、崩溃恢复、进程清理和 token 成本闸门上证明收益（`V8-M4 go`），0.9.0 保持 opt-in。
- 继续完善 purpose-aware 的 compaction/session-title 路由、usage 可观测性与 `transport: persistent` 的默认策略评估。
- 保持公共 CI、doctor、解析器和 Mock smoke 的零额度原则。

## 明确不支持的能力

- 直接调用 Gemini API 或在插件内管理 OAuth/refresh token。
- DSH 与 AGY 的双重工具执行 loop。
- 未验证的 glob、shell、网络、MCP、subagent 或自动权限批准。
- 默认写入用户工作区。
- 无限制生产级 image modality、temperature、stop、maxTokens 和未经验证的 reasoning-delta 输出。
- 未经成本和可靠性验证的生产级 persistent stream transport。

## 项目结构

~~~text
dsh-agy-provider/
├─ src/
│  ├─ provider/       # DSH Adapter、配置、序列化、图片 bridge
│  ├─ agy/            # 子进程、argv、stream-json、模型发现、脱敏（含 persistent-transport）
│  ├─ session/        # DSH Session 与 AGY Conversation 映射
│  ├─ doctor.ts       # profile-aware doctor v5 (profileSchemaVersion 4)
│  ├─ dsh/context.ts  # DSH Session/workspace/sandbox/approval 无感校验
│  └─ agent-*.ts      # preset、安装器和 agents CLI
├─ agents/            # tool-free/read-only/workspace-write 模板
├─ scripts/           # verify、benchmark、diagnose、DSH smoke
├─ tests/             # L1 单元 + L2 集成（visibleModels/归一化/i18n）
├─ docs/
├─ cordis.patch.yml
└─ package.json
~~~

## 文档

- [安装文档](docs/installation.md)（0.9.0 工作区无感与 `visibleModels`）
- [0.9.0 迁移说明](docs/migration-0.9.0.md)（模型 base+effort / 可见性 / 废弃 workspaceRoot）
- [0.9.0 开发计划](docs/v0.9.0-development-plan.md)（设置面板/工作区/模型平权/7层测试）
- [0.9.0 发布检查清单](docs/v0.9.0-release-checklist.md)（L1~L7 门禁）
- [工具能力矩阵](docs/tool-capability-matrix.md)
- [兼容性矩阵](docs/compatibility-matrix.md)
- [DSH Provider 契约](docs/dsh-provider-contract.md)
- [0.8.0 / 0.7.0 开发计划与迁移说明](docs/v0.8.0-development-plan.md)（历史）
- [CHANGELOG](CHANGELOG.md)
- [性能基线](docs/performance-baseline.md)

## License

MIT
