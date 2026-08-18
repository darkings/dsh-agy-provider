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
- [ ] 在 npm package settings 配置 Trusted Publisher：`darkings/dsh-agy-provider` + `publish.yml` + `npm publish`（等待账号级 2FA）。
- [ ] 推送 `v0.2.0` tag，确认 publish workflow 成功（等待 Trusted Publisher，避免触发未认证 workflow 或重复发布）。
- [x] 用 `npm view dsh-agy-provider@0.2.0`、干净 registry 安装和 DSH Mock smoke 复验产物；`latest=0.2.0`、`version=0.2.0`、`quotaUsed=false`。
- [x] 确认 private GitHub repo 的 provenance 限制已在发布说明中明确。

> 当前发布已完成，但 Trusted Publisher 和 release tag 保留为后续 2FA 恢复后的加固工作；在此之前不要推送 `v0.2.0`，以免触发尚未认证的 tag workflow。
