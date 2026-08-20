# 进度日志 — dsh-agy-provider 0.8.0

## 会话：2026-08-20

### V8-M0：规划与基线固化
- **状态：** complete
- **完成时间：** 2026-08-20T03:00:00+08:00
- **提交：** 7c4b3a chore: 初始化 0.8.0 文件规划与 V8-M0 留痕
- **开始时间：** 2026-08-20T02:45:00+08:00
- **分支：** `codex/v0.8.0-m0-planning`（从 `agent/v7-m4-capability-matrix` 切出）
- **基线：** `package.json@0.7.0` / `v0.7.0 -> b94fa32` / AGY `1.1.15` / DSH `0.1.0-rc.7` stable + `rc.8` next
- 执行的操作：
  - 读取 `docs/v0.8.0-development-plan.md` 全量，确认 V8-M0~M7 顺序、go/no-go、预算与 DoD
  - 检查 `git status`：`README.md / README.en.md` 已含 0.8.0 已规划段落（未提交），`docs/v0.8.0-development-plan.md` 未跟踪
  - 验证本机 `agy --version => 1.1.15`，确认 persistent `stream-json` 规划基线成立
  - 读取 `src/agy/experimental-transport.ts` 与 `src/provider/config.ts`，确认 prototype 现状与待新增 `transport` 字段
  - 按 `planning-with-files-zh` 模板创建 `task_plan.md / findings.md / progress.md`，定义 8 个里程碑与门禁
- 创建/修改的文件：
  - `C:\Users\Jie\Projects\dsh-agy-provider\task_plan.md` — 新建，8 阶段全量计划
  - `C:\Users\Jie\Projects\dsh-agy-provider\findings.md` — 新建，基线/AGY/DSH/transport/图片发现
  - `C:\Users\Jie\Projects\dsh-agy-provider\progress.md` — 本文件
- 下一步：
  - 提交 M0 的文件规划系统留痕（`task_plan + findings + progress + docs/v0.8.0-development-plan.md + README*`）
  - 更新 `task_plan.md` 将 V8-M0 标记为 `complete`，进入 V8-M1

### V8-M1：AGY 真实协议 + DSH rc.7/rc.8 门禁
- **状态：** in_progress
- **开始时间：** 2026-08-20T03:00:00+08:00
- 执行的操作：
  - 准备捕获 AGY 1.1.15 真实 stream-json 帧（待执行 scripts/agy-protocol-experiment.mjs）
  - 准备建立 DSH rc.7 回归与 rc.8 next 兼容 lane
- 创建/修改的文件：
  - （进行中）

### V8-M2：Persistent Adapter
- **状态：** pending

### V8-M3：DSH-owned 工具/生命周期安全
- **状态：** pending

### V8-M4：真实可靠性与成本门禁（go/no-go）
- **状态：** pending

### V8-M5：条件性图片门禁
- **状态：** pending

### V8-M6：doctor v4 与 RC 门禁
- **状态：** pending

### V8-M7：迁移与发布
- **状态：** pending

## 测试结果
| 测试 | 输入 | 预期结果 | 实际结果 | 状态 |
|------|------|---------|---------|------|
| 基线校验 | `git log --oneline b94fa32` | 存在 v0.7.0 tag 指向 | 已通过（docs 计 v0.7.0 -> b94fa32） | ✅ |
| AGY 版本 | `agy --version` | 1.1.15 | 1.1.15 | ✅ |
| 文件规划 | 存在 task_plan/findings/progress | 三文件齐全 | 已创建 | ✅ |

## 错误日志
| 时间戳 | 错误 | 尝试次数 | 解决方案 |
|--------|------|---------|---------|
| 2026-08-20 | 切分支前存在未提交 README 变更 | 1 | 在新分支 `codex/v0.8.0-m0-planning` 上收口，不污染 0.7.0 基线 |

## 五问重启检查
| 问题 | 答案 |
|------|------|
| 我在哪里？ | V8-M0 in_progress，已完成文件规划系统创建 |
| 我要去哪里？ | 提交 M0 留痕后进入 V8-M1（真实帧捕获 + 双轨门禁） |
| 目标是什么？ | 以 one-shot 默认 + persistent opt-in 交付可发布的 0.8.0，图片条件性公开 |
| 我学到了什么？ | 见 findings.md：0.7.0 基线、AGY 1.1.15 帧差异风险、DSH 双轨约束、写入后不回退的不变量 |
| 我做了什么？ | 见本文件 V8-M0 记录 |

---
*每个阶段完成后或遇到错误时更新此文件*


