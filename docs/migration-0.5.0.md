# 0.5.0 迁移说明

0.5.0 的重点是 DSH profile onboarding 和可诊断性，不改变 one-shot AGY transport、`sessionMode: full` 默认值或 AGY 独占工具执行边界。

## 安装方式变化

DSH Web/headless 使用独立 profile。请通过 DSH 原生 plugin 命令安装：

```powershell
npx @deepseek-ai/dsh plugin --profile web add dsh-agy-provider@0.5.0
```

普通 `npm install dsh-agy-provider` 仍只适用于 Node.js 代码导入，不会把包加入 DSH profile，也不会触发 postinstall 自动改写用户配置。

## 默认值变化

用户显式执行 `dsh plugin add` 后，bundle patch 默认配置为：

```yaml
enabled: true
provider: agy
model: gemini-3.1-pro-high
toolPolicy: agy-owned
agent: deepseek-proxy
sessionMode: full
```

该默认值只作用于 DSH profile bundle。库级 `Config({})` 和公开入口 `Config({})` 仍为 `enabled: false`、`toolPolicy: reject`，避免改变嵌入式调用者的安全行为。`BundleConfig({})` 可供需要 ready defaults 的显式调用方使用。

如果必须严格拒绝 DSH tool schemas，可在目标 profile 的 `cordis.patch.yml` 中覆盖：

```yaml
- id: dsh-agy-provider
  config:
    toolPolicy: reject
```

此时 DSH Web 传入非空 tools 会返回 `UNSUPPORTED_TOOLS`，错误会提示切换回 `toolPolicy: agy-owned`；这不是权限自动批准开关。

## Doctor

安装后运行：

```powershell
npx dsh-agy-provider doctor --profile web --json
```

Doctor 只执行 quota-free 检查：AGY `--version`、`agents`、`models` 和可选 DSH `--dump-config`。它不发送 Prompt、不执行工具、不修改 profile，输出中的 `quotaUsed` 固定为 `false`。

如果 DSH JavaScript entry 不在当前 profile 或 PATH，显式传入：

```powershell
npx dsh-agy-provider doctor --profile web `
  --dsh-bin C:\path\to\node_modules\@deepseek-ai\dsh\lib\bin.js
```

常见问题及修复：

| code | 含义 | 修复 |
|------|------|------|
| `PROFILE_PACKAGE_MISSING` | Provider 不在 profile dependency | 重新执行 `dsh plugin --profile web add dsh-agy-provider@0.5.0` |
| `PROFILE_BUNDLE_MISSING` | dependency 未进入 bundle layer | 重新执行上述 plugin add 命令 |
| `PROFILE_BUNDLE_DISABLED` | profile 覆盖关闭了 Provider | 删除覆盖或设置 `enabled: true` |
| `PROFILE_TOOL_POLICY_REJECT` | Web 默认 schemas 与严格策略冲突 | 设置 `toolPolicy: agy-owned`，或接受 DSH tools 被拒绝 |
| `AGY_AGENT_MISSING` | `deepseek-proxy` 不可用 | 检查 `agy agents` 和 Agent 配置 |

## 卸载与回滚

从指定 profile 移除：

```powershell
npx @deepseek-ai/dsh plugin --profile web remove dsh-agy-provider
```

回滚到 0.4.x 时仍需手工在 profile patch 中设置 `enabled: true`，并根据 Web 是否传入 tools 选择 `reject` 或 `agy-owned`；0.4.x 不包含 0.5.0 的 doctor CLI。
