# dsh-agy-provider

将本机已登录的 AGY CLI 暴露为 DSH 的模型 Provider，使 DSH 可以通过 AGY 使用其账号额度和可用模型。

## 当前状态

项目处于初始化与接口验证阶段。已在 Windows 11、AGY `1.1.13` 上完成以下基线验证：

- `deepseek-proxy` Agent 可被 AGY 识别。
- `agy.exe --output-format stream-json` 可输出逐行 JSON 事件。
- Node.js `child_process.spawn()` 可直接启动 `agy.exe` 并增量解析输出。
- 最小请求可得到 `init`、`step_update` 和 `result` 事件，进程退出码为 `0`。

## 目标架构

```text
DSH
  ↓
dsh-agy-provider
  ├─ DSH Provider Adapter
  ├─ AGY Process Adapter
  ├─ stream-json Parser
  └─ Session Mapping
  ↓
agy.exe --agent deepseek-proxy
  ↓
AGY 账号额度与模型
```

最终运行链路保留 AGY，不直接调用 Gemini API。Python/OpenAI Proxy 仅可作为调试参考，不属于目标架构。

## 项目结构

```text
dsh-agy-provider/
├─ docs/
│  ├─ development-plan.md
│  └─ verified-baseline.md
├─ src/
│  ├─ agy/          # 子进程、参数、事件解析
│  ├─ provider/     # DSH Provider 适配
│  ├─ session/      # DSH Session 与 AGY Conversation 映射
│  └─ index.ts
├─ tests/
├─ task_plan.md
├─ findings.md
└─ progress.md
```

## 开发原则

- 在确认 DSH 的真实 Provider API 前，不提交猜测性的框架调用代码。
- 通过 `spawn(executable, args)` 启动 AGY，不经过 shell 拼接命令。
- 将 AGY 输出视为外部数据，逐行解析并验证事件结构。
- 第一版先完成文本流、取消、超时和错误映射，再扩展工具调用与会话恢复。
- 不记录凭据、Token、完整用户 Prompt 或敏感环境变量。

详细里程碑、验收标准和风险见 [开发计划](docs/development-plan.md)。已验证事实见 [基线记录](docs/verified-baseline.md)。

