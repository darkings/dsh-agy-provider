# 已验证基线

验证日期：2026-08-18  
平台：Windows 11

## 环境

| 项目 | 实测值 |
|------|--------|
| AGY executable | `C:\Users\Jie\.local\bin\agy.exe` |
| AGY version | `1.1.13` |
| Node.js | `v24.18.0` |
| npm | `11.16.0` |
| Git | `2.55.0.windows.3` |
| Agent | `deepseek-proxy` |

## 命令行为

`agy agents` 可列出：

```text
deepseek-proxy
```

本机版本不支持：

```powershell
agy agents --output-format json
```

`--output-format` 是 print 模式参数，可用于：

```powershell
agy -p "只输出数字 123，不要调用任何工具。" `
  --agent deepseek-proxy `
  --output-format stream-json
```

## stream-json 实测

已观察事件顺序：

```text
init
step_update
step_update
step_update
result
```

关键字段：

- `init.conversation_id`
- `init.init.agent`
- `init.init.tools`
- `step_update.step_update.text_delta`
- `step_update.step_update.usage`
- `result.result.status`
- `result.result.response`
- `result.result.usage`

Node.js `spawn()` 实测结果：

```json
{
  "exitCode": 0,
  "eventCount": 5,
  "agent": "deepseek-proxy",
  "response": "123\n",
  "status": "SUCCESS",
  "totalTokens": 5407,
  "parseErrors": [],
  "stderr": ""
}
```

## 尚未验证

- DSH 的真实 Provider 插件注册与事件 API。
- AGY 工具调用、权限请求和错误事件结构。
- 跨插件进程重启的持久化 conversation 映射；当前实现明确使用完整 DSH history 降级。
- macOS/Linux 可移植性。
- AGY 升级后的事件兼容性。

## 会话参数实测（M5）

- `--conversation <id>` 可以恢复指定会话；第二轮 `init.conversation_id` 与首轮一致，并能读取首轮上下文。
- `--continue` 会恢复当前工作目录下的最近会话，不适合多个 DSH Session 共享。
- 不存在的 conversation ID 会输出 warning，然后创建新的 `init.conversation_id`。
- Provider 默认 `sessionMode: full`；`sessionMode: resume` 才使用显式 `--conversation`。
- 真实两轮成本样本：full `inputTokens=4490`；resume 第二轮 `inputTokens=9385`。该结果只代表当前 AGY/Agent/提示条件，后续长会话仍需重新测量。

## 工具事件实测（M6）

- 只读工具请求曾输出 `step_update.step_type=tool`，状态从 `ACTIVE` 到 `ERROR`，随后出现 `checkpoint`、`agent_response` 和 `error_message`。
- 默认权限模式下另一次只读工具请求未在超时前完成交互，说明 headless Provider 不能等待人工审批。
- Provider 因此不桥接 AGY tool call；DSH tools 直接拒绝，权限事件快速失败。
