#!/usr/bin/env node
/**
 * One-look dashboard for the dsh-cost-adaptive ledger.
 * `render` is shared with the dsh-cost-watch live monitor; direct invocation
 * prints one snapshot.
 */

import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadStats } from 'dsh-cost-adaptive'

/** statsPath override, mirroring the plugin's resolution ($DSH_HOME default). */
export function statsPath() {
  return process.env.DSH_COST_ADAPTIVE_STATS_PATH
    ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cost-adaptive', 'stats.json')
}

/** Human-readable ledger snapshot. @param stats - the statistics document. */
export function render(stats) {
  const fmt = n => n.toLocaleString('en-US')
  const rows = Object.entries(stats.tools)
    .map(([tool, s]) => ({ tool, ...s }))
    .sort((a, b) => b.wasteChars - a.wasteChars)

  const lines = [
    '📒 dsh-cost-adaptive 账本',
    '──────────────────────────────',
    `  会话数: ${stats.sessions}    轮次数: ${stats.turns}`,
    '',
    '  工具统计（按浪费量排序）:',
  ]
  if (rows.length === 0) {
    lines.push('    （还没有工具观察记录）')
  } else {
    for (const r of rows) {
      const waste = r.wasteChars > 0 ? ` ⚠️ 浪费 ${fmt(r.wasteChars)} 字符` : ''
      const over = r.oversized > 0 ? `, ${r.oversized} 次超大` : ''
      lines.push(
        `  ${r.tool.padEnd(18)} ${fmt(r.calls).padStart(4)} 次调用${over}${waste}`,
      )
    }
  }
  lines.push('')
  lines.push(`  已学习: ${rows.filter(r => r.oversized > 0 || r.feedback > 0).length} 个浪费大户`)
  return lines.join('\n')
}

/** Read the ledger, tolerating a missing/corrupt file. @returns the snapshot or null. */
export async function readLedger() {
  try {
    return await loadStats(statsPath())
  } catch {
    return null
  }
}

// Direct invocation: print one snapshot. Compare real paths so a symlinked
// command (dsh-cost-stats -> status.mjs) still counts as direct invocation.
import { realpathSync } from 'node:fs'
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stats = await readLedger()
  if (stats === null) {
    console.error('账本还没建立（还没有任何会话记账）。')
    process.exit(0)
  }
  console.log(render(stats))
  console.log(await renderTrend())
}

/**
 * Trend summary from the observation history: average output size of the
 * most recent 10 observations vs the 10 before them, per oversized tool.
 * @returns {Promise<string>} trend block, or '' when no history yet.
 */
async function renderTrend() {
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')
  const historyPath = join(dirname(statsPath()), 'history.jsonl')
  let text
  try {
    text = await readFile(historyPath, 'utf8')
  } catch {
    return ''
  }
  const rows = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch { /* skip malformed */ }
  }
  if (rows.length < 4) return ''
  const fmt = n => n.toLocaleString('en-US')
  const avg = arr => Math.round(arr.reduce((s, r) => s + r.chars, 0) / arr.length)
  const recent = rows.slice(-10)
  const earlier = rows.slice(-20, -10)
  const recentAvg = avg(recent)
  const earlierAvg = earlier.length ? avg(earlier) : null
  const delta = earlierAvg === null ? null : Math.round(((recentAvg - earlierAvg) / earlierAvg) * 100)
  const lines = [
    '',
    '  输出趋势（平均每次输出字符）:',
    `    最近 10 次: ${fmt(recentAvg)}`,
  ]
  if (delta !== null) {
    const arrow = delta <= 0 ? '↓ 变小了，省钱生效' : '↑ 变大了，提醒还没压住'
    lines.push(`    之前 10 次: ${fmt(earlierAvg)}（${delta > 0 ? '+' : ''}${delta}% ${arrow}）`)
  }
  return lines.join('\n')
}
