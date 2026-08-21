/**
 * Cost-adaptive's Typert Remote service: the Host side of the cost dashboard.
 * The card in the settings UI calls `costStats.getSnapshot()` to read the
 * current ledger (tool tallies, token usage, cache-hit rate), drills into one
 * tool with `getToolDetail()`, and pins or clears a per-tool threshold with
 * `setThreshold()` — all without touching the statistics file itself.
 *
 * @module @deepseek-ai/dsh-cost-adaptive/remote
 */

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import type { CostStats, ToolStats } from './store.ts'
import type { CostSnapshot, CostToolDetail, CostToolSnapshot } from './types.ts'

/**
 * Sidecar service for the cost dashboard. It exposes snapshot, detail, and
 * threshold endpoints; the plugin owns the mutable ledger and hands this
 * service a read thunk plus the two mutation callbacks so the card always
 * sees the live in-memory snapshot and writes through the same path the
 * learning layer uses.
 */
export class CostStatsService extends TypertRemoteService {
  /**
   * @param ctx - Host context.
   * @param readStats - returns the current ledger snapshot.
   * @param thresholdOf - resolves the threshold in force for one tool.
   * @param setThreshold - pin (or clear, with `null`) a tool's threshold.
   */
  constructor(
    ctx: Context,
    private readonly readStats: () => CostStats,
    private readonly thresholdOf: (tool: string) => number,
    private readonly applyThreshold: (tool: string, thresholdChars: number | null) => void,
  ) {
    super(ctx, 'costStats')
  }

  private rowOf(tool: string, s: ToolStats): CostToolSnapshot {
    return {
      tool,
      calls: s.calls,
      oversized: s.oversized,
      wasteChars: s.wasteChars,
      totalChars: s.totalChars,
      feedback: s.feedback,
      thresholdChars: this.thresholdOf(tool),
    }
  }

  /**
   * Read the current ledger snapshot for the dashboard.
   * @returns ledger summary ordered by waste.
   */
  @Remote('getSnapshot')
  async getSnapshot(): Promise<CostSnapshot> {
    const stats = this.readStats()
    const tools = Object.entries(stats.tools)
      .map(([tool, s]) => this.rowOf(tool, s))
      .sort((a, b) => b.wasteChars - a.wasteChars)
    let lastSeen = 0
    for (const s of Object.values(stats.tools)) {
      if (s.lastSeen > lastSeen) lastSeen = s.lastSeen
    }
    const tokens = stats.tokens
      ? {
        input: stats.tokens.input,
        cached: stats.tokens.cached,
        output: stats.tokens.output,
        // The rate is clamped at 100: side-channel accounting can report a
        // cached subset larger than its input base, which must not render
        // as an impossible >100% figure.
        cacheHitRate: stats.tokens.input > 0
          ? Math.min(100, Math.round((stats.tokens.cached / stats.tokens.input) * 100))
          : 0,
      }
      : undefined
    const snapshot: CostSnapshot = { sessions: stats.sessions, turns: stats.turns, tools, lastSeen }
    if (tokens !== undefined) snapshot.tokens = tokens
    if (stats.recentTurns !== undefined) snapshot.recentRounds = stats.recentTurns
    return snapshot
  }

  /**
   * Read one tool's detail: its aggregate row plus recent observations.
   * @param tool - the tool to inspect.
   * @returns the tool's row and recent observations, or `null` when the tool
   * has no ledger entry.
   */
  @Remote('getToolDetail')
  async getToolDetail(tool: string): Promise<CostToolDetail | null> {
    const s = this.readStats().tools[tool]
    if (s === undefined) return null
    return {
      row: this.rowOf(tool, s),
      recent: (s.recent ?? []).map(r => ({ chars: r.chars, oversized: r.oversized, at: r.at })),
    }
  }

  /**
   * Pin or clear a human threshold override for one tool. The change lands in
   * the ledger and the pruner before the returned snapshot reflects it.
   * @param tool - the tool whose threshold the human overrides.
   * @param thresholdChars - override in code points, or `null` to clear it.
   * @returns the refreshed ledger snapshot.
   */
  @Remote('setThreshold')
  async setThreshold(tool: string, thresholdChars: number | null): Promise<CostSnapshot> {
    this.applyThreshold(tool, thresholdChars)
    return this.getSnapshot()
  }
}

export default CostStatsService
