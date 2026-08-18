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

### M5 会话与上下文策略总结

- **状态：** complete
- 已验证 AGY 1.1.13 支持 `--conversation <id>` 和 `--continue`；不存在的 conversation ID 会 warning 后创建新 ID。
- 已决定 Provider 使用显式 `--conversation`，不使用全局 `--continue`，避免多个 DSH Session 串话。
- 待执行：实现映射、同 Session 串行锁、恢复失败完整上下文降级和测试。

### 阶段 9：M5 会话与上下文策略

- **状态：** complete
- 执行的操作：
  - 验证 `--conversation <id>` 恢复、`--continue` 最近会话和不存在 ID 的 warning/新建行为。
  - 实现 `SessionRegistry` 和 `InMemorySessionStore`，按 DSH `sessionId` 保存 AGY `conversation_id`。
  - 同一 Session 使用串行锁，不同 Session 可并发。
  - `sessionMode: resume` 仅发送上一轮 assistant 后的新 turn，并显式传递 `--conversation`。
  - resume 返回不同 conversation ID 时，丢弃该次输出并自动使用完整 DSH history 重试一次。
  - `sessionMode: full` 作为默认策略；进程重启后因内存映射丢失，自然使用完整 DSH history 创建新会话。
  - 完成真实 AGY 两轮恢复测试和完整历史 token 成本对照。
- 创建/修改的文件：
  - `src/session/store.ts`
  - `src/provider/agy.ts`
  - `src/provider/config.ts`
  - `src/provider/serialize.ts`
  - `src/agy/process.ts`
  - `src/agy/parser.ts`
  - `tests/session-store.test.mjs`
  - `tests/agy-provider.test.mjs`
  - `tests/process.test.mjs`
  - `tests/parser.test.mjs`
  - `tests/serialize.test.mjs`
  - `README.md`
  - `docs/development-plan.md`
  - `docs/dsh-provider-contract.md`

### 阶段 10：M6 工具能力边界

- **状态：** complete
- 结果：V1 采用 AGY 自治 Agent + DSH 文本外壳；DSH tools 显式拒绝，AGY 内部工具不转换为 DSH tool call。
- 执行的操作：
  - 使用只读 `list_dir`/`run_command` 指令采样 AGY headless 工具行为。
  - 观察到真实 `step_type=tool` 的 `ACTIVE → ERROR` 生命周期，以及后续 `checkpoint`、`agent_response` 和 `error_message`。
  - 增加工具/权限事件分类器；权限请求会主动终止 AGY 并返回 `PERMISSION_REQUIRED`。
  - 固化 DSH/AGY 工具能力矩阵和唯一执行所有者规则。
  - 保留 DSH `tools` 的 `UNSUPPORTED_TOOLS` 防线，避免双重 Agent loop。
- 创建/修改的文件：
  - `src/agy/parser.ts`
  - `src/provider/agy.ts`
  - `tests/parser.test.mjs`
  - `tests/agy-provider.test.mjs`
  - `docs/tool-capability-matrix.md`
  - `README.md`
  - `docs/dsh-provider-contract.md`

### 阶段 11：M7 配置、安全和可观测性

- **状态：** complete
- 执行的操作：
  - 增加 `minimumAgyVersion`、`maxConcurrent`、`maxQueue` 和 `queueTimeoutMs` 配置及 Schemastery 校验默认值。
  - 实现 `npm run diagnose`，使用 `agy --version` 和 `agy agents` 检查本机路径、版本和 Agent；不触发模型或工具。
  - 实现 `AgyConcurrencyLimiter`，提供 FIFO 排队、队列上限、排队超时和 AbortSignal 取消。
  - 通过 Cordis logger 输出 request ID、conversation ID、耗时、退出码、队列等待时间和事件计数。
  - 使用日志白名单和 `redactText()`，不输出 Prompt、stderr、环境变量、AGY 路径或凭据。
