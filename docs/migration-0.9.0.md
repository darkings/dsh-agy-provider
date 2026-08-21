# 0.9.0 迁移说明

本文面向从 0.8.0 升级到 0.9.0 的用户。

## 核心变化

0.9.0 的目标是让 AGY 模型在 DSH 中像原生模型一样无感可用：设置面板可视化配置，项目目录由 DSH 自动接管，模型列表与推理强度分离。

## 1. 模型与推理强度分离

**之前（0.8.0）：**
```yaml
model: gemini-3.7-flash-high   # 与
model: gemini-3.7-flash-medium # 与
model: gemini-3.7-flash-low    # 三个独立模型
```

**之后（0.9.0）：**
```yaml
model: gemini-3.7-flash
# 推理强度在 DSH 会话级选择：low | medium | high → AGY --effort
```

* `src/agy/models.ts` 的 `agy models` 发现与 `src/provider/config.ts` 的 `configuredModels` 均按 base id 去重（去除末尾 -high/-medium/-low）
* `listModels()` 仅返回 base，`resolveModel()` 返回的每个 base 均带 `reasoning: {efforts:[low,medium,high]}`，DSH 面板显示为强度下拉而非三个重复行
* **兼容：** 旧配置仍带后缀的请求会自动拆为 base+effort 并在 `doctor` 报告 `DEPRECATED_MODEL_EFFORT_SUFFIX`，建议改用新方式

操作：若你曾配过 `-high` 后缀，只需把 `model` 改为 base 名称，并在 DSH 会话中选择强度。

## 2. 设置中可选显示模型

新增 `Config.visibleModels: string[]`，空表示显示全部发现模型，非空则仅显示勾选的 base id。

```yaml
visibleModels:
  - gemini-3.7-flash
  - gemini-3.1-pro
model: gemini-3.7-flash
```

* 面板通过 `registerModelDiscovery('dsh-agy-provider')` 拿到发现列表后渲染为多选勾选框，勾选结果写回 `visibleModels`
* 未勾选的模型不在选择器出现，但显式 `model: xxx` 请求仍兼容
* `src/provider/agy.ts:effectiveModels()` 按此过滤

操作：升级后在 DSH 设置面板勾选常用模型即可简化选择器。

## 3. 工作区无感化 — 废弃 workspaceRoot

**之前：** `workspace-write` 需 `workspaceRoot: /path`，否则工具不可用。

**之后：** `dsh-owned`（0.7 起默认）下项目目录由 DSH Session 的 `header.cwd` + `workspaceRegistry` + `sandboxPolicy` 自动校验，`src/provider/agy.ts:resolveAgyAgentRuntime` 在 `dsh-owned` 时强制 `workspaceRoot=undefined`。

* `Config.workspaceRoot` 标记 `.deprecated()`，面板在 `dsh-owned` 时隐藏
* 纯文本请求无需 workspace 即可用；有工具请求在无 workspace 时返回可操作的 `DSH_WORKSPACE_MISMATCH` 与 `doctor` 建议
* `doctor v5`（`profileSchemaVersion: 4`）新增 `workspaceSource: dsh-session-cwd` 与 `DEPRECATED_WORKSPACE_ROOT` 警告

操作：若你曾配过 `workspaceRoot` 且 `toolPolicy: dsh-owned`，直接删除该字段；在 DSH Web 打开项目文件夹即可，无需再配。

```yaml
# 删除前
toolPolicy: dsh-owned
workspaceRoot: C:\\work\\my-project

# 删除后
toolPolicy: dsh-owned
# 无需 workspaceRoot，DSH 会话目录即项目
```

legacy `agy-owned` 仍支持显式 `workspaceRoot`，但面板会提示迁移到 `dsh-owned`。

## 4. 设置面板中/英切换

`src/provider/config.ts` 的每个字段通过 `schemastery .i18n({'zh-CN':{},en:{}})` 提供双语描述，DSH Web 按当前 locale（`zh-CN/en`）自动切换。无需额外配置。

## 5. 兼容规则

| 旧配置 | 0.9.0 行为 |
|-------|-----------|
| `model: gemini-3.7-flash-high` | 自动拆为 base `gemini-3.7-flash` + effort `high`，warning |
| `workspaceRoot` + `dsh-owned` | 忽略，doctor `DEPRECATED_WORKSPACE_ROOT` warning |
| `workspaceRoot` + `agy-owned` | 仍校验，提示迁移 |
| 无 workspace 的文本请求 | 直接可用 |
| 无 workspace 的工具请求 | `DSH_WORKSPACE_MISMATCH` 可操作错误 |
| 未设 `visibleModels` | 显示全部 |
| `visibleModels: ["a"]` | 仅显示 a 的 base 模型 |

## 6. 升级步骤

1. 升级包：`npx @deepseek-ai/dsh plugin --profile web add dsh-agy-provider@0.9.0`
2. 打开 DSH 设置面板：启用 AGY、勾选可见模型、选择默认 base 模型、在会话中选择推理强度
3. 若曾配 `workspaceRoot` 且为 `dsh-owned`，删除该字段
4. 若曾用 `-high` 后缀，改为 base
5. 运行 `npx dsh-agy-provider doctor --profile web --json` 确认 `profileSchemaVersion:4`、`workspaceSource:dsh-session-cwd`、无 deprecation

## 7. 回滚

如需回滚：`npx @deepseek-ai/dsh plugin --profile web add dsh-agy-provider@0.8.0`，旧的 `-high` 后缀与 `workspaceRoot` 在 0.8.0 仍可用（但不再推荐）。
