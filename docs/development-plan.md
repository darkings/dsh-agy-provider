# dsh-agy-provider 详细开发计划

## 1. 项目目标

把 AGY CLI 封装为 DSH 可选择的模型 Provider，让用户在 DSH 中使用 AGY 已登录账号对应的额度和模型，同时获得稳定的流式输出、取消、超时、错误报告和会话管理能力。

## 2. 范围边界

首个可用版本包含：

- Windows 11 与 AGY `1.1.13` 基线支持。
- 本机 `agy.exe` 自动发现或显式路径配置。
- `deepseek-proxy` 等 Agent 的配置选择。
- 文本对话的流式与非流式适配。
- 进程生命周期、超时、取消和异常退出处理。
- AGY usage、错误和会话 ID 的结构化映射。
- 单元测试、集成测试和诊断日志。

首个版本暂不承诺：

- 直接调用 Gemini/OpenAI-compatible API。
- macOS/Linux 的完整兼容。
- DSH tools 与 AGY tools 的双向完整映射。
- 未验证模型名的静态硬编码列表。
- 自动管理 AGY 登录凭据。

## 3. 关键架构决策

### 3.1 AGY 保留在运行链路

项目目标是使用 AGY 额度，因此 Provider 必须调用 AGY，而不是绕过 AGY 直连模型服务。

### 3.2 使用无 Shell 子进程

通过 Node.js `spawn(agyExecutable, args, { shell: false })` 启动进程。参数必须作为数组传入，避免 Prompt、路径或模型名造成命令注入。

### 3.3 内部分层

```text
DSH request
  ↓
Provider Adapter
  ↓
Request Serializer ── Session Store
  ↓
AGY Process Adapter
  ↓ stdout NDJSON
Incremental Event Parser
  ↓
Normalized Provider Events
  ↓
DSH response stream
```

### 3.4 先文本，后工具

DSH 是 Agent 编排层，AGY 也可能执行自己的 Agent loop。两套工具系统并存会产生所有权冲突，因此文本流必须先独立跑通；工具调用只有在事件协议和 DSH Provider 契约都确认后才启用。

## 4. 里程碑与验收标准

### M0：项目初始化与基线固化（已完成）

交付物：

- Git 项目骨架。
- README、开发计划、发现和进度文件。
- 本机 AGY 基线记录。

验收标准：

- 项目位于 `C:\Users\Jie\Projects\dsh-agy-provider`。
- GitHub 存在同名仓库并包含默认分支。
- 文档明确目标架构和已知风险。

### M1：确认 DSH Provider 契约（已完成；预计 1–2 个开发日）

任务：

1. 锁定目标 DSH 版本和插件 SDK 版本。
2. 找到官方或内置 Provider 实现作为基准。
3. 确认注册入口、配置 Schema、模型枚举、流式事件和生命周期 API。
4. 确认取消信号、错误类型、usage 和 finish reason 的约定。
5. 建立一个不调用 AGY 的 Mock Provider，验证 DSH 能加载并显示模型。

交付物：

- `docs/dsh-provider-contract.md`。
- 可编译、可加载的 Mock Provider。
- 锁定的 DSH/SDK 版本。

验收标准：

- DSH 能发现插件和至少一个测试模型。
- Mock Provider 能完成一轮文本流。
- 不存在未经验证的 Provider API 名称。

### M2：AGY Process Adapter（已完成；预计 1 个开发日）

任务：

1. 实现 `agy.exe` 路径发现和配置校验。
2. 使用参数数组构造 `-p`、`--agent`、`--model`、`--output-format stream-json`。
3. 处理 stdout、stderr、退出码、启动失败和超时。
4. 用 `AbortSignal` 将 DSH 取消传递为子进程终止。
5. 限制继承环境变量，并隐藏 Windows 子进程窗口。

交付物：

- `src/agy/process.ts`。
- Fake executable/fixture 驱动的进程测试。

验收标准：

- 正常完成、超时、取消、路径不存在和非零退出码均有确定结果。
- Prompt 中包含空格、引号、换行时不会改变命令结构。

### M3：stream-json 增量解析器（已完成；预计 1–2 个开发日）

任务：

1. 按 NDJSON 逐行解析，正确处理任意 chunk 边界和 CRLF。
2. 建立已观察事件的类型守卫：`init`、`step_update`、`result`。
3. 区分 `text_delta`、usage、checkpoint 和最终结果。
4. 捕获错误、权限询问、工具调用、未知事件的真实样本。
5. 未知字段前向兼容，畸形行产生可诊断错误。

交付物：

- `src/agy/parser.ts` 与事件类型。
- 脱敏后的 NDJSON fixtures。
- Parser 单元测试。

