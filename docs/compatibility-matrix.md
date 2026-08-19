# 兼容性矩阵

## 已验证组合

| 组件 | 版本/环境 | 结果 | 证据 |
|------|-----------|------|------|
| Windows | Windows 11 | 通过 | M0–M8 本机测试、V2-M4 进程树测试 |
| Ubuntu | `ubuntu-latest` | 通过无额度验证 | 0.6.0 release CI run `32224840640`：verify/benchmark + DSH smoke |
| macOS | `macos-latest` | 通过无额度验证 | 0.6.0 release CI run `32224840640`：verify/benchmark + DSH smoke |
| Node.js | 20/22/24，要求 `>=20` | 通过无额度验证 | 0.6.0 release CI run `32224840640`：11/11 success |
| DSH LLM SDK | `@deepseek-ai/dsh-llm@0.1.0-rc.7` | 通过 | 官方 `Context + LlmRuntime` smoke test |
| DSH tools policy | `reject` 默认；显式 `agy-owned` | 通过无额度验证 | 官方 DSH runtime schema、工具事件、权限 fail-fast 和日志白名单测试 |
| DSH profile onboarding | `@deepseek-ai/dsh@0.1.0-rc.7` + `dsh plugin add` | 通过无额度验证 | V6-M5 Web/headless 原生 plugin-add smoke，doctor v2 effective fields，`quotaUsed=false` |
| Doctor CLI | npm package `bin/dsh-agy-provider` | 通过无额度验证 | V6-M5 profile dump failure codes、frontmatter/workspace/image checks 和 tarball smoke |
| Agent presets | `tool-free`/`read-only`/`workspace-write` | 通过 fake/无额度验证 | 工具白名单、argv、workspace boundary 和显式 installer tests |
| Image input | DSH raster `ImageBlock` + experimental bridge | negative result；公开仍 text-only | M4 2/2 受控请求；无 verified `view_file` event source/DSH Web attachment closure |
| AGY | `1.1.13` | 通过 | M0–M6 真实文本、会话和工具采样 |
| AGY | `1.1.14` | 通过诊断与动态目录发现 | `npm run diagnose -- --json`；版本、Agent 和 `agy models` 检查通过，实测发现 14 个模型 |
| AGY Agent | `deepseek-proxy` | 通过 | `agy agents` 与 Provider 默认配置 |
| AGY models | `agy models` plain text | 通过 | V3-M1 解析、去重、显式目录合并和 fallback 测试通过 |
| Diagnostic catalog | `static`/`discovered`/`merged`/`cache`/`fallback` | 通过无额度验证 | V3-M5 machine schema、warning code 和 `quotaUsed=false` 测试 |
| npm registry | `dsh-agy-provider@0.6.0`, `latest=0.6.0` | 通过 | npm metadata/tarball、全新 DSH profile 安装 smoke；registry run 后回读通过 |
| Publish workflow | `v*.*.*` tag + package version match + npm Trusted Publishing | 通过 | `v0.6.0` → commit `948049c`；publish run `32225108295`；不保存 npm token |

0.6.0 发布后证据：公开仓库 CI run `32224840640` 为 11/11 success；registry 隔离 smoke 使用 `dsh-agy-provider@0.6.0` 完成 Web/headless 原生 plugin add、doctor v2、bundle inventory 和 Mock response，`quotaUsed=false`、cleanup completed。

## 版本策略

- `minimumAgyVersion` 默认是 `1.1.13`，采用 `major.minor.patch` 数值比较。
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
| 工具事件 | 只累计 `tool` 类别和工具计数，不产生 DSH tool chunk；`toolPolicy` 不改变 AGY 唯一所有权 |
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

## 未覆盖环境

- macOS/Linux 已完成路径、命令、进程树、构建、测试和包预览验证；尚未在这些平台安装真实 AGY CLI。
- AGY `1.1.14` 的完整文本/会话/工具回归仍需在 M8 的真实额度窗口中补采样；当前已完成无额度诊断和代码回归。
- DSH SDK 的后续 breaking release 需要重新验证 `LlmAdapter`、profile `plugin add` 和 bundle contract。
