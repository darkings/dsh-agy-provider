# 任务计划：dsh-agy-provider 0.9.0

## 目标
让 AGY 模型在 DSH 中像原生模型一样无感可用：DSH 设置面板可视化配置，项目目录由 DSH Session/cwd 自动接管（废弃 workspaceRoot），模型列表/参数/工具行为与官方 Provider 对齐。

## 当前阶段
V9-M0 规划中（0.8.0 已合并至 main b7c9a45，待推送发布）

## 各阶段

### V9-M0：规划与基线固化
- [ ] 完成 docs/v0.9.0-development-plan.md 范围、门禁、设计冻结
- [ ] 同步中英文 README 的 0.9.0 规划声明
- [ ] 固化分支策略 codex/v0.9.0-* 与留痕规范
- [ ] 确认 0.8.0 发布收尾动作：push main + tag v0.8.0 + Trusted Publishing
- **状态：** in_progress

### V9-M1：DSH 设置面板 + 中/英切换
- [x] 为 Config schema 补充 title/description/enumNames/advanced 分组，新增 visibleModels 多选；每个字段加 .i18n({ 'zh-CN':{}, en:{} })
- [x] src/index.ts 增加 ctx.llm.registerConfigurableProviders + registerModelDiscovery
- [x] 面板渲染发现模型为可勾选列表，勾选结果写回 visibleModels；推理强度分离为 base 下拉 + effort 下拉（模型归一化完成）
- [ ] 本地 DSH Web 验证面板中/英切换（locale zh-CN/en）时描述实时变更（待 Web 烟雾）
- **状态：** in_progress

### V9-M2：工作区无感化 + 模型与推理强度分离
- [ ] dsh-owned 下废弃 workspaceRoot：Config 标记 deprecated，面板隐藏，AgyAdapter 不再读取
- [ ] 工具请求自动使用 DSH Session header.cwd + workspaceRegistry + sandboxPolicy 的 canonical 校验
- [ ] 纯文本无 workspace 仍可用，有工具无 workspace 时返回 DSH_WORKSPACE_MISMATCH 可操作错误
- [ ] 模型归一化：src/agy/models.ts normalizeModelId/extractEffort，configuredModels/parseAgyModels 按 base 去重；listModels 仅返回 base，reasoning.efforts 统一暴露
- [ ] 兼容：请求 model 带 -high/-medium/-low 后缀时自动拆为 base+effort，warning 提示迁移
- [ ] doctor v5 报告 settingsPanel/workspaceSource/effectiveWorkspace/visibleModels + DEPRECATED_WORKSPACE_ROOT/DEPRECATED_MODEL_EFFORT_SUFFIX warning
- [ ] 文档与迁移说明：docs/migration-0.9.0.md
- **状态：** pending

### V9-M3：模型可见性与平权收口
- [ ] visibleModels 过滤：listModels 按可见性过滤，未勾选不在选择器出现但显式请求仍兼容
- [ ] temperature/maxTokens/stop 按 AGY 实际能力透传或面板禁用并提示
- [ ] inputModalities 保持 text-only，imageInput 仅 off/experimental 且面板标注限制
- [ ] 校验：面板勾选→选择器可见性、base+effort 下拉、旧后缀兼容、workspace 无感三者联动
- **状态：** pending

### V9-M4：完整测试与发布
- [ ] L1 单元：parser/serialize/models/visibleModels/normalizeModelId/i18n 覆盖率 160+ cases
- [ ] L2 集成：fake 进程覆盖 visibleModels 过滤、base+effort、旧后缀兼容、workspace 无感
- [ ] L3/L4：self-contained + permission-matrix smoke (quotaUsed=false)
- [ ] L5 新增：settings-panel smoke（勾选/强度/工作区/i18n zh-CN/en）
- [ ] L6 跨平台 CI：Node20/22/24 × Win/Ubuntu/macOS 全绿
- [ ] L7 真实 AGY 抽样：预算内验证 base+effort 透传与旧后缀兼容
- [ ] docs/v0.9.0-release-checklist.md 按 7 层打勾 + Trusted Publishing + registry 复验
- [ ] 同步中英文 README / installation / contract / compatibility / CHANGELOG
- **状态：** pending

## 关键问题
1. DSH 设置面板的 Config schema 元数据（schemastery title/description）是否足够驱动面板？需以 llm-deepseek 的 Config 为参照验证。
2. workspaceRoot 废弃后，legacy agy-owned 用户如何平滑迁移？是否保留读取但忽略？
3. temperature 等参数 AGY CLI 是否支持透传？不支持时面板应禁用还是报错？
4. visibleModels 为空时是“显示全部”还是“显示已配置 models”？与 modelDiscovery:off 如何交互？
5. 归一化后旧配置 gemini-3.7-flash-high 是否自动迁移为 model+effort，还是仅兼容期 warning？
6. schemastery i18n 的 zh-CN/en 键名是否与 DSH Web locale 完全对齐（zh / zh-CN / en-US）？
7. 7 层测试中 L5 设置面板 smoke 需 DSH Web 定制 fixture，如何保持 quotaUsed=false 且稳定？

## 已做决策
| 决策 | 理由 |
|------|------|
| dsh-owned 废弃 workspaceRoot，DSH Session cwd 为唯一权威 | DSH 已有项目目录，无需用户二次配置，见 src/dsh/context.ts resolveDshContext |
| 面板即 Config 的可视化，不另起存储 | 保持单一事实源，复用 Cordis/Schemastery 机制 |
| 文本请求无需 workspace，工具请求 fail-closed | 降低无感门槛，同时保持安全边界 |
| base 模型 + reasoningEffort 分离 | 与原生 Provider 对齐，面板强度下拉而非三个重复模型 |
| V9 仍不强行公开 image modality | 沿用 V8-M5 四门门禁 |

## 遇到的错误
| 错误 | 尝试次数 | 解决方案 |
|------|---------|---------|
| git push schannel SEC_E_NO_CREDENTIALS | 2 | 沙箱内 schannel 证书不可用，已合并 main b7c9a45，待宿主终端手动 git push origin main && git push origin v0.8.0 |
| .gitconfig Permission denied (openssl 切换) | 1 | 沙箱内文件锁，恢复 schannel，不阻塞 0.9.0 规划 |

## 备注
- 0.8.0 遗留：本地已 git merge --no-ff b7c9a45，需宿主执行推送与打 tag
- 分支建议：codex/v0.9.0-panel-workspace