# 工具能力矩阵（0.6 legacy / 0.7 DSH-owned）

## 0.6.x legacy 决策

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

0.6.1 registry 包仍使用上述 AGY-owned profile bundle。直接调用库的 `Config({})` 仍是 `reject`；用户显式通过 0.6.1 `dsh plugin add` 安装 profile bundle 后，`cordis.patch.yml` 默认选择 `agy-owned`。

## 0.7.0 当前源代码决策

未发布的 0.7.0 源码将 bundle 默认切换为 `dsh-owned`：AGY 只接收 bounded prompt contract 并返回经本地严格校验的 DSH tool call，文件、shell、网络和 MCP 仍由 DSH ToolRuntime、sandbox 与 approval 执行。Provider 不直接调用 `ctx.tools.execute()`，也不复制 DSH 权限开关。

## 能力边界

| 能力 | DSH 输入/事件 | AGY 行为 | V1 处理 | 执行所有者 |
|------|---------------|----------|---------|------------|
| 普通文本 | `messages`、`system` | 生成文本 | 映射为 `text-delta` | AGY |
| DSH 原生工具 schema（程序化/严格模式） | `GenerateOptions.tools` | 可能与 AGY 工具重复 | `toolPolicy: reject` 时返回 `UNSUPPORTED_TOOLS`，提示切换策略 | 无，避免双 loop |
| DSH 原生工具 schema（0.5.0 profile bundle 默认） | `GenerateOptions.tools` | DSH Web 默认携带 schema | `toolPolicy: agy-owned` 时忽略 schema，只发送文本 | AGY |
| DSH 原生工具 schema（0.7.0 dsh-owned bundle 默认） | `GenerateOptions.tools` | AGY 只做文本推理 | bounded prompt contract → 本地 allowlist/参数校验 → DSH tool chunk | DSH ToolRuntime |
| DSH 原生工具 schema（显式 AGY-owned） | `GenerateOptions.tools` | schema 仅属于 DSH 上下文入口 | 忽略 schema，只发送文本，不生成 DSH tool chunk | AGY |
| AGY 内置工具调用 | `step_update.step_type=tool` | AGY 自己调用工具 | 作为内部事件透传给解析层，不生成 DSH tool chunk | AGY |
| AGY 工具结果 | AGY `tool` step 后续状态 | AGY 内部消费 | 不暴露为 DSH tool result | AGY |
| 权限请求 | `permission_request` 或 permission step | 等待用户批准 | 立即终止并返回 `PERMISSION_REQUIRED` | 用户/未来 UI |
| 工具错误 | tool step `state=ERROR` | AGY 继续或结束 | 保留 AGY 状态，最终按 result/exit 映射 | AGY |
| 会话并发 | DSH `sessionId` | AGY conversation | 同 Session 串行，不同 Session 并发 | Provider |

## 安全规则

1. Provider 不自动传 `--dangerously-skip-permissions`。
2. 默认 `toolPolicy: reject` 时，DSH 传入非空 `tools` 在启动 AGY 前失败；显式 `dsh-owned` 才启用桥接，`agy-owned` 仅是 legacy AGY 执行路径。
3. 检测到权限请求时终止 AGY 子进程，避免 headless 进程无限等待。
4. AGY 工具事件只作为外部数据解析，不信任其中的路径、命令或参数。
5. `agy-owned` 不等于工具桥接；不能通过“把 AGY 工具名伪装成 DSH tool-call”实现。

## 0.7.0 bridge 门禁状态

V7-M2b 已完成 prompt-contract 可靠性与 disposable DSH ToolRuntime round-trip 门禁。继续扩大能力矩阵前仍必须完成：

- DSH tool call、permission、tool result 的脱敏 fixture 和完整 schema。
- 每个工具的唯一执行所有者和幂等/重试策略。
- 权限 UI 或 headless 审批协议。
- 工具参数、工作区路径和取消信号的双向校验。

## 0.6.0 Agent capability presets

| Preset | 工具白名单 | 工作区要求 | 适用范围 |
|--------|------------|------------|----------|
| `tool-free` | `[]` | 无 | 默认文本请求；保留 `deepseek-proxy` 兼容路径 |
| `read-only` | `find_by_name`、`grep_search`、`view_file`、`list_dir` | 可选 existing workspace | 查找/读取；experimental image 的唯一推荐前置档位 |
| `workspace-write` | read-only + `multi_replace_file_content`、`replace_file_content`、`write_to_file` | 必须是显式 existing non-root `workspaceRoot` | 受控文件编辑 |

0.6.0 的 write preset 不包含 `run_command`、网络、浏览器、MCP、subagent 或 `--dangerously-skip-permissions`。Agent 安装默认 preview，只有显式 `--apply` 才写入；doctor v2 只校验 frontmatter/白名单，不自动覆盖用户 Agent。

## 0.6.0 图片结论

Provider 可以从 DSH `AttachmentStore` 读取经过校验的 raster bytes 并按请求 staging 到临时目录，但当前没有足够的 AGY `view_file` 来源事件和 DSH Web attachment 闭环证据。因此 `imageInput: experimental` 只提供受控实验错误/清理路径，公开模型 metadata 继续为 `inputModalities: ['text']`；不把图片伪装成 DSH tool-call 或 Prompt 内路径。
