# DSH Provider adapter

当前已实现 M4 文本 Provider MVP：

- 插件注册与配置 Schema。
- `AgyAdapter extends LlmAdapter` 与 `ctx.llm.registerAdapter()`。
- AGY 模型枚举和精确模型元数据。
- DSH messages 到 AGY Prompt 的确定性序列化。
- `step_update.text_delta`、最终 response、usage、finish reason 和错误映射。

默认 `toolPolicy: reject` 会对非空 DSH tools 显式报错，不静默丢弃；显式 `toolPolicy: agy-owned` 只忽略 DSH schemas，AGY 继续独占内部工具执行。图像、采样控制和会话恢复按各自能力边界处理。

M7 增加了每个 Adapter 实例的 AGY 进程并发上限和有界等待队列。通过 DSH bundle 注册时，Adapter 使用 Cordis `ctx.logger('dsh-agy-provider')` 输出脱敏的 JSON 生命周期记录；日志失败不会影响请求。

V2-M3 增加固定事件类别计数、最终 AGY status 和稳定错误分类。工具/权限事件只作为内部进度计数，不转换为 DSH tool call；V3-M2 已支持 reasoning effort 控制参数，V3-M3 日志增加 `toolPolicy` 和 `toolSchemaCount`，但 reasoning-delta 输出仍未启用，避免依赖未验证的 AGY envelope。
