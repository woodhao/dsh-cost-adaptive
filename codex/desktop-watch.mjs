#!/usr/bin/env node
/**
 * Desktop Codex cost-adaptive sidecar.
 *
 * The ChatGPT desktop app does not run Codex hooks (openai/codex#21639), so
 * this watcher reads the app's session rollouts directly: every
 * function_call + function_call_output pair is folded into the shared
 * stats.json ledger with the same pure functions the plugin uses, so the
 * desktop app participates in the same learning ledger without any hook
 * support. Injection into the prompt is not possible from here (no hook
 * point); this covers observation/learning only.
 *
 * A state file (next to stats.json) records how many bytes of each rollout
 * were already folded, so restarting never replays history.
 *
 * Usage: dsh-cost-desktop-watch   (leave running; Ctrl+C exits)
 */

import { mkdir, readFile, readdir, rename, stat, watch, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import process from 'node:process'
import { applyObservation, deriveGuidance, emptyStats, loadStats } from 'dsh-cost-adaptive'

const CONFIG = { thresholdChars: 8192 }
const SESSIONS_DIR = join(homedir(), '.codex', 'sessions')

/** statsPath override, mirroring the plugin's resolution ($DSH_HOME default). */
function statsPath() {
  return process.env.DSH_COST_ADAPTIVE_STATS_PATH
    ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cost-adaptive', 'stats.json')
}

const statePath = () => `${statsPath()}.desktop-offsets.json`
const TMP = new Map() // path -> byte offset consumed (persisted)

/** Codex tool name -> ledger tool name (Codex calls bash exec_command). */
function mapTool(name) {
  if (name === 'exec_command' || name === 'shell') return 'bash'
  if (name === 'apply_patch' || name === 'write_file') return 'write'
  return name || 'unknown'
}

/** Parse a JSONL chunk, returning observable tool results. */
function parseChunk(text) {
  const pairs = new Map() // call_id -> { tool, output }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let d
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (d.type !== 'response_item') continue
    const p = d.payload || {}
    if (p.type === 'function_call' && p.name) {
      pairs.set(p.call_id, { tool: mapTool(p.name), output: '' })
    } else if (p.type === 'function_call_output' && pairs.has(p.call_id)) {
      const entry = pairs.get(p.call_id)
      entry.output = typeof p.output === 'string' ? p.output : ''
    }
  }
  return [...pairs.values()].filter(e => e.output.length > 0)
}

/** Load persisted byte offsets. */
async function loadOffsets() {
  try {
    const raw = await readFile(statePath(), 'utf8')
    const parsed = JSON.parse(raw)
    for (const [k, v] of Object.entries(parsed)) TMP.set(k, v)
  } catch {
    // no state yet — start clean
  }
}

