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
