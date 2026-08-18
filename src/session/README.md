# Session mapping

当前 M5 已实现：

- DSH Session ID 与 AGY conversation ID 的映射。
- 新建、恢复、失效、删除和完整历史降级策略。
- 同一 Session 的串行锁；不同 Session 可并发运行。
- `InMemorySessionStore`：插件进程重启后映射丢失，下一次请求使用完整 DSH 历史创建新 AGY 会话。

`SessionRegistry` 不负责删除 AGY 服务器端会话，只管理 DSH 到 AGY 的本地引用；后续 M7 再决定是否增加持久化和清理命令。
