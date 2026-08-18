# 进度日志

## 会话：2026-08-18

### 阶段 1：需求与环境确认

- **状态：** complete
- 执行的操作：
  - 确认项目目标与名称。
  - 确认目标目录尚不存在。
  - 检查 Git、Node.js、npm、AGY 和 GitHub CLI。
  - 确认 GitHub 活跃账号为 `darkings`。
- 创建/修改的文件：
  - 无。

### 阶段 2：规划与结构

- **状态：** complete
- 执行的操作：
  - 创建项目骨架目录。
  - 编写详细里程碑、验收标准和风险清单。
  - 固化已验证的 AGY 基线。
- 创建/修改的文件：
  - `README.md`
  - `docs/development-plan.md`
  - `docs/verified-baseline.md`
  - `task_plan.md`
  - `findings.md`
  - `progress.md`

### 阶段 3：项目骨架

- **状态：** complete
- 执行的操作：
  - 创建 TypeScript 最小项目配置和模块目录。
  - 安装开发依赖并生成 `package-lock.json`。
  - 完成 typecheck、build 和空测试基线。
- 创建/修改的文件：
  - `package.json`
  - `package-lock.json`
  - `tsconfig.json`
  - `src/index.ts`
  - 各模块 README。
  - `.gitattributes`

### 阶段 4：Git 与 GitHub 发布

- **状态：** complete
- 执行的操作：
  - 将项目移动到 `C:\Users\Jie\Projects\dsh-agy-provider`。
  - 初始化 `main` 分支并创建初始提交。
  - 创建私有仓库 `darkings/dsh-agy-provider`。
  - 推送 `main` 并确认远端 ref 与本地提交一致。
  - 在本仓库覆盖失效的 GitHub credential helper 路径。
- 创建/修改的文件：
  - `.git/config`（仅本地，不提交）

### 阶段 5：M1 Provider 契约确认

- **状态：** complete
- 执行的操作：
  - 检查本机是否安装 DSH CLI；当前没有发现 `dsh` 命令。
  - 克隆官方 `deepseek-ai/deepseek-harness` 只读 checkout。
  - 阅读官方 LLM adapter、插件教程、bundle 发布和架构文档。
  - 确认 `LlmAdapter`、`StreamChunk`、`GenerateOptions` 及 bundle manifest 契约。
  - 实现默认关闭的 `MockAdapter`、bundle manifest 和契约文档。
  - 用官方 `Context + LlmRuntime` 完成模型发现与流式 smoke test。
- 创建/修改的文件：
  - `src/provider/mock.ts`
  - `cordis.patch.yml`
  - `docs/dsh-provider-contract.md`
  - `tests/mock-provider.test.mjs`
  - `tests/dsh-runtime-smoke.test.mjs`

### 阶段 6：M2 AGY Process Adapter

- **状态：** complete
- 执行的操作：
  - 实现 AGY 路径发现、参数构造和无 Shell spawn。
  - 实现 stdout 行回调、stderr、退出码、signal、超时和 AbortSignal。
  - 使用 Node 子进程作为 Fake process 完成生命周期测试。
  - 使用正式 `runAgyProcess()` 启动本机 AGY 完成端到端最小请求。
- 创建/修改的文件：
  - `src/agy/process.ts`
  - `tests/process.test.mjs`
  - `src/agy/README.md`

### 阶段 7：M3 stream-json 增量解析器

- **状态：** complete
- 执行的操作：
  - 实现支持任意 stdout chunk 边界的增量 NDJSON 解析。
  - 处理 CRLF、空行、尾部未换行数据和物理行号。
  - 验证对象 envelope 与非空 `event` 字段。
  - 保留未知事件，避免 AGY 增加事件类型时解析器过早失败。
  - 增加文本增量、最终响应、状态和 usage 提取辅助函数。
  - 增加 malformed JSON、非法 envelope、异步 chunk 流和 fixture 测试。
- 创建/修改的文件：
  - `src/agy/parser.ts`
  - `src/agy/README.md`
  - `tests/parser.test.mjs`
  - `tests/process.test.mjs`

### 下一阶段：M4 DSH 文本 Provider MVP

- **状态：** complete
- 执行结果：已实现 `AgyAdapter extends LlmAdapter`，串联消息序列化、AGY 进程、解析器和 DSH `StreamChunk`。

### 阶段 8：M4 DSH 文本 Provider MVP

