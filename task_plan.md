# 任务计划：创建 dsh-agy-provider 项目与开发路线

## 目标

在 `C:\Users\Jie\Projects\dsh-agy-provider` 建立本地 Git 项目和同名 GitHub 仓库，并形成可执行、可验收的完整开发计划。

## 当前阶段

阶段 5：M7 配置、安全和可观测性

## 各阶段

### 阶段 1：需求与环境确认

- [x] 确认项目名称为 `dsh-agy-provider`
- [x] 确认目标目录不存在且父目录可用
- [x] 确认 Git、Node、npm、AGY 环境
- [x] 确认 GitHub 登录账号及仓库权限
- **状态：** complete

### 阶段 2：规划与结构

- [x] 建立项目目录结构
- [x] 创建 `task_plan.md`、`findings.md` 和 `progress.md`
- [x] 创建 README、基线记录和详细开发计划
- [x] 明确目标架构、范围边界和风险
- **状态：** complete

### 阶段 3：项目骨架

- [x] 创建 TypeScript 最小骨架
- [x] 创建 AGY、Provider、Session 和测试目录
- [x] 验证 JSON、TypeScript 配置和最小类型检查
- **状态：** complete

### 阶段 4：Git 与 GitHub 发布

- [x] 将暂存项目移动到目标目录
- [x] 初始化 Git 仓库并创建初始提交
- [x] 创建私有 GitHub 仓库 `darkings/dsh-agy-provider`
- [x] 推送默认分支并验证远程状态
- **状态：** complete

### 阶段 5：产品开发

- [x] M1：确认 DSH Provider 契约
  - [x] 找到官方仓库与当前基线 revision
  - [x] 确认 `LlmAdapter`、`GenerateOptions` 和 `StreamChunk`
  - [x] 确认 bundle/package/`cordis.patch.yml` 发布形态
  - [x] 创建并加载 Mock Provider
  - [x] 用官方运行时完成 Mock Provider smoke test
- **状态：** complete
- [x] M2：实现 AGY Process Adapter
  - [x] 实现路径发现和参数构造
  - [x] 实现 stdout/stderr、退出码和超时
  - [x] 实现 AbortSignal 取消与 Windows 隐藏窗口
  - [x] 增加 Fake process 测试
- **状态：** complete
- [x] M3：实现 stream-json 增量解析器
  - [x] 处理任意 chunk 边界和 CRLF
  - [x] 验证 JSON 对象与 `event` 字段
  - [x] 识别已知事件并容忍未知事件
  - [x] 增加 malformed line 和 fixture 测试
- [x] M4：完成 DSH 文本 Provider MVP
  - [x] 将 DSH system/messages 确定性序列化为 AGY Prompt
  - [x] 将 `text_delta` 和 `result.response` 映射为 DSH 文本流
  - [x] 映射 usage、退出码、超时、取消、解析错误和 AGY 状态
  - [x] 完成 Fake runner、官方 runtime 和真实 AGY 端到端测试
- [x] M5：实现会话和上下文策略
  - [x] 验证 `--conversation`、`--continue` 和不存在会话的降级行为
  - [x] 实现 DSH Session → AGY Conversation 内存映射
  - [x] 实现同一 Session 串行锁和跨 Session 并发
  - [x] 实现恢复失败时的完整上下文重试
  - [x] 增加会话新建、恢复、删除、崩溃/降级测试
- [x] M6：确认并实现工具能力边界
  - [x] 采集 AGY tool step、错误和权限相关事件样本
  - [x] 建立 DSH/AGY 工具能力矩阵
  - [x] 决定 V1 采用 AGY 自治 Agent + DSH 文本外壳
  - [x] 防止 DSH 与 AGY 重复执行工具
  - [x] 对 headless 权限请求返回稳定错误并终止子进程
- [x] M7：配置、安全和可观测性
  - [x] 增加最低 AGY 版本、并发、队列和超时配置默认值
  - [x] 增加 `npm run diagnose` 只读版本/Agent 检查
  - [x] 增加有界 FIFO 队列、AbortSignal 取消和稳定错误码
  - [x] 增加 request ID、conversation ID、耗时、退出码和事件计数日志
  - [x] 增加凭据、环境变量、用户路径和 Prompt 白名单脱敏防线
- [ ] M8：测试、兼容性和性能
- [ ] M9：打包并发布 `0.1.0`
- **状态：** in_progress

## 关键问题

1. DSH 目标版本和 Provider SDK 的真实接口是什么？
2. AGY 工具与 DSH 工具由哪一层拥有执行权？
3. `--conversation` 是否适合可靠映射 DSH Session？
4. AGY `stream-json` 在错误、权限和工具调用时会产生哪些事件？

## 已做决策

| 决策 | 理由 |
|------|------|
| 项目命名为 `dsh-agy-provider` | 目标是把 AGY 暴露为 DSH Provider |
| 最终链路保留 AGY | 用户目标是使用 AGY 额度 |
| 第一版以 Windows/AGY 1.1.13 为基线 | 已完成实机验证，可控制初始范围 |
| 默认创建私有 GitHub 仓库 | 用户未指定可见性，优先避免意外公开 |
| 先确认 DSH API 再写适配代码 | 避免把伪 API 固化进项目 |
| 文本 MVP 先于工具桥接 | 降低双 Agent loop 的副作用风险 |
| Provider 适配基于 `@deepseek-ai/dsh-llm` 的 `LlmAdapter` | 官方契约明确要求适配器输出 `StreamChunk` |
| 插件按 bundle 发布 | 官方 `dsh plugin` 只会激活声明 `dsh.bundle` 的 npm 包 |
| 默认使用 `sessionMode: full` | 实测两轮样本中完整 DSH 历史的 `inputTokens=4490`，AGY resume 第二轮为 `9385`；DSH history 是当前更可控的 quota 成本 |
| `sessionMode: resume` 保留为显式选项 | AGY conversation 能保留上下文，但 `--continue` 会按最近会话选择，不适合多 Session |
| V1 由 AGY 独占工具执行 | DSH `tools` 与 AGY 内置工具可能形成双 Agent loop；Provider 拒绝 DSH tools，AGY 工具事件不转换为 DSH tool call |
| headless 权限请求快速失败 | 没有可交互审批 UI 时等待会造成无限挂起；返回 `PERMISSION_REQUIRED` 并终止 AGY |
| M7 诊断不消耗额度 | 启动检查只读取 `--version` 与 `agents`；模型最小调用留给后续集成测试 |
| M7 默认有界并发 | 每个 Adapter 默认最多 4 个活动 AGY 进程，最多排队 32 个请求，排队超时 30 秒 |

## 遇到的错误

| 错误 | 尝试次数 | 解决方案 |
|------|---------|---------|
| `agy agents --output-format json` 不被 1.1.13 支持 | 1 | 使用 `agy agents`；仅 print 模式使用 `--output-format` |
| GitHub URL 专用 credential helper 指向已失效路径 | 1 | 仅在本仓库覆盖为 `D:/Applications/Scoop/shims/gh.exe` 并重新验证远程读取 |

## 备注

- 产品里程碑和验收标准详见 `docs/development-plan.md`。
- 完成阶段后更新状态：pending → in_progress → complete。
- 外部内容只记录到 `findings.md`，不写入本计划。
