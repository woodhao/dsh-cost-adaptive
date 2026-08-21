# dsh-cost-adaptive

[English](README.md) | [中文](README.zh.md)

DeepSeek Harness 的自适应上下文成本守卫插件。它观察真实的会话流量——工具结果大小与每轮 token 用量——把观察结果折叠进跨会话的持久化统计文件，并向系统提示注入一小段学习得来的成本指导。用得越多，它就越能精确地点出哪些工具在浪费上下文，让后续轮次在超大的工具结果与冗余工具调用上花更少的 token。

它是对 DeepSeek Harness [compaction](https://github.com/deepseek-ai/deepseek-harness) 家族（上下文溢出时重写历史）与 [tool-result pruner](https://github.com/deepseek-ai/deepseek-harness)（丢弃已被摘要的工具结果）的补充：`dsh-cost-adaptive` 在**溢出之前**起作用——它学习哪些工具反复返回超大的结果，并从一开始就提示模型把这些结果保持小。

## 安装

已发布到 npm registry：

```sh
npm install dsh-cost-adaptive
# 或：pnpm add dsh-cost-adaptive
```

源码与问题追踪：[github.com/woodhao/dsh-cost-adaptive](https://github.com/woodhao/dsh-cost-adaptive)。

Peer 依赖（均已发布到 npm）：

- `@deepseek-ai/cordis` >= 4.0.1
- `@deepseek-ai/dsh-session` >= 0.1.0-rc.8
- `@deepseek-ai/dsh-system-prompt` >= 0.1.0-rc.8
- `@deepseek-ai/dsh-command-feedback` >= 0.1.0-rc.8（可选，用于显式反馈）
- `@deepseek-ai/dsh-compaction-tool-result-pruner` >= 0.1.0-rc.8（可选，用于自适应裁剪）
- `@deepseek-ai/dsh-settings` >= 0.1.0-rc.8（可选，用于运行时设置）
- `@deepseek-ai/dsh-invariants` >= 0.1.0-rc.8（可选，用于 invariant 配套）
- `@deepseek-ai/schemastery` >= 3.18.1

## 插件（命名空间：`cost-adaptive`）

函数/命名空间插件（`name` / `inject` / `apply`），不是服务。它消费 `ctx.sessions` 的会话事件（`tool/call`、`tool/result`、`assistant/message`、`feedback/record`、`turn/end`）与 `ctx.systemPrompt` 的 section。它依赖 `dsh-session` 与 `dsh-system-prompt`；settings 服务与 token meter 均为可选。当挂载 tool-result pruner 时，插件会用学习到的浪费统计驱动其运行时阈值。

```yaml
- id: cost-adaptive
  name: 'dsh-cost-adaptive'
  config:
    minCalls: 3
```

### 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `thresholdChars` | `8192` | 结果大小阈值（以码点计）；`tool/result` 的文本内容超过它即计入该工具的 oversized 结果。 |
| `minCalls` | `3` | 一个工具的记录能影响指导前，所需的最少观察调用次数。 |
| `maxLines` | `2` | 每次系统提示组装时注入的最大指导行数。 |
| `statsPath` | `$DSH_HOME/cost-adaptive/stats.json` | 跨会话统计文件；原子写入（tmp + rename）并自动创建父目录。 |
| `flushEveryTurns` | `1` | 每 N 个关闭的轮次后持久化一次快照。 |
| `disabled` | `false` | 完全禁用观察、持久化与指导。 |

配置默认值声明在 schemastery `Config` schema 中；`resolveConfig` 对来自 settings 服务的部分用户覆盖重新应用同样的默认值。优先级：schema 默认值 < 学习得到的统计文件 < 用户设置。

### 行为

1. **观察。** 对每个会话监听 `tool/call`（记录 call-id → 工具名映射）、`tool/result`（通过 `toolResultChars` 汇总文本块码点数）、`assistant/message`（当适配器报告 token 账目时读取 `usage.inputTokens` / `outputTokens`）、`feedback/record`（点名某个工具为上下文浪费者的显式人工反馈）与 `turn/end`（关闭每轮缓冲区）。
2. **学习。** 在 `turn/end` 时把缓冲的观察通过 `applyObservation` / `applyTurn` 折叠进内存快照：每个工具的被调用次数、oversized 次数与总字符数，外加会话/轮次计数与 token 总量。当 `flushEveryTurns` 周期到期时，快照原子持久化到 `statsPath`。`feedback/record` 立即生效（`applyFeedback`）并马上持久化。
3. **指导。** `ctx.systemPrompt.section` 注册 `cost-adaptive:guidance` section（`order: 150`），其文本在每次组装时基于当前快照求值。一条工具记录只有在观察次数达到 `minCalls`、或被显式反馈确认为浪费者（标记 `[confirmed]`）时才发言；每行点名该工具与其浪费量（`oversized` 结果数），按浪费量排序、反馈使权重加倍，上限为 `maxLines`。未学到任何内容时 section 渲染为空——**零提示成本**。
4. **收紧。** 当挂载 tool-result pruner 时，每次统计更新都会从观察到的浪费比例派生一个自适应裁剪阈值（`derivePrunerThreshold`）并驱动 `toolResultPruner.updateThresholds`，使会话显示的浪费越多、pruner 越早开始裁剪——而不触碰其配置的头部/尾部预算。

### 持久化统计

统计文件带版本号（`STATS_VERSION`）。损坏、非对象或未来版本的文件在加载时 loud 失败；文件缺失则从空开始。加载失败降级为空快照并给出警告，而不是阻塞插件。写入是原子的（先写 tmp 再 rename），崩溃不会留下撕裂的快照。

### 设置

当挂载 settings 服务时，插件注册 `cost-adaptive` 命名空间，使 `disabled` 与阈值可以在运行时修改（例如 `dsh-settings` 文件 provider）。更新自下一个事件或组装起生效；指导 section 每次组装都会重新求值，因此设置变更会到达紧接着的下一次请求。

## 模型体验

### 学习得到的成本指导（条件性）

#### 模型看到什么

一段简短的、可选的系统提示 section，点名其结果反复超大的工具，例如：

##### 超大工具结果提醒

```markdown
Cost guidance: oversized tool results waste context. Keep output small: grep (3 oversized, 5 calls), read (2 oversized, 4 calls).
```

#### Token 影响

未学到任何内容时为零 token（section 不存在，提示与不启用插件时逐字节相同）。一旦学到，每行指导在每次组装中增加约 40–80 token（`maxLines` 封顶总量）；当指导防止一个超大工具结果（通常是数千码点）进入上下文时，这点成本被成倍赚回。

#### KV Cache 影响

指导 section 是统计快照的函数，因此其文本仅在快照变化时变化；未变化的组装精确复用上一次的提示前缀，不会使既有 KV-cache 条目失效。

## Codex 集成

同一套学习型省钱机制可以在 Codex（OpenAI 的编程智能体）里运行，共用同一个 `stats.json` 账本。原生 hook 桥覆盖 Codex 命令行版，旁路监视器覆盖桌面版（桌面版不运行 hooks）。安装与用法见 [codex/](codex/README.zh.md)。

## 开发

```sh
pnpm install
pnpm run check   # test + typecheck + build
```

## 许可证

MIT © 2026 woodhao。见 [LICENSE](LICENSE)。
