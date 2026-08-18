# 0.1.0 发布检查清单

## 已完成

- [x] 包版本固定为 `0.1.0`。
- [x] `README.md`、安装文档、changelog、兼容性矩阵和性能基线已更新。
- [x] `npm run typecheck`、`npm test`、`npm pack --dry-run` 通过。
- [x] GitHub Actions CI 覆盖 Node.js 20/24 和 Windows runner。
- [x] 包内容只包含 `lib`、`cordis.patch.yml`、README 和 package metadata，不包含本机日志、凭据或测试会话。

## 发布前人工确认

- [ ] 在目标 DSH 版本安装 GitHub 包并确认 bundle loader 能激活插件。
- [ ] 在干净 Windows 用户环境运行 `npm run diagnose`。
- [ ] 用测试账号/额度窗口完成最小文本端到端请求和取消回归。
- [ ] 确认仓库可见性、发布方式和 npm 权限后，再决定是否去掉 `private: true`。

本项目不会因为 CI 通过而自动执行 npm publish。
