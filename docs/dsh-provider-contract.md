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
- `reasoningEffort`：V3-M2 已支持 `low`、`medium`、`high`，并映射为 AGY `--effort`。
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

默认 `toolPolicy: reject` 显式拒绝非空 DSH tools、image blocks、temperature、maxTokens、stop 和未支持的采样语义，避免静默丢弃。显式 `toolPolicy: agy-owned` 时只忽略 DSH tool schemas，继续以文本 Prompt 调用 AGY；该模式不生成 DSH tool chunks，AGY 内部工具仍由 AGY 独占。

## M5 会话与上下文策略

`GenerateOptions.sessionId` 被转换为本地 Session key。`SessionRegistry` 保存 AGY `init.conversation_id`，并对同一 key 加锁：同一个 DSH Session 不会同时启动两个 AGY 请求，不同 Session 不互相阻塞。

配置：

- `sessionMode: full`（默认）：每轮把 DSH 完整历史发送到新的 AGY CLI 会话。该模式重启安全，且当前实测 quota 成本更低。
- `sessionMode: resume`：首轮创建并记录 conversation ID，后续调用 `--conversation <id>`，只发送上次 assistant 之后的消息。

恢复 ID 如果不存在，AGY 会 warning 后创建新 ID。适配器通过 `init.conversation_id` 检测不一致，丢弃该次 resume 输出并用完整 DSH history 重试一次。映射是进程内的；插件重启后不伪造旧 ID，而是使用完整历史创建新会话。

## M6 工具边界

V1 选择 AGY 自治 Agent。默认 `toolPolicy: reject` 时 `GenerateOptions.tools` 非空在启动进程前返回 `UNSUPPORTED_TOOLS`；显式 `toolPolicy: agy-owned` 时忽略这些 schema，但 AGY 自己产生的 `step_type=tool` 事件仍不转换成 DSH `tool-call-delta`。检测到 `permission_request` 或 permission step 时，适配器终止子进程并返回 `PERMISSION_REQUIRED`，避免 headless 调用永久等待。完整矩阵见 `docs/tool-capability-matrix.md`。

## M7 配置与可观测性

DSH-owned 模式下，普通 `step_update.name` 不视为内部工具；只有 `tool_call`、`tool_result`、`step_type=tool` 或明确的 `tool_name` 才会返回 `AGY_INTERNAL_TOOL_EVENT`。DSH tools schema 不支持仍返回 `UNSUPPORTED_TOOLS`。

Adapter 使用 `minimumAgyVersion`、`maxConcurrent`、`maxQueue` 和 `queueTimeoutMs` 控制兼容性与本机进程资源。`diagnoseAgy()` 只调用 `agy --version` 和 `agy agents`；它不会发送 Prompt、使用 AGY 额度或触发工具。

`Config.models` 提供显式模型目录，条目包含必填的精确 `id`，以及可选的 `name`、`description` 和 `contextWindow`。`Config.model` 仍兼容 0.1.0，并作为默认/回退条目；目录按 `id` 去重，未配置但由请求方明确传入的模型 ID 不会被静默改写。`diagnoseProvider()` 和 `npm run diagnose -- --json` 使用 `schemaVersion: 1` 返回插件、Node.js、DSH、AGY、Agent、配置和模型目录状态，并将诊断标记为 `quotaUsed: false`。

请求生命周期日志通过 Cordis logger 输出白名单元数据：`requestId`、`sessionId`、`conversationId`、`durationMs`、`exitCode`、`termination`、队列等待时间、最终 AGY `status`、`eventCount`、固定类别计数、工具/权限事件计数、`toolPolicy` 和 `toolSchemaCount`。失败请求可额外包含脱敏的 `processDiagnostic`（启动阶段、内部错误名/code、stdout 行号/长度、stdout/stderr 字节计数和短行哈希），用于区分 launcher、spawn、stdin 和 stdout parser/handler 失败。日志发送前会脱敏字符串，并且不包含 Prompt、响应正文、stderr 原文、环境变量、AGY 路径、工具参数或凭据。

V2-M3 使用稳定错误分类：认证 `AUTH`、额度 `QUOTA`、速率限制 `RATE_LIMIT`、未知模型 `MODEL_NOT_FOUND`、Agent 缺失 `AGY_AGENT_MISSING`、上下文超限 `CONTEXT_WINDOW_EXCEEDED`，以及现有的 `PERMISSION_REQUIRED`、`TIMEOUT`、`ABORTED`、`AGY_PARSE`、`AGY_OUTPUT_LIMIT`、`AGY_STATUS` 和 `AGY_EXIT`。分类只基于有界的 AGY status/stderr/error event detail；未知文本保留 fallback code。

## 0.7.0 DSH-owned tool bridge contract

