# `0.2.0` 迁移说明

`0.2.0` 保持 `0.1.0` 的 Provider 路由和文本能力，重点增加诊断、模型目录、事件兼容、跨平台进程清理和发布加固。

## 配置兼容

- 旧的 `model` 配置继续有效，并作为默认/回退模型。
- 新的 `models` 是可选目录，条目使用精确 `id`；重复 ID 会去重。
- `sessionMode` 默认仍为 `full`，不会因升级自动切换到 `resume`。
- `resume` 仍是显式选项；V2-M5 实测未达到 20% input token 节省门槛，因此没有启用持久化 Session store。
- `minimumAgyVersion` 默认仍为 `1.1.13`；当前实机验证为 AGY `1.1.14`。

## 行为变化

- `npm run diagnose -- --json` 返回 `schemaVersion: 1` 和组件级错误信息；诊断不会消耗 AGY 额度。
- AGY 认证、额度、速率限制、模型、Agent、上下文、权限、超时和解析失败使用稳定错误码。
- 日志增加固定事件类别计数和最终 status，但不输出 Prompt、响应正文、stderr、路径、工具参数或凭据。
- Windows、Ubuntu 和 macOS 的工程级 CI 均执行 typecheck、测试、打包预览和无额度 benchmark；真实 AGY 仍只在 Windows 人工触发。

## 升级建议

```powershell
npm install dsh-agy-provider@0.2.0
npm run diagnose -- --json
```

如果使用 DSH bundle，升级后重新运行一次无额度 Mock smoke test，再使用已有配置发起真实请求。真实请求仍会消耗 AGY 账号额度。

## 仍不支持

DSH tools、图像/多模态内容、完整采样参数、`reasoningEffort`、`stop`、`maxTokens` 和跨进程 Session 持久化仍不属于本版本能力。