- **状态：** complete
- 执行的操作：
  - 实现 `system/messages` 到固定 role marker Prompt 的确定性序列化。
  - 实现 `step_update.text_delta` 实时输出和 `result.response` 补齐逻辑。
  - 以最终 usage 为准映射 DSH token usage，兼容 AGY snake/camel case 字段。
  - 将 AGY 进程失败、超时、取消、解析失败和非成功状态转换为稳定 `LlmError.code`。
  - 明确拒绝 DSH tools、图像、采样控制、reasoning 和 stop 等文本 MVP 未支持能力。
  - 用 Fake runner、官方 `LlmRuntime` 和真实本机 AGY 完成验证。
- 创建/修改的文件：
  - `src/provider/agy.ts`
  - `src/provider/config.ts`
  - `src/provider/serialize.ts`
  - `src/provider/mock.ts`
  - `src/index.ts`
  - `cordis.patch.yml`
  - `tests/agy-provider.test.mjs`
  - `tests/serialize.test.mjs`
  - `README.md`
  - `docs/dsh-provider-contract.md`

### 下一阶段：M5 会话与上下文策略

- **状态：** pending
- 计划：验证 AGY `--conversation`/`--continue`，建立 DSH Session 与 AGY Conversation 的隔离映射，并定义不可恢复时的降级策略。

## 测试结果

| 测试 | 输入 | 预期结果 | 实际结果 | 状态 |
|------|------|---------|---------|------|
| AGY Agent 枚举 | `agy agents` | 出现 `deepseek-proxy` | 已出现 | 通过 |
| AGY stream-json | 最小 `123` Prompt | 逐行 JSON 并成功结束 | `SUCCESS`，返回 `123` | 通过 |
| Node.js spawn | 直接启动 `agy.exe` | 退出码 0、无解析错误 | 5 个事件、0 个解析错误 | 通过 |
| 项目配置 | `npm run typecheck && npm run build && npm test` | 配置有效 | 全部退出码 0，19 个测试通过 | 通过 |
| GitHub 发布 | 创建并推送仓库 | 远程默认分支可访问 | 私有仓库已创建，默认分支为 `main` | 通过 |
| 远端 ref | `git ls-remote --heads origin main` | 与本地提交一致 | 已返回远端 `main` commit | 通过 |
| 官方 DSH 源码 | `deepseek-ai/deepseek-harness` | 找到 Provider 与 bundle 契约 | revision `99f6f02` 已读取 | 通过 |
| 本机 DSH CLI | `Get-Command dsh` | 能直接运行 DSH | 未发现命令 | 信息 |
| Mock Provider 官方 runtime | `Context + LlmRuntime` | 可发现模型并完成 stream | 3 个测试全部通过 | 通过 |
| AGY Process Adapter | `runAgyProcess()` + 最小 prompt | AGY 成功返回 stream-json | 5 行事件、`123`、exit 0 | 通过 |
| AGY Parser | chunk/CRLF/malformed/unknown event fixture | 增量解析和 envelope 校验正确 | 5 个 parser 测试通过 | 通过 |
| Process cancellation | `AbortController` + Fake process | 子进程可被取消且返回 aborted | 测试通过 | 通过 |
| AgyAdapter Fake runner | 事件 fixture + DSH request | text/response/usage/finish 映射正确 | 3 个 adapter 测试通过 | 通过 |
| AgyAdapter official runtime | `Context + LlmRuntime` | 注册路由并完成文本流 | 测试通过 | 通过 |
| AgyAdapter real AGY | 本机 AGY `1.1.13` + 最小 Prompt | 返回 `123` 和完整 StreamChunk 生命周期 | `123\n`、exit 0、finish stop | 通过 |

## 错误日志

| 时间戳 | 错误 | 尝试次数 | 解决方案 |
|--------|------|---------|---------|
| 2026-08-18 | `agy agents --output-format json` 参数不支持 | 1 | 使用 `agy agents` |
| 2026-08-18 | GitHub URL credential helper 指向已删除的安装路径 | 1 | 为本仓库设置当前 Scoop `gh.exe` helper，远端验证通过 |
| 2026-08-18 | Parser fixture 的单引号字符串转义导致 JS 语法错误 | 1 | 改用 template literal，随后 19 个测试全部通过 |

## 五问重启检查

| 问题 | 答案 |
|------|------|
| 我在哪里？ | 产品阶段 M4 已完成，准备进入 M5：会话与上下文策略 |
| 我要去哪里？ | 验证 `--conversation`/`--continue`，建立 Session 隔离映射 |
| 目标是什么？ | 建立本地与 GitHub 的 `dsh-agy-provider` 项目并固化开发计划 |
| 我学到了什么？ | 见 `findings.md` |
| 我做了什么？ | 完成 M1–M4 的实现和测试，见上方记录 |

---
*每个阶段完成后或遇到错误时更新此文件*
