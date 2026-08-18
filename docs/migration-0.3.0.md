# 0.3.0 迁移说明

当前仓库正在实施 0.3.0，npm `latest` 仍为 `0.2.0`。本页记录已经落地的 V3-M1/V3-M2 行为以及 V3-M3 工具策略，后续里程碑完成后会继续补充。

## 动态模型发现

0.3.0 默认将 `modelDiscovery` 设为 `auto`。Provider 会调用本机已登录的 `agy models`，读取可用模型目录，并把动态模型提供给 DSH 的 `listModels()`。

目录合并规则如下：

1. 显式 `models` 保持原有顺序。
2. 同一个 `id` 的显式名称、描述和其他 metadata 优先。
3. 动态发现到但未显式配置的模型追加在目录末尾。
4. 旧版 `model` 仍作为默认/回退模型；请求方明确传入的未知 ID 仍原样交给 AGY。

发现结果只保存在当前进程内，不写入磁盘。默认缓存 TTL 为 300000 ms，单次命令超时为 10000 ms；可通过以下配置调整：

```yaml
modelDiscovery: auto       # auto | off
modelDiscoveryTtlMs: 300000
modelDiscoveryTimeoutMs: 10000
```

如果 AGY 命令失败、超时、退出码非零或输出没有可用模型，Provider 会优先使用最近一次成功缓存；没有缓存时使用静态 `model`/`models` 配置。失败不会阻断基础文本请求。

如需完全保持 0.2.0 的静态目录行为：

```yaml
modelDiscovery: off
```

## 诊断变化

`npm run diagnose -- --json` 现在会额外执行 quota-free 的 `agy models`，仍然不发送 Prompt、不调用模型、不执行工具，并保持 `quotaUsed: false`。输出增加：

- `configuration.modelDiscovery`
- `modelCatalog.source`：`configured`、`discovered`、`cache` 或 `fallback`
- `modelCatalog.stale`
- `modelCatalog.warning`

warning 只返回稳定的通用错误描述，不包含本机路径、环境变量、Prompt、stderr 或凭据。

## Reasoning effort（V3-M2）

Provider 现在为每个 AGY 模型公开三档 reasoning metadata：`low`、`medium`、`high`。不设置 `defaultEffort`，因此未指定请求级 effort 时保留 AGY/模型自身默认值。

请求级调用可以传入：

```ts
reasoningEffort: 'high'
```

合法值会以独立参数传给 AGY：

```text
--effort high
```

Provider 不把 effort 拼进 Prompt 或 shell 字符串。非法值返回稳定错误码 `UNSUPPORTED_REASONING_EFFORT`，并且在 AGY 进程启动前失败。`temperature`、`stop` 和 `maxTokens` 仍不支持。

## 兼容性与边界

- 0.2.0 的 `model`、`models`、`agent`、`agyPath` 和会话配置保持兼容。
- 动态目录刷新发生在 `listModels()`；如果 DSH UI 已缓存模型选择器，需要重新加载 profile。
- `toolPolicy` 默认是 `reject`，与 0.2.0 一致；显式 `toolPolicy: agy-owned` 时忽略 DSH tool schemas，不生成 DSH tool chunks，AGY 继续作为唯一工具执行者。
- 两种策略都不自动批准 AGY 权限请求；检测到权限事件立即返回 `PERMISSION_REQUIRED`。持久 stream transport 尚未实施；V3-M2 只增加 reasoning 控制参数映射，不实现 `reasoning-delta` 输出桥接。
- 当前版本不新增真实模型请求，因此模型发现验证不计入 AGY 模型额度预算。

## AGY-owned 工具策略（V3-M3）

0.3.0 新增显式配置：

```yaml
toolPolicy: reject       # 默认；非空 DSH tools 返回 UNSUPPORTED_TOOLS
# toolPolicy: agy-owned  # 仅在 AGY 独占工具执行时启用
```

启用 `agy-owned` 后，Provider 不把 DSH `tools` schema 转换为 AGY 参数，也不把 AGY 内部工具事件转换为 DSH `tool-call-delta` 或 tool block；它只继续发送文本 system/messages。这样不会形成两个 Agent loop，但也意味着模型不会按 DSH tool 协议调用这些 schema。日志只记录策略和值数量（`toolPolicy`、`toolSchemaCount`），不记录参数。

该策略不是权限绕过开关。AGY 产生 `permission_request`、`ask_permission` 或 permission step 时，两种配置都立即终止并返回 `PERMISSION_REQUIRED`，Provider 不会自动传入 `--dangerously-skip-permissions`。
