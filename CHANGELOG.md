# Changelog

## [0.1.0] - 2026-08-18

首个可用预览版，目标是把本机已登录的 AGY CLI 暴露为 DSH 文本 Provider。

### Added

- 基于 `@deepseek-ai/dsh-llm` `LlmAdapter` 的 DSH bundle 插件入口。
- Windows 无 Shell `agy.exe` 子进程适配、stream-json 增量解析、取消和超时。
- `sessionMode: full` 默认上下文策略，以及显式 `resume` 会话映射和恢复失败降级。
- AGY 自治 Agent 工具边界：DSH tools 拒绝，权限请求快速失败。
- 配置诊断、最低 AGY 版本检查、有界并发队列、结构化脱敏日志。
- NDJSON/进程输出上限、兼容性矩阵、无额度性能基线和 GitHub Actions CI。

### Limitations

- V1 仅支持文本消息；不支持 DSH tools、图像、采样控制和跨进程会话持久化。
- 当前完整实机兼容性范围是 Windows 11、AGY `1.1.13`/`1.1.14` 和 `deepseek-proxy`。
- package manifest 仍保持 `private: true`；本仓库提供 GitHub 源码安装和预览包验证，不执行 npm publish。
