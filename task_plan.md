# 任务计划：创建 dsh-agy-provider 项目与开发路线

## 目标

在 `C:\Users\Jie\Projects\dsh-agy-provider` 建立本地 Git 项目和同名 GitHub 仓库，并形成可执行、可验收的完整开发计划。

## 当前阶段

项目初始化已完成；阶段 5 的 M1 待开始

## 各阶段

### 阶段 1：需求与环境确认

- [x] 确认项目名称为 `dsh-agy-provider`
- [x] 确认目标目录不存在且父目录可用
- [x] 确认 Git、Node、npm、AGY 环境
- [x] 确认 GitHub 登录账号及仓库权限
- **状态：** complete

### 阶段 2：规划与结构

- [x] 建立项目目录结构
- [x] 创建 `task_plan.md`、`findings.md` 和 `progress.md`
- [x] 创建 README、基线记录和详细开发计划
- [x] 明确目标架构、范围边界和风险
- **状态：** complete

### 阶段 3：项目骨架

- [x] 创建 TypeScript 最小骨架
- [x] 创建 AGY、Provider、Session 和测试目录
- [x] 验证 JSON、TypeScript 配置和最小类型检查
- **状态：** complete

### 阶段 4：Git 与 GitHub 发布

- [x] 将暂存项目移动到目标目录
- [x] 初始化 Git 仓库并创建初始提交
- [x] 创建私有 GitHub 仓库 `darkings/dsh-agy-provider`
- [x] 推送默认分支并验证远程状态
- **状态：** complete

### 阶段 5：产品开发

- [ ] M1：确认 DSH Provider 契约
- [ ] M2：实现 AGY Process Adapter
- [ ] M3：实现 stream-json 增量解析器
- [ ] M4：完成 DSH 文本 Provider MVP
- [ ] M5：实现会话和上下文策略
- [ ] M6：确认并实现工具能力边界
- [ ] M7：配置、安全和可观测性
- [ ] M8：测试、兼容性和性能
- [ ] M9：打包并发布 `0.1.0`
- **状态：** pending

## 关键问题

1. DSH 目标版本和 Provider SDK 的真实接口是什么？
2. AGY 工具与 DSH 工具由哪一层拥有执行权？
3. `--conversation` 是否适合可靠映射 DSH Session？
4. AGY `stream-json` 在错误、权限和工具调用时会产生哪些事件？

## 已做决策

| 决策 | 理由 |
|------|------|
| 项目命名为 `dsh-agy-provider` | 目标是把 AGY 暴露为 DSH Provider |
| 最终链路保留 AGY | 用户目标是使用 AGY 额度 |
| 第一版以 Windows/AGY 1.1.13 为基线 | 已完成实机验证，可控制初始范围 |
| 默认创建私有 GitHub 仓库 | 用户未指定可见性，优先避免意外公开 |
| 先确认 DSH API 再写适配代码 | 避免把伪 API 固化进项目 |
| 文本 MVP 先于工具桥接 | 降低双 Agent loop 的副作用风险 |

## 遇到的错误

| 错误 | 尝试次数 | 解决方案 |
|------|---------|---------|
| `agy agents --output-format json` 不被 1.1.13 支持 | 1 | 使用 `agy agents`；仅 print 模式使用 `--output-format` |
| GitHub URL 专用 credential helper 指向已失效路径 | 1 | 仅在本仓库覆盖为 `D:/Applications/Scoop/shims/gh.exe` 并重新验证远程读取 |

## 备注

- 产品里程碑和验收标准详见 `docs/development-plan.md`。
- 完成阶段后更新状态：pending → in_progress → complete。
- 外部内容只记录到 `findings.md`，不写入本计划。
