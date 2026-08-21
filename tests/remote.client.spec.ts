/** CostStatsService: snapshot serialization, cache-rate clamping, drill-down. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CostStatsService } from '../src/remote.ts'
import type { CostStats } from '../src/store.ts'

function serviceWith(stats: CostStats): CostStatsService {
  const ctx = new Context()
  return new CostStatsService(
    ctx,
    () => stats,
    () => 8192,
    () => {},
  )
}

describe('CostStatsService', () => {
  it('clamps the cache-hit rate at 100 when the cached subset exceeds its input base', async () => {
    const stats: CostStats = {
      version: 2,
      sessions: 1,
      turns: 1,
      tools: {},
      tokens: { input: 100, cached: 150, output: 5, lastInput: 100, lastCached: 150, lastOutput: 5 },
    }
    const snapshot = await serviceWith(stats).getSnapshot()
    expect(snapshot.tokens?.cacheHitRate).toBe(100)
  })

  it('reports the true cache-hit rate below the cap', async () => {
    const stats: CostStats = {
      version: 2,
      sessions: 1,
      turns: 1,
      tools: {},
      tokens: { input: 200, cached: 150, output: 5, lastInput: 200, lastCached: 150, lastOutput: 5 },
    }
    const snapshot = await serviceWith(stats).getSnapshot()
    expect(snapshot.tokens?.cacheHitRate).toBe(75)
  })

  it('serves the recent-turns window with per-tool rows and thresholds', async () => {
    const stats: CostStats = {
      version: 2,
      sessions: 1,
      turns: 2,
      tools: {
        bash: {
          calls: 1,
          oversized: 1,
          totalChars: 12_000,
          wasteChars: 3_808,
          lastSeen: 2,
          feedback: 0,
          recent: [{ chars: 12_000, oversized: true, at: 2 }],
        },
      },
      tokens: { input: 300, cached: 50, output: 30, lastInput: 200, lastCached: 50, lastOutput: 20 },
      recentTurns: [
        { input: 100, cached: 0, output: 10, at: 1 },
        { input: 200, cached: 50, output: 20, at: 2 },
      ],
    }
    const snapshot = await serviceWith(stats).getSnapshot()
    expect(snapshot.recentRounds).toEqual(stats.recentTurns)
    expect(snapshot.tools[0]!.thresholdChars).toBe(8192)
    expect(snapshot.tools[0]!.tool).toBe('bash')
  })

  it('getToolDetail returns null for an unknown tool and detail for a known one', async () => {
    const stats: CostStats = {
      version: 2,
      sessions: 1,
      turns: 1,
      tools: {
        bash: {
          calls: 1,
          oversized: 0,
          totalChars: 100,
          wasteChars: 0,
          lastSeen: 2,
          feedback: 0,
          recent: [{ chars: 100, oversized: false, at: 2 }],
        },
      },
    }
    const service = serviceWith(stats)
    expect(await service.getToolDetail('read')).toBeNull()
    const detail = await service.getToolDetail('bash')
    expect(detail?.recent).toEqual([{ chars: 100, oversized: false, at: 2 }])
  })

  it('setThreshold applies through the write callback', async () => {
    let applied: [string, number | null] | null = null
    const ctx = new Context()
    const service = new CostStatsService(
      ctx,
      () => ({
        version: 2,
        sessions: 0,
        turns: 0,
        tools: {},
      }),
      () => 8192,
      (tool, chars) => { applied = [tool, chars] },
    )
    await service.setThreshold('bash', 2000)
    expect(applied).toEqual(['bash', 2000])
    await service.setThreshold('bash', null)
    expect(applied).toEqual(['bash', null])
  })
})
