# DSH Provider adapter

当前已实现 M4 文本 Provider MVP：

- 插件注册与配置 Schema。
- `AgyAdapter extends LlmAdapter` 与 `ctx.llm.registerAdapter()`。
- AGY 模型枚举和精确模型元数据。
- DSH messages 到 AGY Prompt 的确定性序列化。
- `step_update.text_delta`、最终 response、usage、finish reason 和错误映射。

工具调用、图像、采样控制和会话恢复留到后续里程碑；文本 MVP 会对未支持能力显式报错，不静默丢弃。

M7 增加了每个 Adapter 实例的 AGY 进程并发上限和有界等待队列。通过 DSH bundle 注册时，Adapter 使用 Cordis `ctx.logger('dsh-agy-provider')` 输出脱敏的 JSON 生命周期记录；日志失败不会影响请求。
