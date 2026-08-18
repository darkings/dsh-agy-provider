# AGY adapter

本目录包含：

- `agy.exe` 路径发现和参数构造。
- `shell: false`、`windowsHide: true` 的子进程管理。
- stdout 逐行回调、stderr 收集、退出码和信号记录。
- AbortSignal 取消与外层超时。
- `stream-json` 任意 chunk 边界、CRLF 和未知事件兼容解析。

Process Adapter 负责可靠地产生原始 stdout 行，Parser 负责将其转换为带
`event` envelope 的结构化事件；后续 Provider 层再做 DSH `StreamChunk` 映射。
