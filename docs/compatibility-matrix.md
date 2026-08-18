# 兼容性矩阵

## 已验证组合

| 组件 | 版本/环境 | 结果 | 证据 |
|------|-----------|------|------|
| Windows | Windows 11 | 通过 | M0–M8 本机测试 |
| Node.js | `v24.18.0`，要求 `>=20` | 通过 | `npm test`、真实 AGY 请求 |
| DSH LLM SDK | `@deepseek-ai/dsh-llm@0.1.0-rc.7` | 通过 | 官方 `Context + LlmRuntime` smoke test |
| AGY | `1.1.13` | 通过 | M0–M6 真实文本、会话和工具采样 |
| AGY | `1.1.14` | 通过诊断 | `npm run diagnose`；版本与 Agent 检查通过 |
| AGY Agent | `deepseek-proxy` | 通过 | `agy agents` 与 Provider 默认配置 |

## 版本策略

- `minimumAgyVersion` 默认是 `1.1.13`，采用 `major.minor.patch` 数值比较。
- 低于最低版本、无法解析版本或找不到配置 Agent 时，诊断命令返回非零退出码和明确错误。
- AGY 新版本的未知 `event` 字段会由 Parser 保留；但新增关键字段的语义仍需重新采样。
- `agy agents --output-format json` 不作为兼容前提；诊断使用已验证的纯文本 `agy agents`。

## 事件兼容范围

| 事件 | 处理策略 |
|------|----------|
| `init` | 读取顶层或嵌套 `conversation_id` |
| `step_update` | 读取 `text_delta`、usage、tool/permission 分类 |
| `result` | 读取 `status`、最终 response 和 usage |
| `checkpoint`、`agent_response`、未知事件 | 保留并按固定类别计数，不静默转换为 DSH tool call |
| `error`、`error_message` | 提取有界分类 detail；不记录原始 payload |
| 工具事件 | 只累计 `tool` 类别和工具计数，不产生 DSH tool chunk |
| permission event | 终止 headless 请求并返回 `PERMISSION_REQUIRED` |

## 稳定错误分类

| AGY detail/生命周期 | Provider code |
|---------------------|---------------|
| authentication/login/credential | `AUTH` |
| quota/credit/balance/billing | `QUOTA` |
| rate limit/429/throttling | `RATE_LIMIT` |
| model not found/unavailable | `MODEL_NOT_FOUND` |
| Agent/profile not found | `AGY_AGENT_MISSING` |
| context/prompt/input too large | `CONTEXT_WINDOW_EXCEEDED` |
| permission request | `PERMISSION_REQUIRED` |
| timeout/abort/parse/output limit | `TIMEOUT`/`ABORTED`/`AGY_PARSE`/`AGY_OUTPUT_LIMIT` |

无法分类的非零退出或非成功 status 保留 `AGY_EXIT` 或 `AGY_STATUS`。reasoning envelope 尚未验证，因此不映射为 `reasoning-delta`。

## 未覆盖环境

- macOS/Linux 尚未完成完整子进程和 AGY CLI 验证。
- AGY `1.1.14` 的完整文本/会话/工具回归仍需在 M8 的真实额度窗口中补采样；当前已完成无额度诊断和代码回归。
- DSH SDK 的后续 breaking release 需要重新验证 `LlmAdapter` 和 bundle contract。