/** Persist byte offsets. */
async function saveOffsets() {
  await mkdir(dirname(statePath()), { recursive: true, mode: 0o700 })
  const obj = Object.fromEntries(TMP)
  const tmp = `${statePath()}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, JSON.stringify(obj), { mode: 0o600 })
  await rename(tmp, statePath())
}

/** Today's rollout files, newest first. */
async function todaysRollouts() {
  const files = []
  async function walk(dir) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) files.push(full)
    }
  }
  await walk(SESSIONS_DIR)
  const withMtime = await Promise.all(files.map(async f => {
    try { return { f, m: (await stat(f)).mtimeMs } } catch { return { f, m: 0 } }
  }))
  return withMtime.sort((a, b) => b.m - a.m).map(x => x.f)
}

async function processNew() {
  const files = await todaysRollouts()
  let changed = false
  for (const file of files.slice(0, 5)) {
    let st
    try {
      st = await stat(file)
    } catch {
      continue
    }
    const start = TMP.get(file) ?? 0
    if (st.size <= start) continue
    let text
    try {
      const buf = await readFile(file)
      text = buf.toString('utf8', start, buf.length)
    } catch {
      continue
    }
    TMP.set(file, st.size)
    const observations = parseChunk(text)
    if (observations.length > 0) {
      const stats = await loadStats(statsPath()).catch(() => emptyStats())
      let next = stats
      for (const o of observations) {
        next = applyObservation(next, {
          tool: o.tool,
          chars: o.output.length,
          thresholdChars: CONFIG.thresholdChars,
          at: Date.now(),
        })
      }
      await persist(next)
      await updateGuidance(next)
      await appendHistory(observations)
      changed = true
      const t = new Date().toLocaleTimeString('zh-CN', { hour12: false })
      console.log(`[${t}] 记账: ${observations.map(o => `${o.tool}(${o.output.length})`).join(', ')}`)
    }
  }
  if (changed) await saveOffsets()
  return changed
}

/** Per-observation history file, for trend display in dsh-cost-stats. */
const HISTORY_PATH = () => join(dirname(statsPath()), 'history.jsonl')

/**
 * Append observed outputs to the history log (one JSON line per observation).
 * @param {Array<{tool: string, output: string}>} observations - observed results.
 */
async function appendHistory(observations) {
  const path = HISTORY_PATH()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const lines = observations
    .map(o => JSON.stringify({ at: Date.now(), tool: o.tool, chars: o.output.length }))
    .join('\n') + '\n'
  const { appendFile } = await import('node:fs/promises')
  await appendFile(path, lines, { mode: 0o600 })
}

/** Cost guidance file the desktop app picks up each new session. */
const GUIDANCE_PATH = () => join(homedir(), '.codex', 'cost-guidance.md')

/**
 * Refresh the cost-guidance file from the current ledger. The desktop app has
 * no hook point to inject guidance per turn, so this file is the injection
 * channel: it is referenced from ~/.codex/AGENTS.md and read at session
 * start. Empty guidance (nothing learned yet) removes the file so an idle
 * deployment adds no context cost.
 * @param {object} stats - current ledger snapshot.
 */
async function updateGuidance(stats) {
  const lines = deriveGuidance(stats, 3, 2)
  const path = GUIDANCE_PATH()
  if (lines.length === 0) {
    try { await import('node:fs/promises').then(({ unlink }) => unlink(path)) } catch { /* absent */ }
    return
  }
  const body = [
    '# 成本指导（由 dsh-cost-adaptive 自动维护，请勿手改）',
    '',
    '你在执行工具时，历史统计显示以下操作经常产生过大的输出，浪费上下文和费用。',
    '请主动控制这些工具的输出规模：能少输出就少输出，能用摘要就用摘要。',
    '',
    ...lines.map(l => `* ${l}`),
    '',
  ].join('\n')
  await writeFile(path, body, { mode: 0o600 })
}

/** Atomic write (tmp + rename), mirroring the plugin's persist. */
async function persist(stats) {
  const path = statsPath()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, JSON.stringify(stats), { mode: 0o600 })
  await rename(tmp, path)
}

// Single-instance guard: refuse to start when another watcher is alive, so a
// second launch (or launchd + manual) can never double-record the same bytes.
const LOCK_PATH = () => `${statsPath()}.desktop-watch.lock`
async function acquireLock() {
  const { readFile: rf, writeFile: wf, unlink } = await import('node:fs/promises')
  try {
    const pid = Number((await rf(LOCK_PATH(), 'utf8')).trim())
    if (pid > 0) {
      try {
        process.kill(pid, 0) // alive?
        console.error(`⚠️ 监视器已在运行（PID ${pid}），本实例退出。`)
        process.exit(0)
      } catch {
        // stale lock — continue
      }
    }
  } catch { /* no lock yet */ }
  await mkdir(dirname(LOCK_PATH()), { recursive: true, mode: 0o700 })
  await wf(LOCK_PATH(), String(process.pid), { mode: 0o600 })
  process.on('exit', () => { try { unlink(LOCK_PATH()) } catch { /* gone */ } })
}

// Bootstrap: load offsets, then process only bytes never seen before.
await acquireLock()
await loadOffsets()
const processedAny = await processNew()
if (processedAny) {
  console.log('✅ 已补记启动前的新记录')
}
console.log('👀 桌面版 Codex 记账监视器运行中（Ctrl+C 退出）')

// Watch the sessions tree for changes and re-process.
try {
  const watcher = watch(SESSIONS_DIR, { recursive: true })
  for await (const event of watcher) {
    if (event.filename && event.filename.includes('rollout-')) {
      await processNew()
    }
  }
} catch {
  // Recursive watch unsupported on some platforms; fall back to polling.
  setInterval(processNew, 2000)
}
