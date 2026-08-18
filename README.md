# dsh-agy-provider

将本机已登录的 AGY CLI 暴露为 DSH 的模型 Provider，使 DSH 可以通过 AGY 使用其账号额度和可用模型。

## 当前状态

项目已完成 M1–M6 的最小闭环，当前以 Windows 11、AGY `1.1.13` 为开发基线：

- `deepseek-proxy` Agent 可被 AGY 识别。
- `agy.exe --output-format stream-json` 可输出逐行 JSON 事件。
- Node.js `child_process.spawn()` 可直接启动 `agy.exe` 并增量解析输出。
- 最小请求可得到 `init`、`step_update` 和 `result` 事件，进程退出码为 `0`。
- 官方 `@deepseek-ai/dsh-llm` runtime 可注册并驱动 `AgyAdapter` 文本流。
- 当前自动化测试 28 个全部通过；bundle dry-run 可见 `cordis.patch.yml` 和 `lib` 产物。

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
│  └─ verified-baseline.md
├─ src/
│  ├─ agy/          # 子进程、参数、事件解析
│  ├─ provider/     # DSH Provider、文本序列化和 AGY 映射
│  ├─ session/      # DSH Session 与 AGY Conversation 映射
│  └─ index.ts
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

详细里程碑、验收标准和风险见 [开发计划](docs/development-plan.md)。已验证事实见 [基线记录](docs/verified-baseline.md)。Provider 契约见 [DSH Provider 契约](docs/dsh-provider-contract.md)。
