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

  // Token usage block: input/cached/output cumulative, with cache-hit rate.
  const t = stats.tokens
  if (t && (t.input > 0 || t.output > 0)) {
    const rate = t.input > 0 ? Math.round((t.cached / t.input) * 100) : 0
    lines.push('')
    lines.push('  Token 用量（累计）:')
    lines.push(`    输入 ${fmt(t.input).padStart(10)} · 缓存命中 ${fmt(t.cached).padStart(10)}（${rate}%）`)
    lines.push(`    输出 ${fmt(t.output).padStart(10)}`)
  }
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
 * Trend summary from the observation history, per tool: average output size
 * and oversized share of the most recent 10 observations vs the 10 before
 * them. The oversized share is the honest savings signal — smaller recent
 * outputs (or fewer oversized ones) mean the guidance is working.
 * @returns {Promise<string>} trend block, or '' when not enough history yet.
 */
export async function renderTrend() {
  const { readFile } = await import('node:fs/promises')
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
  const avg = arr => arr.length ? Math.round(arr.reduce((s, r) => s + r.chars, 0) / arr.length) : 0
  const overShare = (arr, thr) => `${arr.filter(r => r.chars > thr).length}/${arr.length}`
  const thr = 8192
  // Group by tool; only tools with at least 4 observations get a trend line.
  const byTool = new Map()
  for (const r of rows) {
    if (!byTool.has(r.tool)) byTool.set(r.tool, [])
    byTool.get(r.tool).push(r)
  }
  const lines = ['', '  输出趋势（最近 10 次 vs 之前 10 次，按工具）:']
  let any = false
  for (const [tool, rs] of byTool) {
    if (rs.length < 4) continue
    any = true
    const recent = rs.slice(-10)
    const earlier = rs.slice(-20, -10)
    const recentAvg = avg(recent)
    const earlierAvg = earlier.length ? avg(earlier) : null
    let bit = `  ${tool.padEnd(18)} 平均 ${fmt(recentAvg).padStart(6)} 字符 · 超大 ${overShare(recent, thr)}`
    if (earlierAvg !== null && earlier.length >= 10) {
      const delta = Math.round(((recentAvg - earlierAvg) / earlierAvg) * 100)
      const overEarlier = overShare(earlier, thr)
      const overDelta = recent.filter(r => r.chars > thr).length - earlier.filter(r => r.chars > thr).length
      const arrow = overDelta < 0 || (overDelta === 0 && delta <= 0) ? '↓ 省钱生效' : '↑ 还没压住'
      bit += ` → ${fmt(earlierAvg)} 字符 (${delta > 0 ? '+' : ''}${delta}%) · 超大 ${overEarlier} ${arrow}`
    }
    lines.push(bit)
  }
  if (!any) return ''
  return lines.join('\n')
}
