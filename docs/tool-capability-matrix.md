# 工具能力矩阵（M6）

## V1 决策

V1 采用 **AGY 自治 Agent + DSH 文本外壳**：

```text
DSH messages/system
        ↓
dsh-agy-provider（只输出文本）
        ↓
AGY deepseek-proxy Agent
        ├─ AGY 内部工具执行
        └─ AGY 内部权限/工具结果
```

Provider 不把 AGY 内部工具重新包装成 DSH `tool-call`，也不让 DSH Agent loop 同时执行同一工具。

## 能力边界

| 能力 | DSH 输入/事件 | AGY 行为 | V1 处理 | 执行所有者 |
|------|---------------|----------|---------|------------|
| 普通文本 | `messages`、`system` | 生成文本 | 映射为 `text-delta` | AGY |
| DSH 原生工具 schema（默认） | `GenerateOptions.tools` | 可能与 AGY 工具重复 | `toolPolicy: reject` 时返回 `UNSUPPORTED_TOOLS` | 无，避免双 loop |
| DSH 原生工具 schema（显式 AGY-owned） | `GenerateOptions.tools` | schema 仅属于 DSH 上下文入口 | 忽略 schema，只发送文本，不生成 DSH tool chunk | AGY |
| AGY 内置工具调用 | `step_update.step_type=tool` | AGY 自己调用工具 | 作为内部事件透传给解析层，不生成 DSH tool chunk | AGY |
| AGY 工具结果 | AGY `tool` step 后续状态 | AGY 内部消费 | 不暴露为 DSH tool result | AGY |
| 权限请求 | `permission_request` 或 permission step | 等待用户批准 | 立即终止并返回 `PERMISSION_REQUIRED` | 用户/未来 UI |
| 工具错误 | tool step `state=ERROR` | AGY 继续或结束 | 保留 AGY 状态，最终按 result/exit 映射 | AGY |
| 会话并发 | DSH `sessionId` | AGY conversation | 同 Session 串行，不同 Session 并发 | Provider |

## 安全规则

1. Provider 不自动传 `--dangerously-skip-permissions`。
2. 默认 `toolPolicy: reject` 时，DSH 传入非空 `tools` 在启动 AGY 前失败，避免工具被执行两次；`agy-owned` 不是 DSH 工具桥接或权限绕过。
3. 检测到权限请求时终止 AGY 子进程，避免 headless 进程无限等待。
4. AGY 工具事件只作为外部数据解析，不信任其中的路径、命令或参数。
5. `agy-owned` 不等于工具桥接；不能通过“把 AGY 工具名伪装成 DSH tool-call”实现。

## 后续桥接前置条件

若未来需要 DSH 工具桥接，必须先完成：

- AGY tool call、permission、tool result 的脱敏 fixture 和完整 schema。
- 每个工具的唯一执行所有者和幂等/重试策略。
- 权限 UI 或 headless 审批协议。
- 工具参数、工作区路径和取消信号的双向校验。
