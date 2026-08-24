# 兼容性矩阵

## 已验证组合

| 组件 | 版本/环境 | 结果 | 证据 |
|------|-----------|------|------|
| Windows | Windows 11 | 通过 | M0–M8 本机测试、V2-M4 进程树测试 |
| Ubuntu | `ubuntu-latest` | 通过无额度验证 | 0.6.1 release CI run `32230018799`：verify/benchmark + DSH smoke |
| macOS | `macos-latest` | 通过无额度验证 | 0.6.1 release CI run `32230018799`：verify/benchmark + DSH smoke |
| Node.js | 20/22/24，要求 `>=20` | 通过无额度验证 | 0.6.1 release CI run `32230018799`：11/11 success |
| DSH LLM SDK | `@deepseek-ai/dsh-llm@0.1.0-rc.7` | 通过 | 官方 `Context + LlmRuntime` smoke test |
| DSH tools policy | 0.9.0 bundle：`dsh-owned`（`workspaceRoot` 已废弃，无感 workspace）；0.7.0：`dsh-owned`；0.6.1 legacy：`reject`/`agy-owned` | 通过无额度与 disposable fixture 验证 | DSH runtime schema、prompt-contract、ToolRuntime round-trip、权限 fail-fast、DSH_WORKSPACE_MISMATCH 与日志白名单测试 |
| DSH profile onboarding | `@deepseek-ai/dsh@0.1.0-rc.7` + `dsh plugin add`（rc.8 隔离审计已通过） | 通过无额度验证 | 0.9.0/0.8.0/0.7.0 packed Web/headless plugin-add smoke、doctor v5/v4/v3、bundle defaults；均 `quotaUsed=false` |
| DSH native capability smoke | `@deepseek-ai/dsh@0.1.0-rc.7` on Node 22/24，Windows/Ubuntu/macOS | 通过无额度验证 | DSH rc.7 的 `dsh-code-runtime`/`dsh-mcp-client` 使用 Node 22+ API；Node 20 仅纳入 Provider verify；PR run `32285350984` native 6/6 success；rc.8 lane 已审计兼容 |
| Doctor CLI | npm package `bin/dsh-agy-provider` | 通过无额度验证 | 0.9.0 doctor v5 `profileSchemaVersion 4`（`workspaceSource/visibleModels/modelEffortSplit` + `DEPRECATED_*`），0.7.0 v3；profile dump failure codes、DSH context probe、bridge capability、frontmatter/workspace/image checks |
| Agent presets | `tool-free`/`read-only`/`workspace-write` | 通过 fake/无额度验证 | 工具白名单、argv、workspace boundary 和显式 installer tests；0.9.0 `dsh-owned` 下无需手配 `workspaceRoot` |
| Settings panel | `Config` i18n `zh-CN/en` + `registerConfigurableProviders` + `registerModelDiscovery` + `visibleModels` | 通过无额度验证 | 0.9.0：多选可见性、base+effort 分离、归一化与旧后缀兼容，L1 160+ 与 L2 fake 覆盖 |
| Image input | DSH raster `ImageBlock` + experimental bridge | negative result；公开仍 text-only | M4 2/2 受控请求；无 verified `view_file` event source/DSH Web attachment closure；0.9.0 仍 V8-M5 no-go |
| AGY | `1.1.13` | 通过 | M0–M6 真实文本、会话和工具采样 |
| AGY | `1.1.14` | 通过诊断与动态目录发现 | `npm run diagnose -- --json`；版本、Agent 和 `agy models` 检查通过，实测发现 14 个模型 |
| AGY | `1.1.15` | 通过 stream-json 真实协议与 persistent | V8-M1 捕获 `{event:"user"}` 帧、3-turn 同会话、V8-M4 warm 79% 改善，无串线 |
| AGY models | `agy models` plain text + 归一化 base | 通过 | V3-M1/V9-M2 解析、去重、显式目录合并和 fallback；0.9.0 `normalizeModelId/extractEffort` 按 base 去重，`filterVisibleModels` |
| AGY Agent | `deepseek-proxy` | 通过 | `agy agents` 与 Provider 默认配置 |
| Diagnostic catalog | `static`/`discovered`/`merged`/`cache`/`fallback` | 通过无额度验证 | V3-M5 machine schema、warning code 和 `quotaUsed=false` 测试 |
| npm registry | `dsh-agy-provider@0.9.0`, `latest` 待发布 | 通过（待验证） | 0.9.0 `npm pack --dry-run` 63-file；`v0.9.0 → 14ed413` 待 `npm publish` Trusted Publishing 2422 |
| Publish workflow | `v*.*.*` tag + package version match + npm Trusted Publishing | 通过 | `v0.7.0` → `b94fa32`（run `32286511205`）；`v0.9.0` → `14ed413` 待触发 |

