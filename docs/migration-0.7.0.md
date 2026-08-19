# 0.7.0 迁移说明

0.7.0 将 DSH bundle 的默认工具所有权从 0.6.x legacy `agy-owned` 切换为 `dsh-owned`。AGY 仍然是模型和额度入口，但项目目录、权限、工具执行和审批全部由 DSH 当前 Session 与 ToolRuntime 控制。

## 推荐升级

先在目标 DSH profile 安装 0.7.0：

```powershell
npx @deepseek-ai/dsh plugin --profile web add dsh-agy-provider@0.7.0
npx @deepseek-ai/dsh plugin --profile headless add dsh-agy-provider@0.7.0
```

启动前可以只读检查有效配置：

```powershell
npx dsh-agy-provider doctor --profile web --json
npx @deepseek-ai/dsh --profile web --dump-config | Select-String dsh-agy-provider
```

期望 bundle 配置包含：

```yaml
enabled: true
provider: agy
agent: deepseek-proxy
toolPolicy: dsh-owned
sessionMode: full
imageInput: off
```

## 权限和工具行为

0.7.0 不新增第二套权限开关。DSH UI/Session 选择的模式是唯一权威：

| DSH 模式 | 允许的工具行为 |
|---|---|
| `read-only` | 可读和搜索；write/edit/shell 写入被 DSH 拒绝 |
| `workspace-write` | 项目 Session workspace 内的 write/edit/shell 写入；越界仍由 DSH sandbox/approval 拒绝 |
| `danger-full-access` | 由 DSH 明确选择后允许越过 workspace 边界；Provider 不自行提升权限 |

文件、shell、网络和 MCP 工具由 DSH ToolRuntime 执行。Provider 只把经 bounded prompt contract、本地 allowlist 和参数边界校验后的 tool call 返回给 DSH；它不调用 `ctx.tools.execute()`，不 spawn 工具进程，也不传 `--dangerously-skip-permissions`。

项目目录来自 DSH live Session 的 canonical `cwd`。0.7.0 的 `dsh-owned` 路径不要求重复配置 `workspaceRoot`；如果旧配置仍包含该字段，它不能覆盖 DSH Session workspace。

## 0.6.x legacy 兼容

需要保持 AGY 自有工具执行的旧 profile 可以暂时继续使用：

```yaml
toolPolicy: agy-owned
```

该模式只应作为迁移过渡：DSH tool schemas 会被忽略，AGY Agent 仍是唯一工具执行者，DSH 的 permission matrix 不会完整约束 AGY 内部工具。doctor v3 会报告 legacy warning，不会自动改写 profile。

`toolPolicy: reject` 仍然适合程序化调用和严格禁止工具 schema 的场景；收到非空 DSH tools 时返回稳定的 `UNSUPPORTED_TOOLS`。

## 识图边界

0.7.0 仍不宣称公开 image modality。`imageInput: experimental` 的 AttachmentStore staging 仅用于受控实验，公开 model metadata 继续为 `inputModalities: ["text"]`。

## 回滚

如需回滚到 0.6.1：

```powershell
npx @deepseek-ai/dsh plugin --profile web add dsh-agy-provider@0.6.1
npx @deepseek-ai/dsh plugin --profile headless add dsh-agy-provider@0.6.1
```

回滚后删除只属于 0.7.0 的 `toolPolicy: dsh-owned`、DSH bridge 相关覆盖项，并重新运行对应版本的 doctor。不要复用 0.7.0 的 bundle patch 或 tag。

