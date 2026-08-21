# Codex 集成

把 dsh-cost-adaptive 的学习型省钱机制带到 **Codex**（OpenAI 的编程智能体）。提供两条通道：

| 通道 | 作用 | 要求 |
|---|---|---|
| **CLI hook**（`codex-hook.mjs`） | 通过 Codex 原生 hooks 运行同一套省钱算法：观察工具结果（`PostToolUse`）、记录轮次（`Stop`）、每轮注入学习到的成本指导（`UserPromptSubmit`）。 | Codex **命令行版**——**桌面版不运行 hooks**（[openai/codex#21639](https://github.com/openai/codex/issues/21639)）。 |
| **桌面版旁路**（`desktop-watch.mjs`） | 监视桌面版 App 的会话记录，把每次工具结果折入同一账本，并刷新成本指导文件供 App 在开会话时读取。只负责记账/学习——桌面版没有每轮注入的口子。 | ChatGPT 桌面版 App；绕开桌面版坏掉的 hooks。 |

两条通道与 DeepSeek Harness 插件、npm 包共用同一个 `stats.json` 账本和同一套纯函数，一处学习、处处受益。只在当前模型是 DeepSeek 模型时生效（payload 的 `model` 字段含 `deepseek`）；其他模型零开销放行。

## 安装

所有脚本都依赖 `dsh-cost-adaptive` npm 包，先在 hooks 目录安装：

```sh
mkdir -p ~/.codex/hooks
cp codex/codex-hook.mjs codex/desktop-watch.mjs codex/status.mjs codex/watch.mjs ~/.codex/hooks/
cd ~/.codex/hooks && npm init -y && npm install dsh-cost-adaptive
```

### 1. CLI hooks

在 `~/.codex/config.toml` 启用：

```toml
[features]
hooks = true
```

在 `~/.codex/hooks.json` 注册三个事件：

```json
{
  "hooks": {
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "node ~/.codex/hooks/codex-hook.mjs", "timeout": 30 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node ~/.codex/hooks/codex-hook.mjs", "timeout": 30 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node ~/.codex/hooks/codex-hook.mjs", "timeout": 30 }] }]
  }
}
```

一次性任务用 `codex exec --enable hooks ...`；交互式 TUI 会自动读取 config 里的 `hooks = true`。首次运行 Codex 可能要求信任 hook 来源——选允许。

### 2. 桌面版旁路

后台运行监视器（或用 launchd 自启）：

```sh
node ~/.codex/hooks/desktop-watch.mjs
```

它读取桌面版 App 在 `~/.codex/sessions` 下的会话记录，把每次工具结果折入 `stats.json`，把逐次观察历史追加到 `stats.json` 同目录的 `history.jsonl`，并把学习到的指导写入 `~/.codex/cost-guidance.md`。

让 App 真正读到指导：在 `~/.codex/AGENTS.md` 末尾追加一行：

```markdown
* 执行工具时，若 `~/.codex/cost-guidance.md` 存在，必须阅读并遵守其中的成本指导：控制大输出工具的规模，能少输出就少输出。
```

监视器带单实例锁（拒绝第二个实例），且只处理从未读过的会话字节，重启不会重放历史。

### 3. 账本看板

两条命令查看账本和学习趋势：

```sh
# 一次快照 + 趋势（最近 10 次 vs 之前 10 次的平均输出字符）
node ~/.codex/hooks/status.mjs

# 实时监视：账本或历史变化时自动重绘
node ~/.codex/hooks/watch.mjs
```

想用短命令，把它们链接到 PATH：

```sh
ln -sf ~/.codex/hooks/status.mjs ~/.local/bin/dsh-cost-stats
ln -sf ~/.codex/hooks/watch.mjs ~/.local/bin/dsh-cost-watch
```

趋势行是判断省钱是否生效的诚实指标：最近输出比之前变小，说明指导起作用了。

## 文件清单

| 文件 | 作用 |
|---|---|
| `codex-hook.mjs` | Codex CLI 原生 hook 桥（PostToolUse / Stop / UserPromptSubmit） |
| `desktop-watch.mjs` | 桌面版旁路：会话监视 + 记账 + 指导刷新 + 历史记录 |
| `status.mjs` | 单次快照看板 + 趋势（`dsh-cost-stats`） |
| `watch.mjs` | 变化自动重绘的实时看板（`dsh-cost-watch`） |

四个都是纯 ESM 脚本，只依赖 `dsh-cost-adaptive`（npm 包）和 Node 内置模块。