- 创建/修改的文件：
  - `src/agy/diagnostics.ts`
  - `src/agy/limiter.ts`
  - `src/agy/log.ts`
  - `src/agy/redact.ts`
  - `src/provider/agy.ts`
  - `src/provider/config.ts`
  - `src/index.ts`
  - `scripts/diagnose.mjs`
  - `tests/config.test.mjs`
  - `tests/diagnostics.test.mjs`
  - `tests/limiter.test.mjs`
  - `tests/observability.test.mjs`
  - M7 文档与进度记录

### 阶段 12：M8 测试、兼容性和性能

- **状态：** complete
- 执行的操作：
  - 为 Parser 增加 `maxLineLength` 和有界错误原文；超长 NDJSON 行返回 `LINE_TOO_LONG`。
  - 为 Process Adapter 增加 stdout/stderr 捕获上限；超限返回 `output-limit`，Provider 映射为 `AGY_OUTPUT_LIMIT`。
  - 增加 shell metacharacters 参数注入、恶意超长输出、配置边界和进程生命周期回归测试。
  - 建立 `docs/compatibility-matrix.md`，记录 Windows、Node.js、DSH SDK、AGY 1.1.13/1.1.14 和事件处理范围。
  - 增加 `npm run benchmark`，记录 Parser、serializer 和 limiter 的无额度性能基线。
- 创建/修改的文件：
  - `src/agy/parser.ts`
  - `src/agy/process.ts`
  - `src/provider/agy.ts`
  - `src/provider/config.ts`
  - `scripts/benchmark.mjs`
  - `docs/compatibility-matrix.md`
  - `docs/performance-baseline.md`
  - `tests/parser.test.mjs`
  - `tests/process.test.mjs`
  - `tests/agy-provider.test.mjs`

### 下一阶段：M9 打包并发布 `0.1.0`

- **状态：** in_progress
- 已完成：版本号、changelog、安装/诊断/升级文档、发布检查清单、Windows Node.js 20/24 CI 和包内容预览。
- 待用户确认：npm 包名、公开/私有可见性及 publish 权限；在确认前不执行 npm publish。

## 测试结果

| 测试 | 输入 | 预期结果 | 实际结果 | 状态 |
|------|------|---------|---------|------|
| AGY Agent 枚举 | `agy agents` | 出现 `deepseek-proxy` | 已出现 | 通过 |
| AGY stream-json | 最小 `123` Prompt | 逐行 JSON 并成功结束 | `SUCCESS`，返回 `123` | 通过 |
| Node.js spawn | 直接启动 `agy.exe` | 退出码 0、无解析错误 | 5 个事件、0 个解析错误 | 通过 |
| 项目配置 | `npm run typecheck && npm run build && npm test` | 配置有效 | 全部退出码 0，28 个测试通过 | 通过 |
| M7 配置 Schema | `Config({})` 与非法 `maxConcurrent` | 默认值生效、非法值拒绝 | 默认 `1.1.13/4/32/30000`，非法值抛 `ValidationError` | 通过 |
| M7 诊断命令 | `npm run diagnose` | 只读检查 AGY 版本和 Agent | AGY `1.1.14`、`deepseek-proxy`、最低版本满足 | 通过 |
| M7 并发与日志 | 38 个自动化测试 | 队列、取消、脱敏和计数稳定 | `npm test` 全部通过 | 通过 |
| M8 安全回归 | 超长 NDJSON、stdout 上限、shell metacharacters | 有界失败且不改变 argv 结构 | `npm test` 42 个测试通过 | 通过 |
| M8 性能基线 | `npm run benchmark` | 不消耗额度并输出可复测指标 | Parser 约 768k events/s；serializer/limiter 基线已记录 | 通过 |
| M9 包预览 | `npm pack --dry-run` | 仅包含发布所需文件 | `lib`、`cordis.patch.yml`、README 和 package metadata 可见 | 通过 |
| M9 CI 配置 | `.github/workflows/ci.yml` | Node.js 20/24 Windows 验证 | 已创建 workflow；CI 不触发真实 AGY 请求 | 依赖和 Node 20 测试入口均已修复；第三轮 CI 两个 job 全部通过 |
| M9 CI 重跑 | GitHub Actions run `32112054709` | Node.js 20/24 verify + benchmark | 两个矩阵 job 全部成功 | 通过 |
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
| M5 same-session resume | 同一 `sessionId` 两轮真实 AGY | 第二轮恢复首轮上下文 | 两轮均返回 `7\n`，conversation ID 一致 | 通过 |
| M5 full/resume cost | 相同两轮上下文的 usage 对照 | 选择更可控默认策略 | full `4490` vs resume 第二轮 `9385` input tokens | 通过 |
| M5 concurrency | 同/不同 Session Fake runner | 同 Session 不重入，不同 Session 可并发 | 26 个测试全部通过 | 通过 |
| M6 tool lifecycle | 真实 AGY `step_type=tool` 样本 | 工具事件不进入 DSH tool loop | 已观察 `ACTIVE → ERROR`，矩阵已固化 | 通过 |
| M6 permission guard | Fake `permission_request` event | headless 不无限等待 | 返回 `PERMISSION_REQUIRED`，28 个测试通过 | 通过 |
| AGY conversation resume | 首轮创建 ID，随后 `--conversation <id>` | 第二轮保留首轮上下文 | 返回首轮数字 `1` | 通过 |
| AGY continue | `--continue` | 继续最近会话 | conversation ID 与上一轮一致，返回 `3` | 通过 |
| AGY invalid conversation | 不存在的 `--conversation <id>` | warning 并创建新会话 | 已观察 warning 和新 conversation ID | 通过 |

