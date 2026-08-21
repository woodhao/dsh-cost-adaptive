#!/usr/bin/env node
/**
 * Codex hook bridge for dsh-cost-adaptive.
 *
 * Runs the same learned cost-guard algorithms as the DeepSeek Harness plugin
 * inside Codex CLI: observes tool-result sizes on PostToolUse, folds turns on
 * Stop, and injects the learned cost guidance into UserPromptSubmit. Only
 * acts when the active model is a DeepSeek model (the `model` field on the
 * hook payload contains "deepseek"); every other model passes through with
 * zero overhead.
 *
 * Statistics are shared with the Harness plugin through the same
 * `$DSH_HOME/cost-adaptive/stats.json` file, so one deployment's learning
 * feeds the other.
 *
 * stdin: the Codex hook JSON payload.
 * stdout: the hook decision JSON (or nothing for a no-op pass-through).
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  applyObservation,
  applyTurn,
  deriveGuidance,
  emptyStats,
  loadStats,
} from 'dsh-cost-adaptive'

/** Snapshot type, derived from the package's loader return. */
/** @typedef {Awaited<ReturnType<typeof loadStats>>} CostStats */

/** Defaults mirrored from the plugin's schemastery Config schema. */
const CONFIG = {
  thresholdChars: 8192,
  minCalls: 3,
  maxLines: 2,
}

/**
 * statsPath override, mirroring the plugin's resolution ($DSH_HOME default).
 * @returns {string} the statistics file path.
 */
function statsPath() {
  return process.env.DSH_COST_ADAPTIVE_STATS_PATH
    ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cost-adaptive', 'stats.json')
}

/**
 * True when the payload's active model is a DeepSeek model.
 * @param {{ model?: unknown }} payload - hook payload.
 * @returns {boolean} whether the model name contains "deepseek".
 */
function isDeepSeekModel(payload) {
  return typeof payload.model === 'string' && payload.model.toLowerCase().includes('deepseek')
}

/**
 * Read the current snapshot, tolerating a missing/corrupt file like the plugin.
 * @returns {Promise<CostStats>} the snapshot (empty when unreadable).
 */
async function readStats() {
  try {
    return await loadStats(statsPath())
  } catch {
    return emptyStats()
  }
}

/**
 * Observed result text from a Codex tool payload; '' when absent.
 * @param {Record<string, unknown>} payload - hook payload.
 * @returns {string} the result text.
 */
function resultText(payload) {
  const response = payload.tool_response
  if (typeof response === 'string') return response
  if (response === null || response === undefined) return ''
  try {
    return JSON.stringify(response)
  } catch {
    return ''
  }
}

/**
 * Persist a snapshot atomically (tmp + rename), creating the parent dir.
 * @param {CostStats} stats - snapshot to write.
 */
async function persist(stats) {
  const path = statsPath()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, JSON.stringify(stats), { mode: 0o600 })
  const { rename } = await import('node:fs/promises')
  await rename(tmp, path)
}

/**
 * Handle one hook payload. Every path returns the Codex decision object or
 * undefined for a silent pass-through (exit 0, no output = continue).
 * @param {Record<string, unknown>} payload - hook payload.
 * @returns {Promise<Record<string, unknown> | undefined>} the decision, if any.
 */
export async function handle(payload) {
  const event = payload.hook_event_name
  // The cost guard is DeepSeek-specific: skip every other model entirely.
  if (!isDeepSeekModel(payload)) return undefined

  if (event === 'PostToolUse') {
    const tool = typeof payload.tool_name === 'string' ? payload.tool_name : 'unknown'
    const stats = await readStats()
    const chars = resultText(payload).length
    const next = applyObservation(stats, {
      tool,
      chars,
      thresholdChars: CONFIG.thresholdChars,
      at: Date.now(),
    })
    await persist(next)
    return undefined
  }

  if (event === 'Stop') {
    const stats = await readStats()
    // Codex hook payloads carry no token usage; count the turn with zeros so
    // the session/turn tallies stay comparable with the Harness ledger.
    const next = applyTurn(stats, { newInputTokens: 0, outputTokens: 0, at: Date.now() }, false)
    await persist(next)
    return undefined
  }

  if (event === 'UserPromptSubmit') {
    const stats = await readStats()
    const lines = deriveGuidance(stats, CONFIG.minCalls, CONFIG.maxLines)
    if (lines.length === 0) return undefined
    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `Cost guidance: oversized tool results waste context. Keep output small: ${lines.join(' ')}`,
      },
    }
  }

  return undefined
}

// Direct invocation: read stdin, handle, print the decision JSON.
const isDirect = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url
if (isDirect) {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  try {
    const payload = raw.trim() ? JSON.parse(raw) : {}
    const decision = await handle(payload)
    if (decision) process.stdout.write(JSON.stringify(decision))
  } catch (error) {
    // Never break the agent loop on a hook failure: exit 0, no output.
    process.stderr.write(`dsh-cost-adaptive hook: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}