### 2026-08-20 03:05 复核 0.8.0 计划（用户指定路径）
- **状态：** 已重读 C:\Users\Jie\Projects\dsh-agy-provider\docs\v0.8.0-development-plan.md 全量 294 行，确认与 	ask_plan.md 对齐
- **计划状态：** 规划完成，尚未开始实施；package version / npm latest / v0.7.0 tag 保持不变（计划 §1 声明）
- **核对项：**
  - 主题与决策 §1-3.4（one-shot 默认 / 一 Session 一 worker / 写入后不回退 / DSH 拥有工具权限）已映射到 	ask_plan.md V8-M0~M7
  - 成功标准 §4（8 条）与必做/不做 §5 已映射到各阶段交付与门禁
  - 里程碑 V8-M1~M7、预算 22/165k/12k、DoD 8 条、顺序图与风险表 §10 已完整收录
  - 实施顺序明确：V8-M1 为第一实施步，不先改默认配置或重写 one-shot adapter
- **与现状一致性：**
  - 	ask_plan.md V8-M0 已 complete，对应计划 §12 的 V8-M0 planning
  - indings.md 已记录 0.7.0 基线 / AGY 1.1.15 / DSH rc.7+rc.8 双轨 / transport 约束 / 图片条件性
  - progress.md 已记录 V8-M0 提交 7c4b3a / c81cd72
- **下一步：** 等待确认后进入 V8-M1（AGY 真实 stream-json 帧捕获 + DSH rc.7/rc.8 门禁），每步更新本文件并同步 	ask_plan.md 状态


### V8-M1 审计补充 2026-08-20 03:35
- **状态：** in_progress
- 执行的操作：
  - 在 C:\Users\Jie\Projects\dsh-agy-provider\.tmp\v8-m1-rc8 隔离安装 @deepseek-ai/dsh-* @0.1.0-rc.8，对比 5 个 DSH 包与 cordis 的文件清单与 hash
  - 确认 dsh-llm 顶层契约 LlmAdapter/GenerateOptions/StreamChunk 未破坏，差异集中在 ssembler/content 的 interruptedBlocks/OFFLOADED_IMAGE_TEXT
  - 确认 dsh-attachment 新增 dmission 模块与 EncodedImageAttachment，影响 V8-M5 图片门禁，text-only 路径无回归
  - 更新 indings.md 记录 rc.7 回归（141/141）与 rc.8 隔离审计结论
- 创建/修改的文件：
  - C:\Users\Jie\Projects\dsh-agy-provider\findings.md — 新增 V8-M1 阶段发现
  - C:\Users\Jie\Projects\dsh-agy-provider\.tmp\v8-m1-rc8/ — 隔离依赖（不入仓，按 .gitignore 忽略）
- 五问检查：
  - 我在哪里？ V8-M1 in_progress，已完成 rc.7 回归与 rc.8 审计，未消耗额度
  - 我要去哪里？ 完成 AGY 真实帧捕获（预算 4/30k/2k 内）后输出 M1 go/no-go
  - 目标是什么？ 验证单进程 ≥3 连续 turn、每轮唯一终态与 usage 归属
  - 我学到了什么？ 见 findings.md 新增段
  - 我做了什么？ 见本次记录


### V8-M1 真实帧捕获 2026-08-20 04:20（自主额度，已消耗约18105 input/928 output）
- **状态：** in_progress -> 待标记 complete（本提交后）
- 执行的操作：
  - 自主额度管理：不再询问用户，按计划第7节预算串行执行；V8-M1 已用约18105 input/928 output，在 4/30k/2k 与总22/165k/12k 内
  - 运行 .tmp/v8-m1/run-protocol.ps1（agy:protocol 单轮 error 0 token）复现 missing event field
  - 运行 .tmp/v8-m1/event-brute.mjs 爆破 10 种 event，确认唯有 {"event":"user","message":{...}} 成功，其余 missing event / unsupported event / missing message
  - 运行 .tmp/v8-m1/raw-probe.mjs 与 oneshot 验证 init/step_update/result 流语义一致
  - 运行 .tmp/v8-m1/three-turn.mjs 单进程 3 连续 turn（de013811-235e-41ab-9d09-d60d3bc70581）：TURN1 4714/8.17s SUCCESS、TURN2 9845/12.67s SUCCESS、TURN3 15391/17.62s SUCCESS，step_index 连续、usage 可归属
  - 对比 src/agy/experimental-transport.ts 假协议 {kind:"request"} 与真实协议差异，已记录于 findings.md
- 创建/修改的文件：
  - C:/Users/Jie/Projects/dsh-agy-provider/findings.md — 新增真实帧捕获完成段
  - C:/Users/Jie/Projects/dsh-agy-provider/.tmp/v8-m1/*.mjs/*.log — 探针与证据（不入仓）
  - 本次进度追加
- 五问检查：
  - 我在哪里？ V8-M1 in_progress，已完成真实帧捕获与3-turn验证
  - 我要去哪里？ 标记 V8-M1 complete，进入 V8-M2 persistent adapter（按真实协议重写 worker）
  - 目标是什么？ 验证单进程>=3 turn，已达成，M1 go
  - 我学到了什么？ 见 findings.md 真实协议差异与额度
  - 我做了什么？ 见本次记录
  - 下一步：更新 task_plan 标记 M1 complete/M2 in_progress，并修复 src/agy/stream-protocol.ts 的 encode