验收标准：

- 随机切分 chunk 的属性测试不丢行、不重复事件。
- 最终 `result.usage` 不与 checkpoint usage 重复累计。
- 未知事件不会导致整个流静默崩溃。

### M4：DSH 文本 Provider MVP（已完成；预计 2 个开发日）

任务：

1. 将 DSH messages 确定性序列化为 AGY Prompt。
2. 将 AGY `text_delta` 映射为 DSH assistant delta。
3. 将 `result.status`、usage、退出码和 stderr 映射为 DSH 结果或错误。
4. 支持流式和由流聚合得到的非流式响应。
5. 提供 `agyPath`、`agent`、`model`、`timeoutMs` 配置。

交付物：

- 可在 DSH 中选择的 AGY Provider。
- 端到端文本对话测试。

验收标准：

- DSH 中输入“只回复 123”可实时得到 `123`。
- 用户取消后 AGY 进程在限定时间内退出。
- 错误信息不泄露 Token、环境变量或完整敏感 Prompt。

### M5：会话与上下文策略（已完成；预计 1–2 个开发日）

任务：

1. 验证 `--conversation <id>` 和 `--continue` 的真实行为。
2. 建立 `DSH session ID → AGY conversation ID` 映射。
3. 明确新会话、恢复、删除、并发请求和崩溃恢复语义。
4. 比较“AGY 恢复会话”和“每轮完整序列化历史”的 Token 成本。
5. 为不可恢复会话提供显式降级策略。

当前实现与验收决定：

- 默认 `sessionMode: full`，每轮发送完整 DSH history；实测同一两轮样本中 AGY `inputTokens` 为 4490。
- `sessionMode: resume` 使用显式 `--conversation <id>`，后续只发送新 turn；同一两轮样本中第二轮 AGY `inputTokens` 为 9385，因此暂不作为默认策略。
- DSH Session 映射目前为进程内存储；插件重启后明确降级为完整 DSH history 并创建新 AGY conversation。
- 两个 DSH Session 使用不同映射；同一 Session 有串行锁，不同 Session 可并行。
- resume ID 不存在或 AGY 返回不同 ID 时，放弃该次 resume 输出，自动使用完整 DSH history 重试一次。

### M6：工具调用能力决策与实现（已完成；预计 2–3 个开发日）

任务：

1. 采集 AGY 工具调用、权限询问和工具结果事件样本。
2. 建立 DSH tools 与 AGY tools 的能力矩阵。
3. 决定 V1 模式：文本 Provider、AGY 自治 Agent，或受限的工具桥接。
4. 防止 DSH 和 AGY 同时执行同一个工具调用。
5. 为不支持的工具能力提供清晰错误，而不是伪装成功。

当前验收结果：

- V1 工具执行所有权归 AGY；DSH `tools` 进入 Provider 时直接返回 `UNSUPPORTED_TOOLS`。
- 检测到 permission event 时终止子进程并返回 `PERMISSION_REQUIRED`，不会无限等待。
- AGY tool lifecycle 不转换为 DSH tool call，避免重试层重复执行副作用工具。
- 完整能力矩阵见 `docs/tool-capability-matrix.md`。

### M7：配置、安全和可观测性（已完成）

任务：

1. 配置校验、默认值、版本兼容检查和启动诊断。
2. 结构化日志包含 request ID、conversation ID、耗时、退出码和事件计数。
3. 日志默认脱敏 Prompt、凭据、环境变量和本机隐私路径。
4. 限制并发进程数，增加背压和排队策略。
5. AGY 版本不兼容时给出明确提示。

验收标准：

- 一条诊断命令能检查 AGY 路径、版本、Agent 和最小调用。
- 日志审查不包含认证数据和完整敏感内容。

当前实现与验收结果：

- `Config` 增加 `minimumAgyVersion`、`maxConcurrent`、`maxQueue` 和 `queueTimeoutMs`，默认值分别为 `1.1.13`、`4`、`32` 和 `30000`。
- `npm run diagnose` 通过无模型调用的 `agy --version` 与 `agy agents` 检查；本机复测为 AGY `1.1.14`、Agent `deepseek-proxy`。
- `AgyConcurrencyLimiter` 提供有界 FIFO 队列、`QUEUE_FULL`、`QUEUE_TIMEOUT` 和排队期间的 `ABORTED` 错误。
- 日志通过白名单字段输出 request ID、conversation ID、耗时、退出码、队列等待时间和事件计数；Prompt、stderr、环境变量、可执行路径和凭据不进入日志记录。
- M7 诊断不执行最小模型请求，避免启动检查消耗 AGY 额度；“最小调用”保留为后续集成测试项。

