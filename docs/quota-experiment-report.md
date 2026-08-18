# V2-M5 真实额度实验报告

日期：2026-08-18
平台：Windows 11
AGY：`1.1.14`
Agent：`deepseek-proxy`
Model：`gemini-3.1-pro-high`

## 预算与止损

| 项目 | 上限 | 实际 |
|------|------|------|
| 实际 AGY 子进程请求 | 12 | 4 |
| `inputTokens` | 60,000 | 22,699 |
| `outputTokens` | 6,000 | 857 |
| 自动重试 | 禁止 | 未发生 |

首组固定执行 `full` 与 `resume` 各 2 轮。只有 `resume` 第二轮相对 `full` 节省至少 20% input tokens，才继续下一组；本组未通过，因此没有继续消耗额度。

## 结果

| 模式 | 第 1 轮 input/output | 第 2 轮 input/output | 两轮 input/output |
|------|----------------------|----------------------|-------------------|
| `full` | 4,472 / 288 | 4,529 / 197 | 9,001 / 485 |
| `resume` | 4,474 / 132 | 9,224 / 240 | 13,698 / 372 |

第二轮比较：

```text
resume 相对 full 的 input token 节省率
= (4529 - 9224) / 4529
= -103.67%
```

本次 `resume` 没有节省输入 token，反而明显增加；两种模式的 `cacheReadTokens` 均为 0。两种模式的两轮响应均为 3 个字符，说明差异主要来自上下文计费，而不是输出长度。

## 决策

- 继续把 `sessionMode: full` 作为默认策略。
- 不实现跨进程持久化 Session store；`resume` 的收益门槛未通过。
- 不再执行本轮 10/30 轮实验，避免在已明显劣势的策略上继续消耗额度。
- 如果未来 AGY 改变 usage 统计、conversation 复用或缓存语义，再以新的明确预算重新触发实验。

已有历史样本也同方向：`full` 第二轮为 4,490 input tokens，`resume` 第二轮为 9,385；本次复测为 4,529 对 9,224。

## 可复测入口

协议与硬限制见 [`quota-experiment.md`](quota-experiment.md)。真实实验需要显式提供 `--live` 和 `AGY_QUOTA_EXPERIMENT=ALLOW`；普通测试、诊断和 CI 不会调用 AGY 模型。