0.7.0 的 profile bundle 默认使用 `toolPolicy: dsh-owned`。Provider 与 DSH 的职责边界固定为：

```text
DSH GenerateOptions.tools
        ↓
request-scoped Session/workspace/permission snapshot
        ↓
bounded prompt contract → AGY text response
        ↓
local allowlist/schema/argument/result validation
        ↓
DSH tool-call chunk
        ↓
DSH ToolRuntime + sandbox + approval
```

- Provider 只返回经过校验的 DSH tool call，不直接执行文件、shell、网络或 MCP。
- 项目目录只取自 live DSH Session 的 canonical `cwd`；静态 `workspaceRoot`、Prompt 和 `process.cwd()` 不能覆盖它。
- `read-only`、`workspace-write`、`danger-full-access` 和 approval 由 DSH 当前 Session 决定；Provider 不复制开关、不自动批准、不传 `--dangerously-skip-permissions`。
- AGY 内部 tool event 在 `dsh-owned` 下 fail closed，不伪装成 DSH tool call；`agy-owned` 仅为 0.6.x legacy 文本兼容模式。
- 所有 bridge 错误、取消、超时和临时 schema cleanup 都必须保持稳定错误码和脱敏边界。

验证证据见 [工具能力矩阵](tool-capability-matrix.md)、[0.7.0 迁移说明](migration-0.7.0.md) 和 [0.7.0 release checklist](v0.7.0-release-checklist.md)。

## 0.8.0 Persistent transport（AGY 1.1.15 stream-json）

- 单进程多轮输入：每行 `{"event":"user","message":{"role":"user","content":[{"type":"text","text":...}]}}`，输出 `init/step_update/result`（`conversation_id` 一致，见 `src/agy/persistent-transport.ts`）。
- `transport: one-shot | persistent` 默认 `one-shot`；`persistent` 时一 Session 一 worker（idle TTL + readyTimeout + before-accept 回退），仍复用 parser/错误分类/usage/tool protocol。
- 目的路由：`compaction/sessionTitle` 与无 `sessionId` 请求固定走 `one-shot`；`M4` 实测 warm-turn 79% 改善，token 5.5% 增幅，无串线。

## 0.9.0 设置面板 + 工作区无感 + 模型平权

### 设置面板

- 插件 `apply()` 注册 `ctx.llm.registerConfigurableProviders([{provider:'agy', displayName:'AGY', settingsNs:'dsh-agy-provider', settingsPath:[]}])`，设置面板由 `Config` schema 的 `description` 驱动。
- `ctx.llm.registerModelDiscovery('dsh-agy-provider', ...)` 暴露发现模型，面板渲染为多选勾选框，勾选写回 `visibleModels`。
- `Config` 每个字段配 `.i18n({'zh-CN':{$description},en:{$description}})`，DSH 按当前 locale 合并显示；`workspaceRoot` 加 `.deprecated()` 且 `dsh-owned` 时隐藏。

### 工作区无感

```text
header.cwd (canonical) → workspaceRegistry.resolveByPath(cwd) → sandboxPolicy.resolve(session) → resolveDshContext 校验三者一致 → Provider 直接使用 canonicalCwd
```

- `dsh-owned` 下 `workspaceRoot` 不再读取（`resolveAgyAgentRuntime` 强制 `undefined`），`doctor v5` 报告 `workspaceSource: dsh-session-cwd` 与 `DEPRECATED_WORKSPACE_ROOT` warning。
- 文本无需 workspace；有工具但无 workspace 时返回 `DSH_WORKSPACE_MISMATCH` 可操作错误，`doctor` 提示“请先在 DSH 中打开项目文件夹”。
- 权限/沙箱仍由 DSH `read-only / workspace-write / danger-full-access` 与 `approval` 决定。

### 模型平权

- `src/agy/models.ts`：`normalizeModelId` 去 `-high/-medium/-low` 后缀，`extractEffort` 提取强度，`parseAgyModels/mergeModelCatalog` 按 base 去重；`configuredModels` 同。
- `src/provider/config.ts`：`Config.visibleModels: string[]` 空=全部，非空按 base 过滤（`filterVisibleModels`）；`model/models` 语义收口为 base。
- `src/provider/agy.ts`：`listModels()` 仅返回 base 并带 `reasoning: {efforts:[low,medium,high]}`，`resolveModel/stream` 兼容旧后缀请求自动拆 `base+effort` + warning；`effectiveModels()` 按 `visibleModels` 过滤。
- `doctor v5` (`profileSchemaVersion: 4`) 报告 `visibleModels: {raw,count,filtered}` 与 `modelEffortSplit: {baseModel,suffixDetected,normalized}` 及 `DEPRECATED_MODEL_EFFORT_SUFFIX`。
