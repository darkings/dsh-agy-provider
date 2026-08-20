# 任务计划：dsh-agy-provider 0.8.0

## 目标
在保留 0.7.0 DSH-owned 权限与工具所有权的前提下，将 AGY 1.1.15 的 persistent `stream-json` 输入协议产品化，并建立 DSH rc.7/rc.8 双版本兼容门禁；以稳定 `one-shot` 为默认、`persistent` 为 opt-in 的方式交付，达到可发布的 0.8.0。

## 当前阶段
V8-M2 persistent adapter（in_progress，下一实施入口，按真实协议重写 worker）

## 各阶段

### V8-M0：规划与基线固化
- [x] 完成 `docs/v0.8.0-development-plan.md` 范围、门禁、预算、DoD 定义
- [x] 同步 README 中英文的 0.8.0 已规划声明
- [x] 创建本 `task_plan.md` / `findings.md` / `progress.md` 文件规划系统（本步）
- [x] 固化分支策略 `codex/v0.8.0-*` 与留痕规范（每步更新 progress + 必要时提交）
- [x] 冻结 0.7.0 基线：`package.json 0.7.0` / `v0.7.0 -> b94fa32` / npm latest=0.7.0 不在 M0 中 bump
- **状态：** complete

### V8-M1：AGY 真实协议 + DSH rc.7/rc.8 门禁
- [x] 捕获 AGY 1.1.15 真实 `--input-format stream-json` 帧协议（request/ready/event/complete/error/shutdown），与 `src/agy/experimental-transport.ts` 的 prototype envelope 做差异对照
- [x] 建立 DSH `0.1.0-rc.7` stable 回归与 `0.1.0-rc.8` next 兼容 lane，验证 Web/headless、Provider contract、AttachmentStore、ToolRuntime
- [x] 输出 M1 go/no-go 判定：协议可产品化且 rc.7 无回归才进入 M2
- **状态：** complete
- **结论：** go — 单进程 3 连续 turn SUCCESS（conversation_id 一致，usage 可归属），真实输入为 {"event":"user","message":{...}}，与 prototype {kind:"request"} 不兼容，已以 three-turn.log 为证据
- **交付：** `docs/agents.md` 更新、真实帧样例 fixture、双轨测试脚本
- **门禁：** 捕获的真实帧与 prototype 不一致时，以真实帧为准重写 transport，不复用 fixture 契约

### V8-M2：Persistent Adapter（Session-affine Worker Pool）
- [x] Step1: transport 配置（one-shot 默认，persistent opt-in，idle/ready/fallback）
- [x] Step2: worker 产品化 — 将 experimental-transport 的 {kind:request} 改为真实 {event:"user"}，输出改为 init/step_update/result，复用 AgyStreamParser
- [ ] Step3: AgyAdapter 双 transport 分发（session-affine 一 Session 一 worker，单 active turn，maxConcurrent 限流，写入前 before-accept 回退）
- [ ] Step4: 验收 — 100 串行 / 8 并发 / cap / TTL / abort / timeout / crash / malformed / output limit / dispose 残余 0
- **状态：** in_progress
- **交付：** `src/agy/persistent-transport.ts` 产品化、`src/provider/agy.ts` 双 transport 分发、`src/provider/config.ts` 新增字段
- **门禁：** 配置缺省仍为 one-shot；persistent 未显式启用时不启动 worker

### V8-M3：DSH-owned 工具/生命周期安全
- [ ] persistent 模式下完成 `tool-call → DSH ToolRuntime 执行 → tool-result → 下一轮模型回答` 闭环
- [ ] 覆盖 abort、timeout、CLI crash、malformed frame、output limit、dispose 后的确定性回收，下一轮不接收残余事件
- [ ] 复验 0.7.0 权限矩阵在 persistent 下不回退：`read-only / workspace-write / danger-full-access` + shell/local web/local MCP + approval + workspace 边界
- [ ] 审计：Provider 不执行工具、不维护工具白名单、不传 `--dangerously-skip-permissions`，进程树与临时文件清理
- **状态：** pending

