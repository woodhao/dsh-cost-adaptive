#!/usr/bin/env node
/**
 * Live monitor for the dsh-cost-adaptive ledger.
 *
 * Watches the statistics file and redraws the dashboard whenever Codex (or
 * the Harness) writes a new snapshot. Leave a terminal open on this command
 * while you work; Ctrl+C exits.
 */

import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { render, readLedger, statsPath } from './status.mjs'

const POLL_MS = 800
const HISTORY_PATH = () => join(dirname(statsPath()), 'history.jsonl')

const clear = () => process.stdout.write('\x1b[2J\x1b[H')

/** @returns {Promise<number>} file mtime millis, or 0 when the file is absent. */
async function mtimeMs(path) {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return 0
  }
}

/** Trend block from history; '' when not enough data yet. */
async function trendText() {
  const { readFile } = await import('node:fs/promises')
  let text
  try {
    text = await readFile(HISTORY_PATH(), 'utf8')
  } catch {
    return ''
  }
  const rows = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch { /* skip */ }
  }
  if (rows.length < 4) return ''
  const fmt = n => n.toLocaleString('en-US')
  const avg = arr => Math.round(arr.reduce((s, r) => s + r.chars, 0) / arr.length)
  const recent = rows.slice(-10)
  const earlier = rows.slice(-20, -10)
  const recentAvg = avg(recent)
  const earlierAvg = earlier.length ? avg(earlier) : null
  const delta = earlierAvg === null ? null : Math.round(((recentAvg - earlierAvg) / earlierAvg) * 100)
  const lines = ['', '  输出趋势（平均每次输出字符）:', `    最近 10 次: ${fmt(recentAvg)}`]
  if (delta !== null) {
    const arrow = delta <= 0 ? '↓ 变小了，省钱生效' : '↑ 变大了，提醒还没压住'
    lines.push(`    之前 10 次: ${fmt(earlierAvg)}（${delta > 0 ? '+' : ''}${delta}% ${arrow}）`)
  }
  return lines.join('\n')
}

let lastStatsMtime = await mtimeMs(statsPath())
let lastHistoryMtime = await mtimeMs(HISTORY_PATH())

async function draw() {
  const statsNow = await mtimeMs(statsPath())
  const historyNow = await mtimeMs(HISTORY_PATH())
  if (statsNow === lastStatsMtime && historyNow === lastHistoryMtime) return
  lastStatsMtime = statsNow
  lastHistoryMtime = historyNow
  const stats = await readLedger()
  if (stats === null) return
  clear()
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  const trend = await trendText()
  process.stdout.write(`${render(stats)}${trend}\n\n  ⌛ 监听中 · 最后更新 ${time} · Ctrl+C 退出\n`)
}

// Initial draw; keep the terminal clean if the ledger is empty.
const first = await readLedger()
if (first !== null) {
  clear()
  const trend = await trendText()
  process.stdout.write(`${render(first)}${trend}\n\n  ⌛ 监听中 · Ctrl+C 退出\n`)
}
lastStatsMtime = await mtimeMs(statsPath())
lastHistoryMtime = await mtimeMs(HISTORY_PATH())

process.on('SIGINT', () => {
  clear()
  process.exit(0)
})

setInterval(draw, POLL_MS)
