# Changelog

## [0.4.0] - 2026-08-19

### Added

- V3-M1 quota-free 动态模型发现：通过 `agy models` 枚举可用模型，并将结果接入 DSH `listModels()`。
- 动态模型目录的显式配置合并、TTL 缓存、single-flight、最近成功缓存和静态 fallback。
- 诊断 JSON 增加 `configuration.modelDiscovery` 与 `modelCatalog` 来源/过期/警告状态。
- `modelDiscovery`、`modelDiscoveryTtlMs` 和 `modelDiscoveryTimeoutMs` 配置。
- V3-M2 reasoning metadata：为模型公开 `low`、`medium`、`high`，并将请求级 `reasoningEffort` 映射为独立 `--effort` argv。
- V3-M3 `toolPolicy: reject | agy-owned`：默认保持 DSH tools 拒绝；显式 `agy-owned` 忽略 DSH schemas，保持 AGY 为唯一工具执行者。
- V3-M4 隔离 persistent stream transport fixture gate：覆盖 worker/session 隔离、请求关联、故障恢复、TTL、取消/超时和进程树回收；prototype 未接入正式 Provider。
- V3-M5 诊断与安全加固：模型目录来源、稳定 warning code、reasoning/tool/discovery 白名单日志，以及 Windows/Unix 用户路径和 spawn 错误脱敏。

### Security

- 模型发现继续使用无 Shell 子进程，不发送 Prompt、不执行工具、不读取或持久化 Token，并保持 `quotaUsed: false`。
- effort 只接受固定白名单；非法值在 spawn 前返回 `UNSUPPORTED_REASONING_EFFORT`，不会进入 shell 或 Prompt。
- 工具策略日志只记录策略和值数量，不记录 schema 参数；两种策略都保持权限请求 `PERMISSION_REQUIRED` fail-fast，且不自动加入 `--dangerously-skip-permissions`。
- 结构化日志改为显式白名单重建，不转发运行时附加字段；诊断保持 `schemaVersion: 1` 和 `quotaUsed: false`。

### Release readiness

- package version 已更新为 `0.4.0`，npm `latest` 已指向 `0.4.0`；0.3.0 未单独发布，其已完成能力随 0.4.0 一并交付。
- 已通过 `npm publish --access public` 完成公开发布，并回读确认 `dsh-agy-provider-0.4.0.tgz` 可访问。

### 0.4.0 progress

- V4-M1 已完成真实 AGY `stream-json` 最小采样：新增双重确认的 `npm run agy:protocol` 实验脚本、脱敏协议 fixture 和回放测试；未把 fixture-only 字段接入正式 Adapter。
- V4-M2/V4-M3 暂不进入用户配置：本轮真实采样确认了 `init → step_update → result` 输出形状，但没有证明同一 AGY 进程的多轮 stdin 留存，因此不暴露 persistent transport，也不宣称性能/token 收益。
- V4-M4 已增加自包含 `npm run smoke:dsh:self-contained`，固定安装 DSH `0.1.0-rc.7`、本地 tarball 和隔离 headless profile，Mock 结果 `quotaUsed=false`；Linux/macOS Node 24 CI smoke 已加入。

### Release result

- 版本提交 `a6fb5b1` 的 GitHub Actions CI run `32199878143` 已 11/11 成功。
- 真实 AGY 额度实验仍保持 2 次尝试上限；发布过程未追加模型请求。
- 未创建 `v0.4.0` tag，避免现有 tag publish workflow 对已发布版本重复执行。

## [0.2.0] - 2026-08-18

面向真实 DSH 安装、诊断、跨平台运行和安全发布的产品化版本。

### Added

- 结构化 `npm run diagnose -- --json`，覆盖 DSH、插件、Node.js、AGY、Agent、配置和模型目录。
- `models` 多模型目录，兼容旧版 `model` 配置。
- AGY 生命周期事件分类、稳定错误码和脱敏可观测性。
- Windows/Ubuntu/macOS × Node.js 20/22/24 CI，以及跨平台父子进程树清理测试。
- 可复测的 `full/resume` quota 实验入口和报告。
- 预置 GitHub Actions tag 发布 workflow，目标使用 npm Trusted Publishing/OIDC，不在 workflow 中保存 npm publish token。
- MIT `LICENSE` 和 `0.2.0` 迁移说明。

### Changed

- 默认继续使用 `sessionMode: full`。真实复测中 `resume` 第二轮 input tokens 为 `9,224`，`full` 为 `4,529`，未达到持久化门槛。
- `sessionMode: resume` 继续作为显式选项，不启用跨进程持久化 Session store。

### Limitations

- 仍为文本 Provider；不桥接 DSH tools、图像、多模态或完整采样参数。
- GitHub 仓库继续为 private，因此 npm provenance 受 registry 限制不会生成；后续若公开仓库可重新启用 provenance 验证。

### Release note

- `0.2.0` 已发布到 npm，`latest` 指向 `0.2.0`；由于 npm 账号级 2FA 暂不可用，首次发布使用本机已配置的 bypass-2FA granular token 完成直接发布，GitHub Actions Trusted Publisher 连接待后续配置。

## [0.1.0] - 2026-08-18

首个可用预览版，目标是把本机已登录的 AGY CLI 暴露为 DSH 文本 Provider。

### Added

- 基于 `@deepseek-ai/dsh-llm` `LlmAdapter` 的 DSH bundle 插件入口。
- Windows 无 Shell `agy.exe` 子进程适配、stream-json 增量解析、取消和超时。
- `sessionMode: full` 默认上下文策略，以及显式 `resume` 会话映射和恢复失败降级。
- AGY 自治 Agent 工具边界：DSH tools 拒绝，权限请求快速失败。
- 配置诊断、最低 AGY 版本检查、有界并发队列、结构化脱敏日志。
- NDJSON/进程输出上限、兼容性矩阵、无额度性能基线和 GitHub Actions CI。

### Limitations

- V1 仅支持文本消息；不支持 DSH tools、图像、采样控制和跨进程会话持久化。
- 当前完整实机兼容性范围是 Windows 11、AGY `1.1.13`/`1.1.14` 和 `deepseek-proxy`。
- package 以公开 npm 包发布；GitHub 仓库继续提供源码安装和开发协作入口。