### V8-M4：真实可靠性与成本门禁（go/no-go）
- [ ] 真实对照：warm-turn 首事件延迟中位数改善 ≥15%，累计 input tokens 增幅 ≤5%，无重复/丢失响应
- [ ] 预算内完成（22/165k/12k 总预算，单次窗口 ≤2 请求），失败则按 no-go 停止，不发布虚假能力
- [ ] 复用目的路由（compaction/sessionTitle/无 sessionId 请求）保持 one-shot，避免长上下文成本膨胀
- **状态：** pending
- **门禁：** M4 no-go → 停止 0.8.0 发布，评估 re-scope；不进入 M5/M6

### V8-M5：条件性图片门禁（仅 M4 go 后）
- [ ] 像素盲测、DSH Web、工具所有权、临时资源清理四项全过才声明 `inputModalities: ["text","image"]`
- [ ] 否则保持 `imageInput: experimental/off` 与 text-only metadata，不阻塞主线
- [ ] 验证图片 staging 仅 `0600` 且成功/失败路径均清理，日志不含路径/payload/conversationId
- **状态：** pending

### V8-M6：doctor v4 与 RC 门禁
- [ ] doctor v4 只读报告：configured/effective transport、AGY version gate、worker capability/limits、fallback 边界、DSH stable/next、image gate
- [ ] telemetry 仅 allowlisted 数值：transport、attempt/turn/process counts、worker reset reason、latency/usage、bridge outcome
- [ ] 审计：日志/argv/stdin frame/临时文件/进程树/package inventory；CI 覆盖 Node 20/22/24 + Windows/macOS/Ubuntu DSH native stable + rc.8 lane + self-contained smoke
- [ ] 从源码 pack 到 disposable Web/headless profile 复验 one-shot 默认与 persistent opt-in
- **状态：** pending

### V8-M7：迁移与发布
- [ ] 新增 `docs/migration-0.8.0.md` 与 `docs/v0.8.0-release-checklist.md`，同步中英文 README、installation、provider contract、compatibility、CHANGELOG
- [ ] 仅 M1-M4、M6 全过后 bump `package.json`/lockfile 到 0.8.0；M5 按 go/no-go 写入能力声明
- [ ] `npm ci` / verify / benchmark / pack / doctor / Web/headless / permission matrix / PR CI 全绿后打精确 `v0.8.0` tag，Trusted Publishing 发布
- [ ] 从 npm registry 全新安装 0.8.0 复验 latest、默认 one-shot、persistent opt-in、doctor v4、Mock、cleanup、条件性 image metadata
- **状态：** pending

## 关键问题
1. AGY 1.1.15 真实 NDJSON 帧格式与现有 `experimental-transport.ts` 的 `PersistentRequestFrame` 是否一致？不一致时如何最小改动产品化？
2. DSH rc.8 的 breaking changes 是否影响插件装载、AttachmentStore、ToolRuntime？stable/next 如何分离验证？
3. persistent 多轮如何保证“写入后不重发”与“残余事件隔离”同时满足，不产生重复计费或跨 Session 串线？

## 已做决策
| 决策 | 理由 |
|------|------|
| 0.8.0 保持 one-shot 默认，persistent 仅 opt-in | 降低切换风险，待 registry 反馈稳定后再评估默认迁移（v0.8.0 计划 §3.1） |
| 一 Session 一 worker，不共享 conversation，不跨进程持久化 | 避免响应串线与上下文污染（计划 §3.2） |
| 写入后不自动 fallback 到 one-shot | 无法证明未计费，重发会产生不可预测副作用（计划 §3.3） |
| DSH 拥有工具/权限，Provider 不执行工具 | 延续 0.7.0 安全边界，避免权限提升（计划 §3.4） |
| 采用文件规划系统（task_plan/findings/progress） | 满足“每步留痕”，支持 /clear 后恢复 |
| 分支前缀 `codex/` | 遵循 AGENTS.md Git 规范 |

## 遇到的错误
| 错误 | 尝试次数 | 解决方案 |
|------|---------|---------|
| 暂无 | - | - |

## 备注
- 阶段状态流转：pending → in_progress → complete；每完成一阶段更新本文件与 `progress.md`
- 做重大决策前重读本计划
- 记录所有错误，避免重复
- 当前基线：`dsh-agy-provider@0.7.0` / AGY `1.1.15` / DSH `0.1.0-rc.7` stable / DSH `0.1.0-rc.8` next（规划基线，见 v0.8.0 计划 §2）


