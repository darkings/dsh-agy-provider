# V3-M4 持久 stream transport 实验闸门

状态：fixture gate 已通过；当前仍是隔离 prototype，不是默认运行路径，也不是可供用户配置的正式 transport。`0.2.0` 版本号和 npm `latest` 不变，默认 one-shot 行为不变。

## 结论

V3-M4 已验证了 worker 生命周期和故障回收的工程边界：

- 一个 DSH Session 只拥有一个 worker；worker 输出同时校验 `requestId` 和 `sessionId`。
- 100 轮串行请求复用同一个 worker；8 个 Session 可以并发，并受 `maxWorkers` 限制。
- `abort`、`timeout`、输出上限、错误 request correlation 和错误 session ownership 都会 reset 当前 worker，残余输出不会交给下一请求。
- worker 崩溃后会从 pool 移除并允许同一 Session 重建；空闲 TTL 会关闭 idle worker。
- timeout 会清理父子进程树，`dispose()` 会拒绝 active request 并回收所有 worker。
- 完整本地测试为 72/72，通过既有 one-shot Process Adapter 回归和 V3-M4 fixture gate。

这只是无额度验证。阶段内没有发起真实 AGY 模型请求，也没有把 fixture 协议当作 AGY 的正式 `--input-format stream-json` 契约。真实 one-shot/persistent 3+3 对照必须在 AGY 输入输出协议单独确认后，由人工显式触发，并受 0.3.0 计划中的请求数和 token 硬上限约束。

## Prototype 边界

实验实现位于 `src/agy/experimental-transport.ts`，但当前不会从包的 public `index` 导出，也没有接入 `AgyAdapter`、`Config` 或默认 `sessionMode`。测试 worker 位于 `tests/fixtures/persistent-worker.mjs`，只用于验证 transport 状态机，不代表 AGY CLI 的生产协议。

受控 fixture 使用最小 NDJSON envelope：

```text
transport → { kind: "request", requestId, sessionId, payload }
worker    → { kind: "ready", sessionId }
worker    → { kind: "event" | "complete" | "error", requestId, sessionId, ... }
transport → { kind: "shutdown" }
```

stdin frame、stdout frame、stderr 和单次 response 都有大小上限；spawn 使用参数数组和 `shell: false`，不会拼接 shell 命令。日志不记录 Prompt、payload、Token、stderr 原文或凭据。

## 为什么暂不接入默认路径

当前正式路径是每次请求独立启动 AGY print-mode one-shot，并已经覆盖跨平台 timeout/abort/进程树清理。持久 worker 一旦接入默认 Provider，就会把 stdin framing、AGY 输入协议、worker 崩溃恢复和 Session 所有权变成用户可见的兼容性承诺。

因此本阶段只证明隔离 prototype 的状态机，不新增 `transport` 配置，也不改变 `sessionMode: full`。只有以下条件同时满足，才可以继续设计显式 experimental 配置：

1. 取得并固定 AGY `--input-format stream-json` 的真实输入/输出协议，而不是依赖自定义 fixture envelope。
2. 在真实请求中完成计划规定的 3 对 3 对照；persistent 首 token 延迟中位数至少改善 15%，且 input tokens 增幅不超过 5%。
3. 全部真实请求仍处于计划的硬预算内，并且不记录内容。

任一条件失败，持久 transport 保持未发布状态，one-shot 继续作为唯一正式传输。

## 复验命令

```powershell
npm test
npm run verify
```

`npm test` 不调用 AGY 模型，不消耗账号额度；真实 AGY 实验不属于自动化测试或 CI。