### M8：测试、兼容性和性能（已完成）

测试矩阵：

| 类别 | 场景 |
|------|------|
| 单元 | 参数构造、NDJSON chunk、事件守卫、usage 映射 |
| 进程 | 正常、stderr、超时、取消、崩溃、路径缺失 |
| 集成 | DSH → Plugin → AGY 文本流 |
| 会话 | 新建、恢复、并发、删除、失效 ID |
| 安全 | 参数注入、日志脱敏、恶意输出、超长行 |
| 性能 | 首 Token 延迟、总耗时、内存、并发进程数 |

发布门槛：

- 单元和集成测试全部通过。
- 没有残留 AGY 子进程。
- 取消、超时、异常退出均可重复验证。
- 与 `deepseek-proxy` 的 Token 基线有对比记录。

当前实现与验收结果：

- Parser 拒绝超过 `maxEventLineLength` 的 NDJSON 行；Process Adapter 拒绝超过 `maxOutputBytes` 的 stdout/stderr，并映射为稳定错误。
- 增加 shell metacharacters、恶意超长输出、配置边界、版本诊断、并发和日志安全回归。
- 兼容性矩阵见 `docs/compatibility-matrix.md`；当前确认 Windows 11、Node.js `v24.18.0`、DSH SDK `0.1.0-rc.7`、AGY `1.1.13/1.1.14` 诊断和 `deepseek-proxy`。
- `npm run benchmark` 建立 Parser、serializer、limiter 的无额度性能基线，结果见 `docs/performance-baseline.md`。

### M9：打包与首个发布（发布准备完成，实际 publish 待确认）

任务：

1. 确定包名、许可证和版本策略。
2. 编写安装、配置、诊断、升级和卸载文档。
3. 建立 CI：类型检查、测试、构建和安全扫描。
4. 生成 changelog，发布 `0.1.0` 预览版。

验收标准：

- 全新 Windows 环境按 README 可完成安装和最小调用。
- 发布包不包含本机路径、日志、凭据或测试会话数据。

当前实现与发布边界：

- 已将 package version 固定为 `0.1.0`，新增 `CHANGELOG.md`、安装文档、发布检查清单和 GitHub Actions CI。
- CI 在 Windows runner 的 Node.js 20/24 上执行 typecheck、测试、打包预览和本地 benchmark；CI 不执行 AGY 真实请求，不消耗用户额度。
- 经用户确认，`package.json` 已切换为公开包配置，包名为 `dsh-agy-provider`；发布后以 npm 安装为主，GitHub 源码安装作为开发入口。

## 5. 风险与应对

| 风险 | 影响 | 应对 |
|------|------|------|
| DSH Provider API 处于变化期 | 插件无法加载或升级即破坏 | M1 锁版本，围绕适配层隔离变化 |
| AGY `stream-json` 缺少稳定 Schema | 解析在升级后失效 | 保存 fixtures、容忍未知字段、增加版本检查 |
| DSH 与 AGY 都是 Agent loop | 工具重复执行或行为不可预测 | 先文本模式，M6 明确唯一工具所有者 |
| AGY 会话恢复语义不明确 | 串话、上下文丢失或 Token 激增 | 实测 `--conversation`，每 Session 隔离并提供降级 |
| Windows 子进程无法及时终止 | 残留进程和资源泄漏 | AbortSignal、超时、退出等待及残留检查 |
| usage 事件多次出现 | Token 统计重复 | 以最终 `result.usage` 为准，checkpoint 仅作诊断 |
| CLI 登录或额度失效 | 请求失败 | 分类认证、额度、网络和模型错误并输出可操作提示 |

## 6. 推荐实施顺序

严格按 `M1 → M2 → M3 → M4` 完成最小闭环，再进入会话和工具能力。M1 是架构闸门：只有确认 DSH 的真实插件契约后，才开始编写 Provider 对接代码。

预计首个文本 MVP 需要约 5–8 个开发日；包含会话、工具、安全、测试和发布的 `0.1.0` 预计约 10–15 个开发日，具体取决于 DSH API 稳定性与 AGY 工具事件可观测程度。

## 7. 完成定义

项目达到 `0.1.0` 时必须满足：

- DSH 可安装、加载、配置并选择 AGY Provider。
- 文本流、取消、超时、错误和 usage 映射稳定。
- 会话隔离经过自动化测试。
- 工具能力边界明确且不会重复执行副作用。
- 文档能够让新环境独立完成安装和诊断。
- 无凭据、敏感日志或本机专属数据进入 Git 仓库和发布包。
