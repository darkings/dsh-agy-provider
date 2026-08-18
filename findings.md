# 发现与决策

## 需求

- 在 `C:\Users\Jie\Projects` 创建 DSH 插件项目文件夹。
- 在 GitHub 创建对应仓库。
- 详细列出后续开发计划。
- 插件的核心目标是让 DSH 使用 AGY 账号额度。

## 研究发现

- GitHub CLI 已登录账号 `darkings`，具备 `repo` 权限。
- 已创建私有仓库 `https://github.com/darkings/dsh-agy-provider`，默认分支为 `main`。
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

## 资源

- 本机 AGY：`C:\Users\Jie\.local\bin\agy.exe`
- 详细计划：`docs/development-plan.md`
- 验证基线：`docs/verified-baseline.md`

## 视觉/浏览器发现

- 本任务没有使用视觉或浏览器材料。

---
*每执行2次查看/浏览器/搜索操作后更新此文件*
*防止视觉信息丢失*
