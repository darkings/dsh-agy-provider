# DSH Provider 契约（M1）

验证基线：

- 官方仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 读取 revision：`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`
- 参考文档：`docs/user/develop/practice/llm-adapter.zh.md`
- 参考实现：`packages/llm/llm-deepseek/`

## 插件入口

插件是 Cordis 模块，导出：

```ts
export const name = 'dsh-agy-provider'
export const inject = ['llm']
export function apply(ctx: Context, config: Config) {}
```

`apply()` 通过 `ctx.llm.registerAdapter()` 将 Provider 路由注册到 LLM runtime。此前计划中的 `ctx.models.registerProvider()` 不是当前官方契约，已废弃该假设。

## Adapter 接口

实现类继承 `LlmAdapter`：

```ts
class ProviderAdapter extends LlmAdapter {
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {}
}
```

必须实现 `stream()`，可选覆写：

- `providerInfo(provider)`：提供方展示元数据。
- `listModels(provider)`：供选择器使用的 advisory model catalog。
- `resolveModel(provider, model, signal?)`：返回精确模型能力、上下文窗口和 reasoning 元数据。
- `providerRetryPolicy(provider)`：提供方级重试策略。

## Request

`GenerateOptions` 是 DSH 已组装的无提供方请求，包含：

- `provider`、`model`
- `messages`、`system`
- `tools`
- `temperature`、`maxTokens`、`stop`
- `reasoningEffort`
- `signal`
- `sessionId`、`purpose`

适配器必须尊重 `options.signal`。不支持的字段不能静默丢弃，应抛出带稳定 code 的 `LlmError`。

## StreamChunk

最小文本流顺序：

```text
block-start(text)
text-delta*
block-end(text)
usage?
finish(stop|...)
```

工具调用使用 `tool-call-delta` 和 `block-end(tool-call)`；`finish` 必须是最后一个分片，`usage` 必须位于 `finish` 之前。

## Package / Bundle

可安装插件不是裸源码文件，而是 npm bundle：

```json
{
  "main": "lib/index.js",
  "files": ["lib/**/*.js", "lib/**/*.d.ts", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml` 通过包名插入插件行。GitHub 源码安装必须提供自包含 `prepare` 构建脚本；pnpm 10+ 还会要求用户明确允许该构建脚本。

## M1 结论

当前实现提供一个默认关闭的 `MockAdapter`，用于验证：

1. 包 manifest 能被 DSH bundle loader 识别。
2. `inject: ['llm']` 能获得 LLM runtime。
3. `ctx.llm.registerAdapter()` 能注册路由。
4. Mock stream 能输出完整 `StreamChunk` 生命周期。

Mock 默认关闭，实际 bundle route 为 `agy`；`agy-mock` 仅作为测试注入路由。

## M4 文本 Provider 约束

当前 `AgyAdapter` 已实现：

- 将 `system` 和 text/reasoning message blocks 按固定 role marker 序列化为 `-p` Prompt。
- 将 `step_update.step_update.text_delta` 实时发为 `text-delta`，并以 `result.response` 补齐没有增量的输出。
- 以最终 `result.usage` 为准发出一次 usage；仅有 `totalTokens` 时暂按输入压力保守计入。
- 将 AGY 非零退出、超时、取消、解析失败和非 `SUCCESS` 状态映射为稳定 `LlmError.code`。

MVP 显式拒绝 DSH tools、image blocks、temperature、maxTokens、stop 和 reasoning effort，避免把 DSH 的工具/采样语义静默丢给 AGY。

## M5 会话与上下文策略

`GenerateOptions.sessionId` 被转换为本地 Session key。`SessionRegistry` 保存 AGY `init.conversation_id`，并对同一 key 加锁：同一个 DSH Session 不会同时启动两个 AGY 请求，不同 Session 不互相阻塞。

配置：

- `sessionMode: full`（默认）：每轮把 DSH 完整历史发送到新的 AGY CLI 会话。该模式重启安全，且当前实测 quota 成本更低。
- `sessionMode: resume`：首轮创建并记录 conversation ID，后续调用 `--conversation <id>`，只发送上次 assistant 之后的消息。

恢复 ID 如果不存在，AGY 会 warning 后创建新 ID。适配器通过 `init.conversation_id` 检测不一致，丢弃该次 resume 输出并用完整 DSH history 重试一次。映射是进程内的；插件重启后不伪造旧 ID，而是使用完整历史创建新会话。

## M6 工具边界

V1 选择 AGY 自治 Agent。`GenerateOptions.tools` 非空时适配器在启动进程前返回 `UNSUPPORTED_TOOLS`；AGY 自己产生的 `step_type=tool` 事件不转换成 DSH `tool-call-delta`。检测到 `permission_request` 或 permission step 时，适配器终止子进程并返回 `PERMISSION_REQUIRED`，避免 headless 调用永久等待。完整矩阵见 `docs/tool-capability-matrix.md`。

## M7 配置与可观测性

Adapter 使用 `minimumAgyVersion`、`maxConcurrent`、`maxQueue` 和 `queueTimeoutMs` 控制兼容性与本机进程资源。`diagnoseAgy()` 只调用 `agy --version` 和 `agy agents`；它不会发送 Prompt、使用 AGY 额度或触发工具。

请求生命周期日志通过 Cordis logger 输出白名单元数据：`requestId`、`sessionId`、`conversationId`、`durationMs`、`exitCode`、`termination`、队列等待时间和 `eventCount`/工具/权限事件计数。日志发送前会脱敏字符串，并且不包含 Prompt、stderr、环境变量、AGY 路径或凭据。
