# 发现与决策

## 需求

- 在 `C:\Users\Jie\Projects` 创建 DSH 插件项目文件夹。
- 在 GitHub 创建对应仓库。
- 详细列出后续开发计划。
- 插件的核心目标是让 DSH 使用 AGY 账号额度。

## 研究发现

- GitHub CLI 已登录账号 `darkings`，具备 `repo` 权限。
- 已创建私有仓库 `https://github.com/darkings/dsh-agy-provider`，默认分支为 `main`。
- DSH 官方仓库为 `deepseek-ai/deepseek-harness`；本次读取的源码 revision 为 `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`。
- 官方 LLM seam 位于 `@deepseek-ai/dsh-llm`：插件导出 `inject = ['llm']`，继承 `LlmAdapter`，通过 `ctx.llm.registerAdapter(['route'], adapter)` 注册。
- `LlmAdapter` 的最小实现只需 `stream(options): AsyncIterable<StreamChunk>`；可选实现 `providerInfo()`、`listModels()`、`resolveModel()` 和 `providerRetryPolicy()`。
- `GenerateOptions` 包含 `provider`、`model`、`messages`、`system`、`tools`、`reasoningEffort`、`signal`、`sessionId` 和 `purpose` 等字段。
- `StreamChunk` 的官方协议包括 `block-start`、`text-delta`、`reasoning-delta`、`tool-call-delta`、`block-end`、`usage` 和终止性的 `finish`。
- 官方可安装插件是 bundle，而非单个裸 Cordis 模块：`package.json` 中声明 `dsh.bundle.patch`，`cordis.patch.yml` 用包名插入插件行。
- 从 GitHub 安装 TypeScript 插件需要 `prepare` 自包含构建；pnpm ≥10 还需要用户显式允许该包的构建脚本。
- 官方文档建议 LLM 适配器使用稳定的 `LlmError` code，并将 `options.signal` 传给上游请求。
- Mock Provider 已通过 `Context + LlmRuntime` 官方 runtime smoke test：模型目录可发现，文本、usage、finish 分片可完整消费。
- 正式 `runAgyProcess()` 已在本机启动 `C:\Users\Jie\.local\bin\agy.exe`：`deepseek-proxy` 生效，5 行 NDJSON，`result.status=SUCCESS`，返回 `123`，退出码为 0，无 stderr。
- M2 进程层将 stdout 以完整行回调给上层，保存 `stdoutLines`，并独立记录 stderr、退出码、signal、termination 和耗时；默认 `shell=false`、`windowsHide=true`。
- M3 解析器 `AgyStreamParser` 支持任意 chunk 边界、CRLF、空行和末尾无换行数据；对非法 JSON 提供物理行号，对未知 `event` 保持透传。
- M3 已验证 `textDeltaOf()`、`responseOf()`、`statusOf()` 和 `usageOf()` 可从已观察的 AGY envelope 提取稳定字段；解析器不限制未来事件类型。
- 当前自动化验证共 13 个测试：Mock Provider 3 个、Parser 5 个、Process 5 个；`npm run typecheck`、`npm test` 和 `npm pack --dry-run` 均通过。
- M4 `AgyAdapter` 已通过 Fake runner 和官方 `Context + LlmRuntime`；真实本机 AGY 端到端返回 `123\n`，分片顺序为 `block-start → text-delta* → block-end → usage → finish`。
- 真实 M4 请求的 AGY usage 包含 `inputTokens=4312`、`outputTokens=315` 和 `cacheReadTokens=0`；最终 usage 只发一次，避免 checkpoint 重复累计。
- 当前自动化验证共 19 个测试：AgyAdapter 4 个、Mock Provider 3 个、Parser 5 个、Process 5 个、Serializer 2 个；`npm run typecheck`、`npm test` 和 `npm pack --dry-run` 均通过。
- M4 文本 MVP 对 DSH tools、图像、采样参数、reasoning effort、stop 和 maxTokens 显式返回稳定错误码，避免工具所有权或参数语义被静默改变。
- 本机 Git、Node.js、npm 和 AGY 均可执行。
- `agy 1.1.13` 能识别 `deepseek-proxy`。
- Node.js 可无 Shell 启动 `agy.exe` 并实时解析 `stream-json`。
- 已观察 `init`、`step_update`、`result` 事件。
- 最终 `result.usage` 可作为本轮 Token 统计；中间 checkpoint 也可能包含 usage。
- `agy agents --output-format json` 在本机版本不可用。
- `agy --help` 显示 `--conversation`、`--continue`（短参数 `-c`）均为 CLI 会话选项；`--conversation` 接收显式 conversation ID。
- 使用不存在的 `--conversation __dsh_m5_invalid_probe__` 时，AGY 输出 `warning: conversation "..." not found`，随后创建新的 `init.conversation_id` 并正常完成请求。
- 使用显式 conversation ID 连续两轮请求时，第二轮 `init.conversation_id` 与第一轮一致，并能回答第一轮上下文中的数字；`--continue` 也恢复同一最近会话。
- 多 DSH Session 不能使用 `--continue`，因为它按最近会话选择；Provider M5 采用 DSH Session → 显式 AGY conversation ID 映射，并为每个 Session 加串行锁。
- `AgyAdapter` 的 `sessionMode: resume` 首轮记录 `init.conversation_id`，后续只序列化上次 assistant 之后的新 turn；恢复 ID 失效或返回不同 ID 时自动完整历史重试一次。
- `SessionRegistry` 使用进程内 `InMemorySessionStore`；插件进程重启后不复用未知旧 ID，而是依靠 DSH 提供的完整 messages 创建新的 AGY conversation。
- 真实 M5 两轮验证中，同一 DSH Session 两轮均返回 `7\n`，证明显式 `--conversation` 恢复了首轮上下文。
- 相同两轮样本的 quota 对照：`sessionMode: full` 的完整 DSH history 请求 `inputTokens=4490`；`sessionMode: resume` 的第二轮 `inputTokens=9385`。因此默认设为 `full`，resume 作为可选模式，后续长会话仍需持续测量。
- M5 自动化测试共 26 个，覆盖 Session store、锁、full/resume Prompt、conversation 参数、恢复失败降级和官方 runtime 回归。
- M6 一次真实 headless `list_dir` 采样出现 `step_type=tool`、`state=ACTIVE`，随后同一 tool step 为 `state=ERROR`，之后出现 `checkpoint`、`agent_response` 和 `error_message`；完整 `tool_info`/permission payload 未稳定暴露。
- 另一只读工具采样在默认权限模式下只输出 user step 后等待到超时，证明 headless 模式不能依赖交互式权限流程自行完成。
- M6 决定 V1 由 AGY 独占工具执行：Provider 拒绝 DSH `tools`，只解析并忽略 AGY 内部 tool lifecycle，不生成 DSH `tool-call-delta`。
- M6 增加 `isToolEvent()`、`isPermissionEvent()` 和 `PERMISSION_REQUIRED` 快速失败路径；当前自动化测试共 28 个。
- M7 复测发现本机 AGY 已从 M0 记录的 `1.1.13` 更新为 `1.1.14`；`deepseek-proxy` Agent 仍可通过 `agy agents` 发现，最低兼容版本默认保留为 `1.1.13`。
- `diagnoseAgy()` 只需要 `agy --version` 和 `agy agents`，可以在不消耗模型额度的前提下完成路径、版本和 Agent 检查；`npm run diagnose` 已在本机通过。
- `AgyConcurrencyLimiter` 为每个 Adapter 实例默认限制 4 个活动 AGY 进程、32 个排队请求和 30 秒排队超时；满队列、排队超时和排队取消分别映射为 `QUEUE_FULL`、`QUEUE_TIMEOUT` 和 `ABORTED`。
- M7 日志采用白名单字段，包含 request ID、conversation ID、duration、exit code、queue wait 和事件计数；Prompt、stderr、环境变量、AGY 路径和凭据不进入日志。
- Cordis `ctx.logger('dsh-agy-provider')` 可接收脱敏 JSON 生命周期记录，logger 自身抛错不会影响 Provider 请求。
- M7 自动化验证共 38 个测试，覆盖配置默认值/校验、版本解析、Agent 检查、脱敏、并发队列、Provider 计数和回归场景。
- M8 为 Parser 增加单行长度上限和截断错误原文，为 Process Adapter 增加 stdout/stderr 捕获上限；超长 NDJSON 返回 `LINE_TOO_LONG`，进程输出超限返回 `AGY_OUTPUT_LIMIT`。
- M8 使用 shell metacharacters 作为 Prompt fixture 验证参数仍保持单独 argv，不经过 Shell；真实 Node 子进程的超限终止测试通过。
- M8 当前兼容性矩阵确认 Windows 11、Node.js `v24.18.0`、DSH SDK `0.1.0-rc.7`、AGY `1.1.13/1.1.14` 诊断和 `deepseek-proxy`。
- M8 无额度 benchmark 结果：20,000 个 Parser 事件约 26.047 ms（约 767,852 events/s），5,000 次 serializer 约 2.034 ms，5,000 次 limiter acquire/release 约 1.076 ms；该数据只用于本机趋势比较。
- M8 自动化验证共 42 个测试，全部通过。
- M9 将版本固定为 `0.1.0`，包仍为 `private: true`；`npm pack --dry-run` 只显示 `lib`、`cordis.patch.yml`、README 和 package metadata。
- M9 CI 使用 Windows runner 和 Node.js 20/24，只执行本地 typecheck/test/pack/benchmark，不依赖 AGY 登录，也不会消耗用户额度。
- 真正 npm publish 需要额外确认包名、可见性和账号权限，因此本阶段只完成 GitHub 源码安装与预览包准备。
- GitHub Actions 首次失败不是代码问题，而是 CI 的干净 npm 环境正确暴露了 peer 依赖漂移：`@deepseek-ai/dsh-llm@0.1.0-rc.7` 要求 timeout `^0.1.0-rc.7`，项目原先锁定了 `0.0.1-rc.1`。已补齐 `dsh-attachment`、`dsh-brand`、`dsh-invariants` 和新 timeout 版本，干净 `npm ci` 已通过。
- GitHub Actions 第二次只剩 Node 20 测试入口差异：Node 20 不展开 `node --test tests/*.test.mjs` 的 glob。已改为 `scripts/run-tests.mjs` 动态枚举 `.test.mjs` 文件，Node 24 本地验证通过，等待第三轮 CI 确认 Node 20。

