# dsh-agy-provider

把本机已经登录的 **AGY CLI** 暴露为 [DSH](https://github.com/darkings/dsh) 的模型 Provider。

它的核心用途是：让 DSH 继续使用 AGY 账号中的模型和额度，同时保留 DSH 的对话、Session、Web/headless 运行方式。Provider 不直接调用 Google Gemini API，也不保存 OAuth 凭据；真正的认证、模型选择和 Agent 工具执行仍由本机 agy 负责。

## 项目状态

当前主线代码版本为 0.6.0，正在完成公开仓库后的 tag 和 npm Trusted Publishing 收口。源码能力已经完成，registry 发布状态以 npm 和 GitHub Actions 的实际结果为准。

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
- 通过 DSH profile 安装的 bundle 默认使用 toolPolicy: agy-owned，DSH schema 不会重复发送，AGY 负责自己的内部工具。
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
| AGY 自有工具 | 已实现 | profile 为 agy-owned |
| DSH tool-call bridge | 未实现 | 返回 UNSUPPORTED_TOOLS 或由 AGY 接管 |
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
npx @deepseek-ai/dsh plugin --profile web add dsh-agy-provider@0.6.0
npx @deepseek-ai/dsh plugin --profile headless add dsh-agy-provider@0.6.0
~~~

profile bundle 默认相当于：

~~~yaml
enabled: true
provider: agy
agent: deepseek-proxy
toolPolicy: agy-owned
sessionMode: full
imageInput: off
~~~

直接使用库的 Config({}) 则保持 enabled: false、toolPolicy: reject，不会因为 import 包而修改用户 DSH profile。

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
toolPolicy: agy-owned
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

### 0.7.x：能力协商与图片闭环

- 完成 DSH Web AttachmentStore → AGY view_file → 模型像素答案的端到端证据。
- 只有在真实工具事件、临时文件清理、权限边界和 Web UI 都通过后，才考虑公开 image modality。
- 将模型的文本、图片、工具能力改为可审计的 capability negotiation，而不是静态猜测。

### 后续版本：工具与写入能力加固

- 继续完善 workspace-write 的路径边界、冲突处理、备份和回滚体验。
- 若 DSH 提供稳定且与 AGY 权限模型兼容的工具契约，再评估 DSH tool-call bridge；默认仍保持 AGY 单一工具所有者，避免双重执行。
- 不会因为“有 read”就默认打开 write；写入始终需要显式 preset 和 workspaceRoot。

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
- [0.6.0 开发计划](docs/v0.6.0-development-plan.md)
- [DSH Provider 契约](docs/dsh-provider-contract.md)
- [性能基线](docs/performance-baseline.md)

## License

MIT
