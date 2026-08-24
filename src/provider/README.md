# DSH Provider adapter

当前已实现 M4 文本 Provider MVP：

- 插件注册与配置 Schema。
- `AgyAdapter extends LlmAdapter` 与 `ctx.llm.registerAdapter()`。
- AGY 模型枚举和精确模型元数据。
- DSH messages 到 AGY Prompt 的确定性序列化。
- `step_update.text_delta`、最终 response、usage、finish reason 和错误映射。

默认 `toolPolicy: reject` 会对非空 DSH tools 显式报错，不静默丢弃；显式 `toolPolicy: dsh-owned` 使用 bounded prompt contract 返回经本地 allowlist/参数校验的 DSH tool call，由 DSH ToolRuntime 执行；`agy-owned` 仅作为 0.6.x 兼容路径，继续由 AGY 独占内部工具执行。图像、采样控制和会话恢复按各自能力边界处理。

M7 增加了每个 Adapter 实例的 AGY 进程并发上限和有界等待队列。通过 DSH bundle 注册时，Adapter 使用 Cordis `ctx.logger('dsh-agy-provider')` 输出脱敏的 JSON 生命周期记录；日志失败不会影响请求。

V2-M3 增加固定事件类别计数、最终 AGY status 和稳定错误分类。工具/权限事件只作为内部进度计数，不转换为 DSH tool call；V3-M2 已支持 reasoning effort 控制参数，V3-M3 日志增加 `toolPolicy` 和 `toolSchemaCount`，V3-M5 增加白名单 `reasoningEffort`、model discovery source/warning code，且 reasoning-delta 输出仍未启用，避免依赖未验证的 AGY envelope。

测试阶段的 `agy.request.failed` 记录还会按需包含 `processDiagnostic`：`stage`、内部错误名/稳定 code、stdout 行号/长度、stdout/stderr 字节计数和 16 位行哈希。该字段不包含 Prompt、响应正文、stderr 原文、可执行路径、工具参数或凭据；`lineHash` 仅用于把同一次失败与本地复现对应起来。

当 `dsh-owned` 收到 AGY 内部工具事件时，生命周期记录还会包含 `toolEventStreamIndex` 和 `toolEventDiagnostic`。后者只保留 `eventName`、`kind`、`stepType`、`toolName`、`carrierShape`、`recipientClass` 以及脱敏后的结构 key（不保留字段值），可区分普通 AGY 工具、`send_message` 载体缺字段、已知 DSH runtime recipient、外部 recipient 和完整载体的 DSH 协议校验失败。`default_api`、当前根 conversation，以及固定的 `dsh`/`dsh-session`/`dsh-runner` 通道只有在 DSH envelope、工具 allowlist 和参数 Schema 均通过后才会桥接；所有诊断字段都经过白名单过滤，不包含 Prompt、响应正文、工具参数值、用户路径或凭据。
