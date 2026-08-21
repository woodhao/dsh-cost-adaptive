# Codex integration

Bring the dsh-cost-adaptive learned cost guard to **Codex** (OpenAI's coding agent). Two channels are provided:

| Channel | What it does | Requirement |
|---|---|---|
| **CLI hook** (`codex-hook.mjs`) | Runs the same learned cost-guard algorithms inside Codex CLI via native hooks: observes tool results (`PostToolUse`), records turns (`Stop`), and injects the learned guidance into every prompt (`UserPromptSubmit`). | Codex **CLI** (terminal) — the **desktop app does not run hooks** ([openai/codex#21639](https://github.com/openai/codex/issues/21639)). |
| **Desktop sidecar** (`desktop-watch.mjs`) | Watches the desktop app's session rollouts and folds every tool result into the same ledger, then refreshes a cost-guidance file that the app reads at session start. Observation/learning only — the desktop app has no hook point for per-turn injection. | ChatGPT desktop app; works around the broken desktop hooks. |

Both share the same `stats.json` ledger as the DeepSeek Harness plugin and the npm package's pure functions, so one deployment's learning feeds every other. Only act when the active model is a DeepSeek model (the payload `model` field contains `deepseek`); every other model passes through with zero overhead.

## Install

All scripts import the `dsh-cost-adaptive` npm package, so first install it in the hooks directory:

```sh
mkdir -p ~/.codex/hooks
cp codex/codex-hook.mjs codex/desktop-watch.mjs codex/status.mjs codex/watch.mjs ~/.codex/hooks/
cd ~/.codex/hooks && npm init -y && npm install dsh-cost-adaptive
```

### 1. CLI hooks

Enable hooks in `~/.codex/config.toml`:

```toml
[features]
hooks = true
```

Register the three events in `~/.codex/hooks.json`:

```json
{
  "hooks": {
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "node ~/.codex/hooks/codex-hook.mjs", "timeout": 30 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node ~/.codex/hooks/codex-hook.mjs", "timeout": 30 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node ~/.codex/hooks/codex-hook.mjs", "timeout": 30 }] }]
  }
}
```

Run `codex exec --enable hooks ...` for one-shot tasks; the interactive TUI reads `hooks = true` from config automatically. On first run Codex may ask you to trust the hook source — approve it.

### 2. Desktop sidecar

Run the watcher in the background (or use a launchd agent for auto-start):

```sh
node ~/.codex/hooks/desktop-watch.mjs
```

It reads the desktop app's session rollouts under `~/.codex/sessions`, folds every tool result into `stats.json`, appends per-observation history to `stats.json`'s sibling `history.jsonl`, and writes the learned guidance to `~/.codex/cost-guidance.md`.

Make the app actually read the guidance: reference the file from `~/.codex/AGENTS.md` (append this line):

```markdown
* 执行工具时，若 `~/.codex/cost-guidance.md` 存在，必须阅读并遵守其中的成本指导：控制大输出工具的规模，能少输出就少输出。
```

The watcher refuses to start a second instance (single-instance lock), and only processes rollout bytes it has not seen before, so restarts never replay history.

### 3. Dashboard

Two commands to see the ledger and the learned trend:

```sh
# one snapshot + trend (recent 10 vs previous 10 average output chars)
node ~/.codex/hooks/status.mjs

# live monitor: redraws whenever the ledger or history changes
node ~/.codex/hooks/watch.mjs
```

Symlink them onto your PATH for convenience:

```sh
ln -sf ~/.codex/hooks/status.mjs ~/.local/bin/dsh-cost-stats
ln -sf ~/.codex/hooks/watch.mjs ~/.local/bin/dsh-cost-watch
```

The trend line is the honest measure of whether the guard is saving tokens: recent output shrinking vs earlier output means the guidance is working.

## Files

| File | Purpose |
|---|---|
| `codex-hook.mjs` | Codex CLI native-hook bridge (PostToolUse / Stop / UserPromptSubmit) |
| `desktop-watch.mjs` | Desktop app sidecar: rollout watcher + ledger fold + guidance refresh + history |
| `status.mjs` | One-snapshot dashboard + trend (`dsh-cost-stats`) |
| `watch.mjs` | Live dashboard redrawing on changes (`dsh-cost-watch`) |

All four are plain ESM scripts depending only on `dsh-cost-adaptive` (the npm package) and Node built-ins.
