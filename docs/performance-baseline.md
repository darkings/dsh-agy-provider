# 性能基线

验证日期：2026-08-18
环境：Windows 11、Node.js `v24.18.0`

执行命令：

```powershell
npm run benchmark
```

当前结果（开发机单次运行，不作为发布 SLA）：

| 项目 | 工作量 | 结果 |
|------|--------|------|
| NDJSON Parser | 20,000 个 `step_update` 事件 | 26.047 ms，约 767,852 events/s |
| Prompt serializer | 5,000 次固定文本序列化 | 2.034 ms |
| Concurrency limiter | 5,000 次 acquire/release | 1.076 ms |

该基线不包含 AGY 网络、模型推理、磁盘 I/O 或真实首 Token 延迟。后续 AGY/DSH 版本变化后，重新执行命令并比较趋势；真实配额请求的首 Token、总耗时和进程内存需要在独立额度窗口中采样。
