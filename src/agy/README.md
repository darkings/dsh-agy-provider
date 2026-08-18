# AGY adapter

本目录包含：

- `agy.exe` 路径发现和参数构造。
- `shell: false`、`windowsHide: true` 的子进程管理。
- stdout 逐行回调、stderr 收集、退出码和信号记录。
- AbortSignal 取消与外层超时。
- `--conversation <id>` 参数构造；不使用全局 `--continue`。
- `stream-json` 任意 chunk 边界、CRLF 和未知事件兼容解析。
- `AgyConcurrencyLimiter` 提供有界 FIFO 队列、排队超时和 AbortSignal 取消。
- `diagnoseAgy()` 只执行 `--version` 与 `agents`，不触发模型调用或工具执行。
- `redactText()` 和白名单日志记录避免输出 Prompt、凭据、环境变量和用户路径。

Process Adapter 负责可靠地产生原始 stdout 行，Parser 负责将其转换为带
`event` envelope 的结构化事件；后续 Provider 层再做 DSH `StreamChunk` 映射。
