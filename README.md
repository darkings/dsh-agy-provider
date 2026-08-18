# dsh-agy-provider

将本机已登录的 AGY CLI 暴露为 DSH 的模型 Provider，使 DSH 可以通过 AGY 使用其账号额度和可用模型。

## 当前状态

项目已完成 M1–M8 的最小闭环，M0 基线为 Windows 11、AGY `1.1.13`；M7/M8 复测时本机 AGY 已升级为 `1.1.14`：

- `deepseek-proxy` Agent 可被 AGY 识别。
- `agy.exe --output-format stream-json` 可输出逐行 JSON 事件。
- Node.js `child_process.spawn()` 可直接启动 `agy.exe` 并增量解析输出。
- 最小请求可得到 `init`、`step_update` 和 `result` 事件，进程退出码为 `0`。
- 官方 `@deepseek-ai/dsh-llm` runtime 可注册并驱动 `AgyAdapter` 文本流。
- 当前自动化测试 42 个全部通过；bundle dry-run 可见 `cordis.patch.yml` 和 `lib` 产物。

当前 M4 文本 MVP 支持：

- `agyPath`、`agent`、`model`、`timeoutMs` 配置。
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

- V1 采用“AGY 自治 Agent + DSH 文本外壳”。
- DSH 传入非空 `tools` 时立即返回 `UNSUPPORTED_TOOLS`。
- AGY 内部工具由 AGY 独占执行，不转换为 DSH tool calls。
- 检测到权限请求时立即终止并返回 `PERMISSION_REQUIRED`，避免 headless 无限等待。

当前 M7 配置、安全和可观测性：

- 配置默认 `maxConcurrent: 4`、`maxQueue: 32`、`queueTimeoutMs: 30000`，超出后分别返回 `QUEUE_FULL` 或 `QUEUE_TIMEOUT`。
- `npm run diagnose` 只执行 `agy --version` 和 `agy agents`，检查路径、最低版本和配置 Agent，不消耗模型额度，也不执行工具。
- AGY 请求日志通过 Cordis `ctx.logger` 输出结构化 JSON 元数据，包含 request ID、conversation ID、耗时、退出码和事件计数。
- 日志采用白名单字段并再次脱敏，不包含 Prompt、stderr 原文、环境变量、可执行文件路径或凭据。

当前 M8 测试、兼容性和性能：

- Parser 和 Process Adapter 有单条事件/总输出上限，恶意超长输出返回 `LINE_TOO_LONG` 或 `AGY_OUTPUT_LIMIT`。
- 已覆盖 shell metacharacters 参数注入回归、配置边界、版本兼容、权限/工具事件和限流行为。
- `npm run benchmark` 提供不调用 AGY 的 Parser、serializer 和 limiter 基线，结果记录在 [性能基线](docs/performance-baseline.md)。
- AGY/DSH 的已验证组合记录在 [兼容性矩阵](docs/compatibility-matrix.md)。

当前明确不支持：

- DSH `tools`、图像内容、采样参数、`reasoningEffort`、`stop` 和 `maxTokens`。
- 会跨插件进程重启持久化的 AGY Conversation 映射；重启后会使用完整 DSH 历史降级创建新会话。
- `--continue` 自动选择的最近会话；为避免多个 DSH Session 串话，Provider 不使用它。

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
│  └─ verified-baseline.md
├─ src/
│  ├─ agy/          # 子进程、参数、事件解析、诊断、限流和脱敏
│  ├─ provider/     # DSH Provider、文本序列化和 AGY 映射
│  ├─ session/      # DSH Session 与 AGY Conversation 映射
│  └─ index.ts
├─ scripts/
│  ├─ benchmark.mjs  # 不调用 AGY 的本地性能基线
│  └─ diagnose.mjs    # 只读 AGY 版本/Agent 诊断
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
minimumAgyVersion: 1.1.13
maxConcurrent: 4
maxQueue: 32
queueTimeoutMs: 30000
maxOutputBytes: 8388608
maxEventLineLength: 1048576
```

在项目目录执行：

```powershell
npm run diagnose
```

也可以通过 `AGY_PATH`、`AGY_AGENT` 和 `AGY_MINIMUM_VERSION` 覆盖诊断命令的检查目标。

安装、升级和发布前检查见 [安装文档](docs/installation.md)、[Changelog](CHANGELOG.md) 和 [发布检查清单](docs/release-checklist.md)。当前包保持 `private: true`，仅准备 GitHub 源码安装与预览包验证，不自动发布到 npm。

详细里程碑、验收标准和风险见 [开发计划](docs/development-plan.md)。已验证事实见 [基线记录](docs/verified-baseline.md)。Provider 契约见 [DSH Provider 契约](docs/dsh-provider-contract.md)。兼容性与性能见 [兼容性矩阵](docs/compatibility-matrix.md) 和 [性能基线](docs/performance-baseline.md)。
