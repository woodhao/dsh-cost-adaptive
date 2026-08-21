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

/** Trend block from status.mjs; '' when not enough data yet. */
async function trendText() {
  const { renderTrend } = await import('./status.mjs')
  return renderTrend()
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
