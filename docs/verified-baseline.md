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
- `--conversation`/`--continue` 的恢复和并发语义。
- macOS/Linux 可移植性。
- AGY 升级后的事件兼容性。

