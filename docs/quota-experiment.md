# V2-M5 真实额度实验

本实验用于决定 `sessionMode: full` 与 `sessionMode: resume` 是否值得进入持久化 Session 方案。它会调用本机已登录的 AGY CLI，消耗 AGY 账号额度；不会在 CI、诊断命令或普通测试中运行。

## 本次硬预算

- 最多 12 次实际 AGY 子进程请求。
- 累计 `inputTokens` 上限 60,000。
- 累计 `outputTokens` 上限 6,000。
- 单次请求超时 120 秒；不自动重试。
- 首组比较固定为 `full` 与 `resume` 各 2 轮，共 4 次请求。
- 只有首组 `resume` 相对 `full` 的第二轮输入 token 节省至少 20%，才继续下一组；否则立即停止。

预算触发后脚本只会停止后续请求。AGY usage 只能在请求完成后返回，因此最后一个请求可能使统计值略过上限；脚本会立即记录并停止，不再发起下一次请求。

## 执行方式

PowerShell：

```powershell
$env:AGY_QUOTA_EXPERIMENT = 'ALLOW'
npm run quota:experiment -- --live
Remove-Item Env:AGY_QUOTA_EXPERIMENT
```

脚本只输出结构化统计：模式、轮次、usage、响应字符数、conversation 映射状态和停止原因；不输出 Prompt、响应正文、AGY 路径、环境变量或凭据。

## 决策门槛

- `resume` 未稳定节省至少 20%：继续默认 `full`，不实现持久化 store。
- 2 轮样本通过但没有长会话证据：仍不改变默认值，标记为需要后续 10/30 轮实验。
- 只有目标会话长度上稳定通过收益和安全门槛，才考虑保存最小的 Session 映射、版本和过期时间。
