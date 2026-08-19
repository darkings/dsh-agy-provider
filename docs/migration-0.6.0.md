# 0.6.0 迁移说明

0.6.0 兼容 0.5.0 的文本 Provider 和 profile 安装方式；没有必须执行的数据迁移。升级重点是可选的 Agent 能力档位、额度安全配置、purpose 路由、experimental 图片 bridge 和 doctor v2。

## 升级安装

DSH Web/headless 继续使用 DSH 原生 profile 安装：

```powershell
npx @deepseek-ai/dsh plugin --profile web add dsh-agy-provider@0.6.0
```

普通 Node.js 导入仍可以单独安装：

```powershell
npm install dsh-agy-provider@0.6.0
```

安装不会发送模型请求，也不会自动写入 AGY Agent。升级后建议先运行：

```powershell
npx dsh-agy-provider doctor --profile web --json
```

## 默认行为

以下兼容默认保持不变：

- `sessionMode: full`。
- `deepseek-proxy` 作为默认 tool-free Agent；现有 Agent 不会被覆盖。
- `toolPolicy: reject` 仍是库级默认；profile bundle 继续使用显式 `agy-owned` 以适配 DSH Web 的上游 tool schemas。
- `imageInput` 不开启，公开模型 capability 仍为 `inputModalities: ['text']`。
- retry 默认 `maxRetries: 0`；不会把一次用户请求隐式放大成多次 AGY 调用。

## 可选 Agent 能力

先查看模板，不消耗额度：

```powershell
npx dsh-agy-provider agents list
```

安装只读档位：

```powershell
npx dsh-agy-provider agents install read-only --apply
```

`read-only` 只允许 `find_by_name`、`grep_search`、`view_file`、`list_dir`。写入档位必须显式指定已有工作区：

```yaml
agentPreset: workspace-write
workspaceRoot: C:\path\to\existing\project
```

`workspace-write` 仅允许文件查找、读取、替换和写入，不包含 shell、`run_command`、网络、浏览器、MCP、subagent 或自动批准权限。工作区必须是非文件系统根目录的现有目录；doctor 会在缺失时给出 `PROFILE_WORKSPACE_REQUIRED`。

## 额度与 purpose 路由

需要显式开启 retry 时，只能使用受限配置：

```yaml
retryPolicy:
  maxRetries: 1
  retryableCodes: [RATE_LIMIT, SERVER, TRANSPORT]
```

`maxRetries` 硬上限为 2。`compaction` 和 `sessionTitle` 可以分别覆盖 `model`、`agent`、`reasoningEffort`；未配置时继承普通请求：

```yaml
purposeRoutes:
  compaction:
    model: gemini-3.7-flash-low
    agent: deepseek-proxy
    reasoningEffort: low
```

## 图片输入边界

0.6.0 不宣称公开 image modality。`imageInput: experimental` 只允许内置 `read-only` 或 `workspace-write` preset，通过 DSH `AttachmentStore` 将受校验的 raster attachment 暂存到每请求私有目录，再交给含 `view_file` 的 Agent；失败会返回稳定错误并清理临时目录。`deepseek-proxy` 或未知 custom Agent 会返回 `IMAGE_AGENT_UNSUPPORTED`。

当前模型目录仍只报告 `inputModalities: ['text']`。不要因为实验 bridge 存在就把任意路径、URL、base64 或通用文件当作图片输入；音频、视频、PDF、DSH tool-call bridge 均不在本版本范围内。

## doctor v2

指定 profile 时，JSON 会包含 `profileSchemaVersion: 2` 和 `effective` snapshot：

- provider/model、Agent 与 frontmatter/tool whitelist；
- `sessionMode`、retry policy、purpose routes；
- workspace 状态、image bridge 状态和公开 text-only modality；
- `dumpStatus` 与只读 `repairSuggestions`。

`--dump-config` 的超时、非零退出和解析失败不再静默降级，分别使用 `PROFILE_DUMP_TIMEOUT`、`PROFILE_DUMP_NONZERO`、`PROFILE_DUMP_PARSE_FAILED`。doctor 始终 `quotaUsed: false`，不自动修复 profile 或覆盖 Agent。

## 回滚

回滚只需把目标 profile 的 package spec 改回 0.5.0，并保留或移除 0.6.0 新增配置：

```powershell
npx @deepseek-ai/dsh plugin --profile web add dsh-agy-provider@0.5.0
```

如果启用了 `workspace-write`、purpose route、retry 或 experimental image，回滚前应删除这些 0.6.0 配置；未安装的 Agent 模板不会影响旧版 `deepseek-proxy`。
