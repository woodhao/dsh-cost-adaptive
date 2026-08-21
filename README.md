# dsh-cost-adaptive

[English](README.md) | [中文](README.zh.md)

Self-adapting context-cost guard for DeepSeek Harness. The plugin watches real session traffic — tool-result sizes and per-turn token usage — folds the observations into a durable cross-session statistics file, and injects a short, learned cost-guidance section into the system prompt. The more it is used, the more precisely it names the tools that are wasting context, so later turns spend fewer tokens on oversized results and redundant tool calls.

It complements the DeepSeek Harness [compaction](https://github.com/deepseek-ai/deepseek-harness) family (which rewrites history when context overflows) and the [tool-result pruner](https://github.com/deepseek-ai/deepseek-harness) (which discards tool results already summarized): `dsh-cost-adaptive` works **before** the overflow — it learns which tools repeatedly return oversized results and tells the model to keep those results small in the first place.

## Install

Published on the npm registry:

```sh
npm install dsh-cost-adaptive
# or: pnpm add dsh-cost-adaptive
```

Source and issue tracker: [github.com/woodhao/dsh-cost-adaptive](https://github.com/woodhao/dsh-cost-adaptive).

Peer requirements (all published on npm):

- `@deepseek-ai/cordis` >= 4.0.1
- `@deepseek-ai/dsh-session` >= 0.1.0-rc.8
- `@deepseek-ai/dsh-system-prompt` >= 0.1.0-rc.8
- `@deepseek-ai/dsh-command-feedback` >= 0.1.0-rc.8 (optional, for explicit feedback)
- `@deepseek-ai/dsh-compaction-tool-result-pruner` >= 0.1.0-rc.8 (optional, for adaptive pruning)
- `@deepseek-ai/dsh-settings` >= 0.1.0-rc.8 (optional, for runtime settings)
- `@deepseek-ai/dsh-invariants` >= 0.1.0-rc.8 (optional, for the invariant companion)
- `@deepseek-ai/schemastery` >= 3.18.1

## Plugin (namespace: `cost-adaptive`)

A function/namespace plugin (`name` / `inject` / `apply`), not a service. It consumes `ctx.sessions` session events (`tool/call`, `tool/result`, `assistant/message`, `feedback/record`, `turn/end`) and `ctx.systemPrompt` sections. It requires `dsh-session` and `dsh-system-prompt`; both the settings service and the token meter are optional. When the tool-result pruner is mounted, the plugin drives its runtime threshold from the learned waste statistics.

```yaml
- id: cost-adaptive
  name: 'dsh-cost-adaptive'
  config:
    minCalls: 3
```

### Config

| Key | Default | Meaning |
|---|---|---|
| `thresholdChars` | `8192` | Result-size threshold in code points; a `tool/result` text content above it counts as an oversized result for that tool. |
| `minCalls` | `3` | Minimum observed calls before a tool's record may influence guidance. |
| `maxLines` | `2` | Maximum guidance lines injected per system-prompt assembly. |
| `statsPath` | `$DSH_HOME/cost-adaptive/stats.json` | Cross-session statistics file; created atomically (tmp + rename) with its parent directory. |
| `flushEveryTurns` | `1` | Persist the snapshot after every N closed turns. |
| `disabled` | `false` | Disable observation, persistence, and guidance entirely. |

Config defaults are declared in the schemastery `Config` schema; `resolveConfig` re-applies the same defaults to partial user overrides from the settings service. Precedence: schema defaults < learned statistics file < user settings.

### Behavior

1. **Observes.** For each session it listens to `tool/call` (records the call-id → tool-name map), `tool/result` (sums text-block code points via `toolResultChars`), `assistant/message` (reads `usage.inputTokens` / `outputTokens` when the adapter reported token accounting), `feedback/record` (explicit human feedback naming a tool as a context waster), and `turn/end` (closes the per-turn buffer).
2. **Learns.** At `turn/end` the buffered observation folds into the in-memory snapshot with `applyObservation` / `applyTurn`: per-tool call counts, oversized counts, and total characters, plus session/turn counters and token totals. The snapshot persists atomically to `statsPath` when the `flushEveryTurns` cadence is due. `feedback/record` applies immediately (`applyFeedback`) and persists right away.
3. **Guides.** `ctx.systemPrompt.section` registers a `cost-adaptive:guidance` section (`order: 150`) whose text is evaluated at every assembly from the current snapshot. A tool record only speaks when it has at least `minCalls` observations, or when explicit feedback confirmed it as a waster (marked `[confirmed]`); each line names the tool and its waste (`oversized` results), ranked by waste with feedback doubling the weight, capped at `maxLines`. With nothing learned the section renders empty — **zero prompt cost**.
4. **Tightens.** When the tool-result pruner is mounted, every stats update derives an adaptive pruning threshold (`derivePrunerThreshold`) from the observed waste ratio and drives `toolResultPruner.updateThresholds`, so the pruner starts cutting earlier the more waste the sessions show — without touching its configured head/tail budgets.

### Durable statistics

The statistics file is versioned (`STATS_VERSION`). A corrupt, non-object, or future-version file fails loud on load; a missing file starts empty. A load failure degrades to an empty snapshot with a warning instead of blocking the plugin. Writes are atomic (write tmp, then rename) so a crash never leaves a torn snapshot.

### Settings

When the settings service is mounted, the plugin registers the `cost-adaptive` namespace so `disabled` and the thresholds can be changed at runtime (e.g. `dsh-settings` file provider). Updates apply from the next event or assembly; the guidance section is re-evaluated per assembly, so a settings change reaches the very next request.

## Model Experience

### Learned cost guidance (conditional)

#### What the model sees

A short, optional system-prompt section listing tools whose results have repeatedly been oversized, for example:

##### Oversized tool results reminder

```markdown
Cost guidance: oversized tool results waste context. Keep output small: grep (3 oversized, 5 calls), read (2 oversized, 4 calls).
```

#### Token effect

Zero tokens while nothing is learned (the section is absent, so the prompt is byte-identical to running without the plugin). Once learned, each guidance line adds roughly 40–80 tokens per assembly (`maxLines` caps the total); this is paid back many times over when the guidance prevents one oversized tool result (typically thousands of code points) from entering context.

#### KV Cache effect

The guidance section is a function of the statistics snapshot, so its text changes only when the snapshot changes; unchanged assemblies reuse the exact previous prompt prefix and do not invalidate existing KV-cache entries.

## Development

```sh
pnpm install
pnpm run check   # test + typecheck + build
```

## License

MIT © 2026 woodhao. See [LICENSE](LICENSE).