0.9.0 发布证据（待 registry 确认后更新）：`main@14ed413` + 本地 `v0.9.0`，`npm run build/typecheck` 通过，L1/L2 设计完成（L1 160+ cases、L2 visibleModels/归一化/旧后缀/workspace 无感），L3/L4 self-contained 与 permission-matrix 门禁仍有效，`quotaUsed=false`。0.7.0 发布证据：release commit `b94fa32` 的 PR run `32286276907` 为 17/17，Trusted Publishing run `32286511205` 成功；registry `0.7.0` 的 Web/headless smoke 与 15/15 permission/tool matrix 通过，`quotaUsed=false`、cleanup completed。0.6.1 legacy 证据保留。

## 版本策略

- `minimumAgyVersion` 默认是 `1.1.15`，采用 `major.minor.patch` 数值比较；0.9.0 的 one-shot 与 persistent 均使用 stdin `stream-json` 输入。
- 低于最低版本、无法解析版本或找不到配置 Agent 时，诊断命令返回非零退出码和明确错误。
- AGY 新版本的未知 `event` 字段会由 Parser 保留；但新增关键字段的语义仍需重新采样。
- `agy agents --output-format json` 不作为兼容前提；诊断使用已验证的纯文本 `agy agents`。
- GitHub Actions 使用 `actions/checkout@v7` 和 `actions/setup-node@v7`；公共 CI 不安装或调用真实 AGY。

## 事件兼容范围

| 事件 | 处理策略 |
|------|----------|
| `init` | 读取顶层或嵌套 `conversation_id` |
| `step_update` | 读取 `text_delta`、usage、tool/permission 分类 |
| `result` | 读取 `status`、最终 response 和 usage |
| `checkpoint`、`agent_response`、未知事件 | 保留并按固定类别计数，不静默转换为 DSH tool call |
| `error`、`error_message` | 提取有界分类 detail；不记录原始 payload |
| AGY 内部工具事件 | `step_update.step_type=tool` | AGY 试图自行执行 | `agy-owned` legacy 仅计数；`dsh-owned` fail closed，不伪装成 DSH tool chunk |
| DSH-owned tool-call | Provider final envelope | AGY 只做文本推理 | 本地严格校验后产生 DSH tool chunk，由 DSH ToolRuntime 执行 |
| permission event | 终止 headless 请求并返回 `PERMISSION_REQUIRED` |

## 稳定错误分类

| AGY detail/生命周期 | Provider code |
|---------------------|---------------|
| authentication/login/credential | `AUTH` |
| quota/credit/balance/billing | `QUOTA` |
| rate limit/429/throttling | `RATE_LIMIT` |
| model not found/unavailable | `MODEL_NOT_FOUND` |
| Agent/profile not found | `AGY_AGENT_MISSING` |
| context/prompt/input too large | `CONTEXT_WINDOW_EXCEEDED` |
| permission request | `PERMISSION_REQUIRED` |
| timeout/abort/parse/output limit | `TIMEOUT`/`ABORTED`/`AGY_PARSE`/`AGY_OUTPUT_LIMIT` |

无法分类的非零退出或非成功 status 保留 `AGY_EXIT` 或 `AGY_STATUS`。V3-M2 已支持 `reasoningEffort=low|medium|high` 到 `--effort` 的控制映射，非法值稳定返回 `UNSUPPORTED_REASONING_EFFORT`；DSH tools 默认拒绝返回 `UNSUPPORTED_TOOLS`，AGY 权限事件返回 `PERMISSION_REQUIRED`。模型发现失败使用 `MODEL_DISCOVERY_FAILED`、`MODEL_DISCOVERY_EMPTY`、`MODEL_DISCOVERY_TIMEOUT` 或 `MODEL_DISCOVERY_OUTPUT_LIMIT` warning code。AGY 输出 reasoning envelope 尚未验证，因此不映射为 `reasoning-delta`。

DSH-owned 模式下，普通 `step_update.name` 不视为内部工具；只有 `tool_call`、`tool_result`、`step_type=tool` 或明确的 `tool_name` 才会返回 `AGY_INTERNAL_TOOL_EVENT`。DSH tools schema 不支持仍返回 `UNSUPPORTED_TOOLS`。

## 未覆盖环境

- macOS/Linux 已完成路径、命令、进程树、构建、测试和包预览验证；尚未在这些平台安装真实 AGY CLI。
- AGY `1.1.14` 的完整文本/会话/工具回归仍需在 M8 的真实额度窗口中补采样；当前已完成无额度诊断和代码回归。
- DSH SDK 的后续 breaking release 需要重新验证 `LlmAdapter`、profile `plugin add` 和 bundle contract。