## 错误日志

| 时间戳 | 错误 | 尝试次数 | 解决方案 |
|--------|------|---------|---------|
| 2026-08-18 | `agy agents --output-format json` 参数不支持 | 1 | 使用 `agy agents` |
| 2026-08-18 | GitHub URL credential helper 指向已删除的安装路径 | 1 | 为本仓库设置当前 Scoop `gh.exe` helper，远端验证通过 |
| 2026-08-18 | Parser fixture 的单引号字符串转义导致 JS 语法错误 | 1 | 改用 template literal，随后 19 个测试全部通过 |
| 2026-08-18 | `sessionMode` schema 的宽泛 string 与字面量联合类型不兼容 | 1 | 使用 `z.union(['resume', 'full'] as const)` |
| 2026-08-18 | exact optional property 不允许显式传 `system: undefined` | 1 | 序列化 turn 时省略可选字段 |
| 2026-08-18 | AGY headless 工具请求未稳定暴露完整 permission payload | 2 | 不做工具桥接；权限事件分类后快速失败，等待 M7 再接入诊断 |
| 2026-08-18 | GitHub Actions `npm ci` 因 `@deepseek-ai/dsh-timeout` peer 版本冲突失败 | 1 | 已将 timeout 对齐到 `^0.1.0-rc.7`，补齐 DSH peer dependencies，并用干净 `npm ci` 验证 |
| 2026-08-18 | GitHub Actions Node 20 将 `tests/*.test.mjs` 作为字面路径，导致测试入口失败 | 1 | 新增 `scripts/run-tests.mjs` 动态枚举测试文件，避免依赖 Shell glob 展开；本地 `npm run verify` 通过 |

## 五问重启检查

| 问题 | 答案 |
|------|------|
| 我在哪里？ | M9 发布准备已完成，npm publish 仍等待包名/权限确认 |
| 我要去哪里？ | 在用户确认发布边界后执行 npm 发布或保持 GitHub 私有预览 |
| 目标是什么？ | 建立本地与 GitHub 的 `dsh-agy-provider` 项目并固化开发计划 |
| 我学到了什么？ | 见 `findings.md` |
| 我做了什么？ | 完成 M1–M9 发布准备、实现、真实验证、工具边界、诊断安全和性能记录，见上方记录 |

---
*每个阶段完成后或遇到错误时更新此文件*
