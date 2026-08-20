# 发现与决策 — dsh-agy-provider 0.8.0

## 需求
- 将 AGY 1.1.15 的 `stream-json` persistent 输入协议产品化，建立 DSH rc.7/rc.8 双版本兼容门禁，在不破坏 0.7.0 DSH-owned 权限边界的前提下，以 `one-shot` 默认 + `persistent` opt-in 交付 0.8.0。
- 图片作为条件性交付：仅当像素盲测、DSH Web、工具所有权、临时资源清理全部通过才公开 `inputModalities: ["text","image"]`。
- 全程“每步留痕”：通过 `task_plan.md / findings.md / progress.md` 持久化。

## 研究发现

### 0.7.0 基线（已发布）
- `package.json` 版本 `0.7.0`，npm `latest=0.7.0`，git tag `v0.7.0 -> b94fa32`，Trusted Publishing run `32286511205` 已通过。
- `cordis.patch.yml` 默认 `toolPolicy: dsh-owned / provider: agy / agent: deepseek-proxy / sessionMode: full`。
- 0.7.0 安全边界：Provider 不执行工具、不传 `--dangerously-skip-permissions`、DSH Session `cwd` 为 workspace 权威、权限三档 `read-only / workspace-write / danger-full-access`。
- 未提交变更：`README.md / README.en.md` 已加入 0.8.0 已规划声明 + `docs/v0.8.0-development-plan.md` 未跟踪，需在 V8-M0 一并纳入分支。

### AGY 1.1.15 与现有 prototype
- 本机 `agy --version` = `1.1.15`，正式支持 `--input-format stream-json`，可在单一 conversation 中逐行执行多轮（见 v0.8.0 计划 §2 规划基线）。
- `src/agy/experimental-transport.ts` 已有 fake worker 生命周期实现：`PersistentRequestFrame {kind:request, requestId, sessionId, payload}` / `PersistentIncomingFrame {kind: ready|event|complete|error}` / `encodePersistentFrame / parsePersistentFrame`，但尚未对接 AGY 真实 NDJSON frame（见 v0.8.0 计划 §5 必做）。
- 风险：prototype 的 `frame envelope` 可能与 AGY 真实协议不一致，M1 必须先捕获真实帧，以真实帧为准重写（计划 §10 风险表首行）。

### DSH 双轨
- `package.json` 当前 `devDependencies/peerDependencies` 均指向 `@deepseek-ai/dsh-* @0.1.0-rc.7`（stable）。
- v0.8.0 计划引入 `rc.8` 作为 next lane，不直接替换 stable；rc.7 保持全量回归，rc.8 通过后才扩大兼容声明（计划 §3/§4.4）。
- 已有 `src/dsh/context.ts` 的 `resolveDshContext` 对 Session/workspace/sandbox/permission/approval 做 fail-closed 校验，需在 persistent 模式下保持。

### 配置与 Transport
- 当前 `src/provider/config.ts` 无 `transport` 字段，M2 需新增 `transport: "one-shot" | "persistent"`，默认 `one-shot`（计划 §3.1）。
- 约束：一 Session 一 worker、单 active turn 串行、worker 不跨进程持久化、compaction/sessionTitle/无 sessionId 请求走 one-shot（计划 §3.2）。
- 关键不变量：`frame 已写入 stdin 后绝不自动回退 one-shot`（计划 §3.3），否则重复计费。

### 图片边界
- `src/provider/image-bridge.ts` 已有 `prepareAgyPrompts` 的 staging bridge，`imageInput: experimental` 受控；但 persistent 下若 AGY 内部 `view_file` 与 DSH-owned 所有权冲突，则不公开 modality（计划 §9/§10）。

## 技术决策
| 决策 | 理由 |
|------|------|
| 以真实 AGY 帧为契约，不复用 fixture envelope | 避免 prototype 与生产不一致导致 transport 无法复用 |
| Session-affine worker pool + idle TTL + ready/turn/shutdown timeout | 保证回收确定性，防止泄漏与残余事件串线 |
| one-shot/persistent 共用 parser / 错误分类 / usage / tool protocol | 复用 0.7.0 已验证的流解析与 DSH TOOL PROTOCOL V1 |
| M4 真实对照设 go/no-go，写入预算上限 22/165k/12k | 防止“虚假能力发布”，预算与串线是阻断条件 |
| doctor v4 只记录 allowlisted 数值 telemetry | 不泄露 payload/路径/prompt/conversationId |

## 遇到的问题
| 问题 | 解决方案 |
|------|---------|
| 当前分支仍在 `agent/v7-m4-capability-matrix`，存在未提交的 README 变更与未跟踪的 v0.8.0 计划 | 新建 `codex/v0.8.0-m0-planning` 分支收口，M0 结束前一次性提交留痕 |
| 0.7.0 已发布但分支未切换，`git status` 显示 M README | 在新分支上固化，避免污染 0.7.0 tag 基线 |

## 资源
- `docs/v0.8.0-development-plan.md` — 0.8.0 范围、门禁、预算、DoD、顺序
- `docs/v0.7.0-development-plan.md` / `docs/v0.7.0-release-checklist.md` — 0.7.0 完成证据链参考
- `src/agy/experimental-transport.ts` — persistent prototype，需与真实帧对照
- `src/provider/config.ts` / `src/provider/agy.ts` / `src/dsh/context.ts` — 待改造的核心链路
- `src/provider/image-bridge.ts` — 图片 staging 边界
- AGY 本机 `1.1.15`，`agy --version` 已验证

## 视觉/浏览器发现
- 暂无（M0 阶段未涉及浏览器验证）

---
*每执行2次查看/浏览器/搜索操作后更新此文件*
