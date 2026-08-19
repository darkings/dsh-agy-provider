# dsh-agy-provider

[简体中文](README.md) · [English](README.en.md)

把本机已经登录的 **AGY CLI** 暴露为 [DSH](https://github.com/darkings/dsh) 的模型 Provider。

它的核心用途是：让 DSH 继续使用 AGY 账号中的模型和额度，同时保留 DSH 的对话、Session、Web/headless 运行方式。Provider 不直接调用 Google Gemini API，也不保存 OAuth 凭据；认证和模型选择由本机 agy 负责，0.6.x legacy 工具由 AGY 执行，0.7.0 DSH-owned bridge 的实际工具执行由 DSH ToolRuntime 负责。

## 项目状态

0.6.1 已公开发布，是 0.6.0 的兼容性修复版，修复 DSH profile 缺少 `AttachmentStore` 时的插件启动错误；0.6.0 的能力与配置保持不变。`v0.6.1`、GitHub Actions CI 和 npm Trusted Publishing 均已通过。

当前仓库正在开发 0.7.0：npm `latest` 仍是 0.6.1，0.7.0 尚未发布。源码中的 DSH-owned bridge 已通过 prompt-contract、DSH ToolRuntime round-trip 和 quota-free 本地门禁，但仍需完成权限矩阵、跨平台回归和发布门禁。

0.6.0 的公开能力重点是：

- 稳定的 AGY 子进程与 stream-json 文本流适配。
- DSH Session 与 AGY Conversation 的安全映射。
- agy models 动态模型发现、缓存和静态 fallback。
- low/medium/high reasoning effort 显式映射。
- AGY-owned 工具策略、Agent capability presets 和 doctor v2。
- 默认零自动重试、quota-free 诊断和跨平台测试门禁。

图片输入已经有受限的 experimental bridge，但公开模型目录仍然只声明 inputModalities: ['text']。在 DSH Web 的 AttachmentStore、AGY view_file 和真实像素答案闭环被验证前，项目不会把它宣传为正式识图能力。

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

## 0.6.0 已实现

### 1. 文本 Provider 与进程边界

- 将 DSH system prompt/messages 确定性序列化为 AGY Prompt。
- 将 step_update.text_delta 和 result.response 映射为 DSH 文本流。
- 支持超时、取消、退出码、解析错误、输出上限和进程树清理。
- 日志只保留 request/session/usage/事件计数等白名单字段，不记录 Prompt、stderr 原文、凭据或完整本机路径。

### 2. Session、模型和 reasoning effort

- 默认 sessionMode: full：每轮发送完整 DSH 历史，行为最容易审计。
- 可选 sessionMode: resume：使用 AGY conversation_id 发送增量消息；恢复失败会降级为完整历史。
- 同一 DSH Session 串行，不同 Session 可以并发。
- 默认通过 agy models 做 quota-free 动态发现，支持 TTL、single-flight、缓存和静态 fallback。
- 请求级 reasoningEffort 支持 low、medium、high，以独立 --effort 参数传给 AGY；未指定时不设置隐式值。

### 3. 工具所有权与权限边界

项目明确只允许一个工具执行者：

- 程序化 Provider 默认 toolPolicy: reject，收到 DSH tool schema 时返回 UNSUPPORTED_TOOLS。
- 已发布的 0.6.1 DSH bundle 默认使用 toolPolicy: agy-owned；0.7.0 开发分支已切换为 toolPolicy: dsh-owned，DSH schema 经过 bounded contract 交给 AGY 生成调用，实际执行仍由 DSH ToolRuntime 完成。
- 发生权限请求时返回 PERMISSION_REQUIRED 并终止请求，不自动批准，不使用 --dangerously-skip-permissions。

### 4. Agent capability presets 与读写能力

随包提供三档 Agent 模板：

| preset | 已允许能力 | 默认行为 |
|---|---|---|
| tool-free | 纯文本推理 | 不访问工作区 |
| read-only | find_by_name、grep_search、view_file、list_dir | 只读工作区 |
| workspace-write | 上述只读工具 + multi_replace_file_content、replace_file_content、write_to_file | 仅显式工作区内写入 |

workspace-write 已经实现，但必须同时配置一个存在且非文件系统根目录的 workspaceRoot。它不包含 shell、网络、浏览器、MCP、subagent 或权限跳过。

项目不会把未验证的 glob 工具名写进公开契约。需要文件搜索时使用 AGY 已验证的 find_by_name、grep_search 和 list_dir。

模板安装默认只预览，不写入文件：

~~~powershell
npx dsh-agy-provider agents list
npx dsh-agy-provider agents install read-only --dir "$HOME/.gemini/config/agents"
npx dsh-agy-provider agents install read-only --dir "$HOME/.gemini/config/agents" --apply
~~~

已有模板默认拒绝覆盖；需要保留旧文件时显式增加 --backup。

### 5. Doctor v2 与安全诊断

发布包提供 profile-aware doctor：

~~~powershell
npx dsh-agy-provider doctor --profile web --json
~~~

doctor v2 输出 profileSchemaVersion: 2，审计实际读取到的 provider、model、Agent、Session、retry、purpose route、workspace、image 和 model capability。它能区分 dump timeout、非零退出和解析失败，并输出只读的 repairSuggestions。

doctor 只执行 agy --version、agy agents、agy models 和 DSH config dump，不发送模型 Prompt，不执行工具，quotaUsed 固定为 false。

### 6. 图片输入实验边界

imageInput: experimental 已支持：

- 通过可选 DSH AttachmentStore 读取图片。
- 对 PNG/JPEG/WebP/GIF 做 MIME、字节数和数量限制。
- 每个请求使用随机临时 staging 目录，并在成功、失败和取消时清理。
- 只允许内置 read-only/workspace-write Agent 进入 bridge；不满足 view_file 能力时返回 IMAGE_AGENT_UNSUPPORTED。

这只是协议实验，不是公开图片模型能力。当前 listModels() 仍只返回文本输入能力，deepseek-proxy 和未知 custom Agent 不会被错误宣传为识图 Agent。

### 7. 质量门禁

- npm run verify：typecheck、110 个测试和 pack dry-run。
- npm run benchmark：Parser、serializer、limiter 的无额度基线。
- npm run smoke:dsh:self-contained：隔离 DSH Web/headless plugin-add、doctor 和 Mock response。
- GitHub Actions：Node.js 20/22/24 × Windows/Ubuntu/macOS，并包含 DSH self-contained smoke。
- 公共 CI、doctor、benchmark 和 Mock smoke 均不调用真实 AGY 模型。

## 当前能力矩阵

| 能力 | 当前状态 | 默认值 |
|---|---|---|
| DSH 文本对话 | 已实现 | 开启（profile bundle） |
| AGY 额度/认证 | 已实现 | 由本机 AGY 管理 |
| 动态模型发现 | 已实现 | modelDiscovery: auto |
| reasoning effort | 已实现 | 不设置隐式 effort |
| AGY 自有工具 | 已实现（0.6.1 legacy） | 0.6.1 profile 为 agy-owned |
| DSH tool-call bridge | 0.7.0 开发中已完成基础闭环，尚未发布 | 源码 bundle 为 dsh-owned |
| read-only Agent | 已实现 | 显式安装/配置 |
| workspace-write Agent | 已实现 | 必须显式 workspaceRoot |
| 图片 staging bridge | experimental | imageInput: off |
| 公开 image modality | 未实现 | 仍为 text-only |
| persistent stream transport | fixture prototype | 正式路径仍为 one-shot |

## 安装与使用

### 前置条件

- Node.js >=20。
- 已安装并登录本机 AGY CLI，且 agy 可以在 PATH 中找到。
- 使用 DSH profile 安装插件时，确保 pnpm 在 PATH 中，因为 DSH plugin manager 会转发到 pnpm。

### 安装到 DSH profile

普通 npm install 只安装 Node.js 包，不会把 Provider 写入 DSH profile。DSH Web/headless 应使用原生 plugin manager：

~~~powershell
npx @deepseek-ai/dsh plugin --profile web add dsh-agy-provider@0.6.1
npx @deepseek-ai/dsh plugin --profile headless add dsh-agy-provider@0.6.1
~~~

0.6.1 已发布包的 profile bundle 默认相当于：

~~~yaml
enabled: true
provider: agy
agent: deepseek-proxy
toolPolicy: agy-owned
sessionMode: full
imageInput: off
~~~

直接使用库的 Config({}) 则保持 enabled: false、toolPolicy: reject，不会因为 import 包而修改用户 DSH profile。

0.7.0 未发布源码的 bundle 默认改为 `toolPolicy: dsh-owned`；它不要求重复配置 `workspaceRoot`，项目目录、read/write、shell、网络、MCP 和 approval 均由 DSH 当前 Session 与 ToolRuntime 控制。

### Agent preset 配置

只读配置：

~~~yaml
agentPreset: read-only
~~~

工作区写入配置：

~~~yaml
agentPreset: workspace-write
workspaceRoot: C:\work\my-project
~~~

写入能力只在显式 preset、显式工作区和 Agent 白名单同时满足时生效。

### 配置示例

~~~yaml
enabled: true
provider: agy
agent: deepseek-proxy
model: gemini-3.7-flash-high
models:
  - id: gemini-3.7-flash-high
    name: Gemini 3.7 Flash High
toolPolicy: dsh-owned
sessionMode: full
modelDiscovery: auto
retryPolicy:
  maxRetries: 0
  retryableCodes: [RATE_LIMIT, SERVER, TRANSPORT]
imageInput: off
~~~

重试默认关闭，避免一次 DSH 请求被放大为多次 AGY 额度调用；显式 opt-in 也有最大次数和错误码白名单限制。

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

需要真实 AGY 的实验不会自动运行。图片实验受独立额度闸门控制，且当前 0.6.0 识图证据不足，不应在没有明确授权时重复执行。

## 未来规划

未来版本会继续以“可验证、可回退、额度可控”为前提，重点包括：

### 0.7.0：由 DSH 控制项目、权限与工具（开发中，尚未发布）

- DSH-owned tool bridge 基础闭环已完成：AGY 只产生经过本地严格校验的 DSH tool call，文件、shell、网络和 MCP 统一由 DSH ToolRuntime 执行。
- 直接采用 DSH Session 的项目 `cwd`，以及 `read-only`、`workspace-write`、`danger-full-access` 权限选择，不在插件内复制第二套开关。
- 保持 sandbox、approval、MCP 凭据和实际副作用位于 DSH；Provider 不传 `--dangerously-skip-permissions`。
- 详细范围、安全门禁、额度预算和里程碑见 [0.7.0 开发计划](docs/v0.7.0-development-plan.md)。

### 后续版本：图片与工具体验加固

- 完成 DSH Web AttachmentStore → AGY 模型像素答案的端到端证据后，再考虑公开 image modality。
- 继续完善 workspace-write 的冲突处理、备份、回滚和 tool-call 展示体验。
- 不会因为工具目录中存在 write 就绕过 DSH 权限；实际写入始终服从会话 permission preset 和项目边界。

### 后续版本：传输与成本优化

- 只有持久 transport 在真实 AGY 协议、串线、崩溃恢复、进程清理和 token 成本闸门上证明收益后，才考虑进入正式配置。
- 继续完善 purpose-aware 的 compaction/session-title 路由和 usage 可观测性。
- 保持公共 CI、doctor、解析器和 Mock smoke 的零额度原则。

## 明确不支持的能力

- 直接调用 Gemini API 或在插件内管理 OAuth/refresh token。
- DSH 与 AGY 的双重工具执行 loop。
- 未验证的 glob、shell、网络、MCP、subagent 或自动权限批准。
- 默认写入用户工作区。
- 公开 image modality、temperature、stop、maxTokens 和未经验证的 reasoning-delta 输出。
- 未经成本和可靠性验证的生产级 persistent stream transport。

## 项目结构

~~~text
dsh-agy-provider/
├─ src/
│  ├─ provider/       # DSH Adapter、配置、序列化、图片 bridge
│  ├─ agy/            # 子进程、argv、stream-json、模型发现、脱敏
│  ├─ session/        # DSH Session 与 AGY Conversation 映射
│  ├─ doctor.ts       # profile-aware doctor v2
│  └─ agent-*.ts      # preset、安装器和 agents CLI
├─ agents/            # tool-free/read-only/workspace-write 模板
├─ scripts/           # verify、benchmark、diagnose、DSH smoke
├─ tests/
├─ docs/
├─ cordis.patch.yml
└─ package.json
~~~

## 文档

- [安装文档](docs/installation.md)
- [0.6.0 迁移说明](docs/migration-0.6.0.md)
- [工具能力矩阵](docs/tool-capability-matrix.md)
- [兼容性矩阵](docs/compatibility-matrix.md)
- [发布检查清单](docs/release-checklist.md)
- [CHANGELOG](CHANGELOG.md)
- [0.7.0 开发计划](docs/v0.7.0-development-plan.md)
- [0.6.0 开发计划](docs/v0.6.0-development-plan.md)
- [DSH Provider 契约](docs/dsh-provider-contract.md)
- [性能基线](docs/performance-baseline.md)

## License

MIT
