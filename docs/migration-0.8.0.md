# 0.8.0 迁移说明

0.8.0 在保留 0.7.0 DSH-owned 工具所有权的前提下，新增 persistent `stream-json` 传输作为稳定 opt-in。

## 推荐升级

先在目标 DSH profile 安装 0.8.0：

```powershell
npx @deepseek-ai/dsh plugin --profile web add dsh-agy-provider@0.8.0
npx @deepseek-ai/dsh plugin --profile headless add dsh-agy-provider@0.8.0
```

启动前只读检查：

```powershell
npx dsh-agy-provider doctor --profile web --json
npx @deepseek-ai/dsh --profile web --dump-config | Select-String dsh-agy-provider
```

期望 bundle 配置（0.8.0 保持 0.7.0 默认，新增 transport 显式 opt-in）：

```yaml
enabled: true
provider: agy
agent: deepseek-proxy
toolPolicy: dsh-owned
sessionMode: full
transport: one-shot # 默认，保持 0.7.0 行为；显式设 persistent 才启用
persistentIdleTtlMs: 30000
persistentReadyTimeoutMs: 10000
persistentFallback: before-accept
imageInput: off
```

## 行为变更

- `transport: one-shot` 保持 0.7.0 行为（每请求一 AGY 进程），为 0.8.0 默认。
- `transport: persistent` 为 opt-in：同一 DSH session 复用单一 AGY stream-json worker，warm-turn 首事件约 79% 改善（实测 15880ms -> 3314ms），累计 input 增幅约 5.5%。
- 写入后不自动回退 one-shot，符合额度安全；`persistentFallback: before-accept` 仅在启动/写入前失败时回退。
- 图片仍为 `imageInput: experimental` text-only，0.8.0 不公开 image modality。

## 回滚

```powershell
npx @deepseek-ai/dsh plugin --profile web add dsh-agy-provider@0.7.0
npx @deepseek-ai/dsh plugin --profile headless add dsh-agy-provider@0.7.0
```

回滚后删除 `transport` 相关覆盖，重新运行对应版本 doctor。
