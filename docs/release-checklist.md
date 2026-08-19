# 发布检查清单

## `0.1.0` 历史记录

## 已完成

- [x] 包版本固定为 `0.1.0`。
- [x] `README.md`、安装文档、changelog、兼容性矩阵和性能基线已更新。
- [x] `npm run typecheck`、`npm test`、`npm pack --dry-run` 通过。
- [x] GitHub Actions CI 覆盖 Node.js 20/24 和 Windows runner。
- [x] 包内容只包含 `lib`、`cordis.patch.yml`、README 和 package metadata，不包含本机日志、凭据或测试会话。
- [x] `package.json` 已设置公开发布：`private: false`、`publishConfig.access: public`。
- [x] 已执行 `npm publish --access public`，`dsh-agy-provider@0.1.0` 已发布到 npm，`latest` 指向 `0.1.0`。

## 发布后人工复验

- [ ] 在目标 DSH 版本安装 npm 包并确认 bundle loader 能激活插件。
- [ ] 在干净 Windows 用户环境运行 `npm run diagnose`。
- [ ] 用测试账号/额度窗口完成最小文本端到端请求和取消回归。

## `0.2.0` 当前检查

- [x] `package.json` 和 `package-lock.json` 版本更新为 `0.2.0`。
- [x] `CHANGELOG.md`、README、安装文档、迁移说明和兼容性矩阵已更新。
- [x] 添加 MIT `LICENSE`，保持 package license metadata 一致。
- [x] 添加 `.github/workflows/publish.yml`，仅响应匹配 package version 的 `v*.*.*` tag。
- [x] 发布 workflow 使用 GitHub-hosted Node.js 24、`id-token: write` 和无 token 的 npm publish 命令。
- [x] 因账号级 2FA 暂不可用，使用本机已配置的 bypass-2FA granular token 直接发布 `dsh-agy-provider@0.2.0`；凭据未写入仓库或 workflow。
- [ ] 在 npm package settings 配置 Trusted Publisher：`darkings/dsh-agy-provider` + `publish.yml` + `npm publish`（等待账号级 2FA；用于下一个可发布版本）。
- [ ] 用下一个可发布版本 tag 验证 publish workflow；不要用已经发布的 `v0.2.0` 再次触发 `npm publish`。
- [x] 用 `npm view dsh-agy-provider@0.2.0`、干净 registry 安装和 DSH Mock smoke 复验产物；`latest=0.2.0`、`version=0.2.0`、`quotaUsed=false`。
- [x] 确认 private GitHub repo 的 provenance 限制已在发布说明中明确。

> 当前发布已完成，但 Trusted Publisher 和 release tag 保留为后续 2FA 恢复后的加固工作；`v0.2.0` 已存在于 registry，不应再次触发其 publish workflow。

## `0.3.0` 发布准备

### 已完成

- [x] V3-M1–V3-M5 代码、测试、迁移说明和兼容性矩阵完成；默认 one-shot 与 0.2.0 安全行为保持不变。
- [x] Windows/Ubuntu/macOS × Node.js 20/22/24 CI 通过；V3-M5 最终 run 为 `32152814696`，V3-M6 发布准备 run 为 `32154087579`，均 9/9 success。
- [x] `npm run verify`、`npm run benchmark`、`npm run diagnose -- --json` 和 `npm pack --dry-run` 本地通过。
- [x] registry 确认 `dsh-agy-provider@0.2.0` 存在且 `latest=0.2.0`；确认 `0.3.0` 尚未占用。
- [x] publish workflow 已检查 tag/package version 一致，并使用 `id-token: write` 的 npm Trusted Publishing，不保存 npm token。
- [x] 当前 package version 保持 `0.2.0`，未创建 `v0.3.0` tag，未执行 `npm publish`。

### 发布前仍需人工/账号条件

- [ ] npm 账号级 2FA 恢复并完成 Trusted Publisher：`darkings/dsh-agy-provider`、`.github/workflows/publish.yml`、npm publish。
- [ ] 在独立 release commit 中将 `package.json`/`package-lock.json` bump 到 `0.3.0`，同步 CHANGELOG、README 和迁移说明。
- [ ] 运行完整 `npm run verify`、pack dry-run 和诊断，确认没有测试会话、规划文件、日志、凭据或本机路径进入 tarball。
- [ ] 创建并推送精确匹配的 `v0.3.0` tag；只在用户明确授权后触发 publish workflow。
- [ ] 从 npm registry 全新安装 `dsh-agy-provider@0.3.0`，完成隔离 DSH Mock smoke。
- [ ] 如需真实 AGY 最小请求，单独确认请求数/token 预算和终止条件；公共 CI 不得调用 AGY。

> 当前 V3-M6 只完成发布准备和无额度复验；不改变已发布 `0.2.0`，不占用 `0.3.0` registry 版本，也不绕过账号级 2FA。

## `0.4.0` 发布结果

- [x] `package.json` 和 `package-lock.json` 版本更新为 `0.4.0`。
- [x] `CHANGELOG.md`、README、安装文档和兼容性矩阵同步更新。
- [x] `npm run verify` 通过，80/80 测试通过，tarball 包含 40 个文件。
- [x] 自包含 DSH Mock smoke 通过，Windows 本机与 Ubuntu/macOS Node 24 CI 均通过。
- [x] 执行 `npm publish --access public`，`dsh-agy-provider@0.4.0` 已发布，`latest=0.4.0`。
- [x] npm registry 回读确认 `dsh-agy-provider-0.4.0.tgz` 可访问。
- [x] 版本提交 `a6fb5b1` 的 GitHub Actions CI run `32199878143` 通过 11/11。

> 0.3.0 未单独发布；其已完成能力随 0.4.0 一并发布。未创建 `v0.4.0` tag，避免现有 tag publish workflow 对已发布版本重复执行。