## 技术决策

| 决策 | 理由 |
|------|------|
| 保留 AGY CLI | 额度和认证入口属于 AGY |
| 用 `spawn()` 参数数组 | 避免 Shell 注入并支持流式 stdout |
| 使用分层适配器 | 隔离 DSH API 与 AGY CLI 的变化 |
| 首版先支持文本 | 工具所有权和事件协议尚未确认 |
| GitHub 仓库默认私有 | 避免在未确定许可证和发布策略前公开 |

## 遇到的问题

| 问题 | 解决方案 |
|------|---------|
| DSH Provider API 未实机确认 | 将 API 契约验证设为 M1 架构闸门 |
| AGY Agent 列表没有 JSON 输出 | 使用文本列表，并在代码中做兼容处理或仅用于诊断 |
| DSH 与 AGY 都可能执行工具 | M6 建立能力矩阵，确保唯一执行所有者 |
| 全局 GitHub URL credential helper 指向旧安装路径 | 在本仓库本地配置中覆盖为当前 Scoop `gh.exe`；未修改全局配置 |
| npm 中的 DSH 相关包版本并不完全同步 | 以官方仓库 revision 和发布包元数据分别记录，最终依赖版本需在 M1 smoke test 决定 |
| 第一次 smoke 夹具给函数赋值只读 `name` 属性失败 | 改用官方支持的 object plugin 形态，测试通过 |
| Parser fixture 使用单引号字符串表达 JSON 片段时出现 JS 语法错误 | 改用 template literal 表达跨 chunk fixture，测试通过 |

## 资源

- 本机 AGY：`C:\Users\Jie\.local\bin\agy.exe`
- 详细计划：`docs/development-plan.md`
- 验证基线：`docs/verified-baseline.md`

## 视觉/浏览器发现

- 本任务没有使用视觉或浏览器材料。

---
*每执行2次查看/浏览器/搜索操作后更新此文件*
*防止视觉信息丢失*
