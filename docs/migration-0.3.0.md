# 0.3.0 迁移说明

当前仓库正在实施 0.3.0，npm `latest` 仍为 `0.2.0`。本页记录已经落地的 V3-M1/V3-M2 行为、V3-M3 工具策略和 V3-M4 fixture transport 闸门；后续里程碑完成后会继续补充。

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
- `modelCatalog.source`：`static`、`discovered`、`merged`、`cache` 或 `fallback`
- `modelCatalog.stale`
- `modelCatalog.warning`
- `modelCatalog.warningCode`：`MODEL_DISCOVERY_FAILED`、`MODEL_DISCOVERY_EMPTY`、`MODEL_DISCOVERY_TIMEOUT` 或 `MODEL_DISCOVERY_OUTPUT_LIMIT`

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
- 两种策略都不自动批准 AGY 权限请求；检测到权限事件立即返回 `PERMISSION_REQUIRED`。持久 stream transport 目前只有隔离 fixture prototype，未接入 `AgyAdapter` 或 public 配置；V3-M2 只增加 reasoning 控制参数映射，不实现 `reasoning-delta` 输出桥接。
- 当前版本不新增真实模型请求，因此模型发现验证不计入 AGY 模型额度预算。

## AGY-owned 工具策略（V3-M3）

0.3.0 新增显式配置：

```yaml
toolPolicy: reject       # 默认；非空 DSH tools 返回 UNSUPPORTED_TOOLS
# toolPolicy: agy-owned  # 仅在 AGY 独占工具执行时启用
```

启用 `agy-owned` 后，Provider 不把 DSH `tools` schema 转换为 AGY 参数，也不把 AGY 内部工具事件转换为 DSH `tool-call-delta` 或 tool block；它只继续发送文本 system/messages。这样不会形成两个 Agent loop，但也意味着模型不会按 DSH tool 协议调用这些 schema。日志只记录策略和值数量（`toolPolicy`、`toolSchemaCount`），不记录参数。

该策略不是权限绕过开关。AGY 产生 `permission_request`、`ask_permission` 或 permission step 时，两种配置都立即终止并返回 `PERMISSION_REQUIRED`，Provider 不会自动传入 `--dangerously-skip-permissions`。

## 持久 stream transport（V3-M4）

V3-M4 已通过无额度 fixture gate，验证 100 轮串行、8 Session 并发、worker/session 隔离、故障 reset、崩溃恢复、idle TTL、abort/timeout 和进程树回收。实现只位于隔离实验模块，默认 one-shot、`sessionMode: full` 和 0.2.0 兼容行为均不变。

当前没有 `transport: persistent` 等 public 配置，也没有真实 AGY `--input-format stream-json` 对照结果。不要从内部 prototype 路径导入并用于生产；真实协议与 3+3 收益门槛通过后，才会另行发布显式 experimental 配置。完整边界和复验结果见 [V3-M4 实验报告](experimental-stream-transport.md)。

## 诊断与安全加固（V3-M5）

机器诊断仍使用 `schemaVersion: 1`，但 `modelCatalog` 现在明确区分：

- `static`：关闭动态发现，只使用配置目录。
- `discovered`：没有静态目录，本次 `agy models` 成功。
- `merged`：静态目录与本次动态目录合并。
- `cache`：发现失败，使用最近成功的内存缓存。
- `fallback`：没有缓存，使用静态配置回退。

发现失败时提供 `warningCode`：`MODEL_DISCOVERY_FAILED`、`MODEL_DISCOVERY_EMPTY`、`MODEL_DISCOVERY_TIMEOUT` 或 `MODEL_DISCOVERY_OUTPUT_LIMIT`。这些失败不会阻断静态模型调用路径，`quotaUsed` 仍固定为 `false`。

结构化日志仅保留白名单的 `reasoningEffort`、`toolPolicy`、`toolSchemaCount`、`modelDiscoverySource` 和 `modelDiscoveryWarningCode` 等元数据；不会记录 Prompt、完整用户路径、stderr、Token 或凭据。
