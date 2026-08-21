/**
 * Unit + real-load-path coverage for @deepseek-ai/dsh-cost-adaptive.
 *
 * The pure store functions and file helpers are tested directly; the plugin's
 * observation pipeline is exercised through a real session-event stream so the
 * call-id → tool-name resolution, turn settlement, and guidance derivation
 * run on the actual event shapes.
 */

import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createToolResultMessage, createUserMessage, CallId } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SettingsProvider from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import * as costAdaptive from '@deepseek-ai/dsh-cost-adaptive'
import {
  applyFeedback,
  applyObservation,
  applyTurn,
  codePointLength,
  deriveGuidance,
  derivePrunerThreshold,
  emptyStats,
} from '@deepseek-ai/dsh-cost-adaptive'
import type { CostStats } from '@deepseek-ai/dsh-cost-adaptive'

/** A usage record the plugin reads from `assistant/message`. */
const USAGE: TokenUsage = { inputTokens: 500, outputTokens: 40, cacheReadTokens: 1000, cacheWriteTokens: 0 }

/** In-memory settings provider: the smallest real subclass of the Service Definition. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

describe('cost-adaptive store (pure functions)', () => {
  it('emptyStats produces a versioned empty document', () => {
    expect(emptyStats()).toEqual({ version: 2, sessions: 0, turns: 0, tools: {} })
  })

  it('codePointLength counts code points, never surrogate halves', () => {
    expect(codePointLength('')).toBe(0)
    expect(codePointLength('grep')).toBe(4)
    expect(codePointLength('🎉🎉')).toBe(2)
  })

  it('applyObservation records a first call with correct oversized and waste buckets', () => {
    const stats = applyObservation(emptyStats(), { tool: 'grep', chars: 12_000, thresholdChars: 8192, at: 1 })
    expect(stats.tools.grep).toEqual({
      calls: 1,
      oversized: 1,
      totalChars: 12_000,
      wasteChars: 12_000 - 8192,
      lastSeen: 1,
      feedback: 0,
    })
  })

  it('applyObservation accumulates across calls and keeps small results unmarked', () => {
    let stats = emptyStats()
    stats = applyObservation(stats, { tool: 'read', chars: 100, thresholdChars: 8192, at: 1 })
    stats = applyObservation(stats, { tool: 'read', chars: 9_000, thresholdChars: 8192, at: 2 })
    stats = applyObservation(stats, { tool: 'read', chars: 8_192, thresholdChars: 8192, at: 3 })
    expect(stats.tools.read).toEqual({
      calls: 3,
      oversized: 1,
      totalChars: 100 + 9_000 + 8_192,
      wasteChars: 9_000 - 8192,
      lastSeen: 3,
      feedback: 0,
    })
  })

  it('applyObservation does not mutate its input snapshot', () => {
    const prior = emptyStats()
    const next = applyObservation(prior, { tool: 'grep', chars: 100, thresholdChars: 8192, at: 1 })
    expect(prior.tools).toEqual({})
    expect(next.tools.grep).toBeDefined()
  })

  it('applyTurn counts sessions and turns', () => {
    let stats = emptyStats()
    stats = applyTurn(stats, { newInputTokens: 100, outputTokens: 10, at: 1 }, true)
    stats = applyTurn(stats, { newInputTokens: 200, outputTokens: 20, at: 2 }, false)
    expect(stats.sessions).toBe(1)
    expect(stats.turns).toBe(2)
  })

  it('deriveGuidance stays empty with no trusted tool record', () => {
    expect(deriveGuidance(emptyStats(), 3, 2)).toEqual([])
    const fewCalls = applyObservation(emptyStats(), { tool: 'grep', chars: 12_000, thresholdChars: 8192, at: 1 })
    expect(deriveGuidance(fewCalls, 3, 2)).toEqual([])
  })

  it('deriveGuidance ranks offenders by waste and caps lines', () => {
    let stats = emptyStats()
    for (let i = 0; i < 3; i += 1) {
      stats = applyObservation(stats, { tool: 'grep', chars: 12_000, thresholdChars: 8192, at: i })
      stats = applyObservation(stats, { tool: 'read', chars: 20_000, thresholdChars: 8192, at: i })
    }
    const lines = deriveGuidance(stats, 3, 1)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('read')
  })

  it('deriveGuidance reports a tool with zero oversized results only when minCalls is met', () => {
    let stats = emptyStats()
    for (let i = 0; i < 4; i += 1) {
      stats = applyObservation(stats, { tool: 'bash', chars: 10, thresholdChars: 8192, at: i })
    }
    expect(deriveGuidance(stats, 3, 2)).toEqual([])
  })

  it('applyFeedback increments only an observed tool and never mutates its input', () => {
    let stats = applyObservation(emptyStats(), { tool: 'grep', chars: 12_000, thresholdChars: 8192, at: 1 })
    const prior = stats
    stats = applyFeedback(stats, 'grep')
    expect(stats.tools.grep).toMatchObject({ feedback: 1 })
    expect(prior.tools.grep).toMatchObject({ feedback: 0 })
    expect(applyFeedback(stats, 'unknown-tool')).toBe(stats)
  })

  it('deriveGuidance admits an explicitly confirmed tool below the observation minimum', () => {
    let stats = applyObservation(emptyStats(), { tool: 'read', chars: 200, thresholdChars: 8192, at: 1 })
    stats = applyFeedback(stats, 'read')
    const lines = deriveGuidance(stats, 3, 2)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('read')
    expect(lines[0]).toContain('[confirmed]')
  })

  it('deriveGuidance weights confirmed tools above equal observed waste', () => {
    let stats = emptyStats()
    stats = applyObservation(stats, { tool: 'grep', chars: 12_000, thresholdChars: 8192, at: 1 })
    stats = applyObservation(stats, { tool: 'read', chars: 12_000, thresholdChars: 8192, at: 2 })
    stats = applyFeedback(stats, 'read')
    const lines = deriveGuidance(stats, 1, 1)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('read')
  })

  it('derivePrunerThreshold keeps the base threshold when nothing is learned', () => {
    expect(derivePrunerThreshold(emptyStats(), 8192)).toBe(8192)
    const clean = applyObservation(emptyStats(), { tool: 'bash', chars: 10, thresholdChars: 8192, at: 1 })
    expect(derivePrunerThreshold(clean, 8192)).toBe(8192)
  })

  it('derivePrunerThreshold tightens with waste ratio and feedback confirmations', () => {
    // Half the observed chars are waste: factor = 1 - 0.5 * 0.4 = 0.8.
    let stats = emptyStats()
    stats = applyObservation(stats, { tool: 'grep', chars: 16_384, thresholdChars: 8192, at: 1 })
    expect(derivePrunerThreshold(stats, 8192)).toBe(6554)
    // One confirmation tightens the factor's cap: 1 - 0.5 * 0.5 = 0.75.
    stats = applyFeedback(stats, 'grep')
    expect(derivePrunerThreshold(stats, 8192)).toBe(6144)
  })
})

describe('cost-adaptive file helpers', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'cost-adaptive-file-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('loadStats tolerates a missing file', async () => {
    await expect(costAdaptive.loadStats(path.join(tempDir, 'absent.json'))).resolves.toEqual(emptyStats())
  })

  it('loadStats rejects a corrupt JSON document', async () => {
    const target = path.join(tempDir, 'corrupt.json')
    await writeFile(target, '{not json', 'utf8')
    await expect(costAdaptive.loadStats(target)).rejects.toThrow()
  })

  it('loadStats rejects a non-object document', async () => {
    const target = path.join(tempDir, 'scalar.json')
    await writeFile(target, '"just a string"', 'utf8')
    await expect(costAdaptive.loadStats(target)).rejects.toThrow('not a JSON object')
  })

  it('loadStats rejects a foreign schema version', async () => {
    const target = path.join(tempDir, 'old.json')
    await writeFile(target, '{"version": 0, "sessions": 1, "turns": 1, "tools": {}}', 'utf8')
    await expect(costAdaptive.loadStats(target)).rejects.toThrow('has version 0, expected 2')
  })

  it('loadStats rethrows filesystem errors other than a missing file', async () => {
    const target = path.join(tempDir, 'directory')
    await mkdir(target)
    await expect(costAdaptive.loadStats(target)).rejects.toThrow()
  })

  it('loadStats round-trips a saved snapshot', async () => {
    const target = path.join(tempDir, 'stats.json')
    const stats = applyTurn(applyObservation(emptyStats(), {
      tool: 'grep', chars: 100, thresholdChars: 8192, at: 1,
    }), { newInputTokens: 10, outputTokens: 2, at: 1 }, true)
    await costAdaptive.saveStats(target, stats)
    await expect(costAdaptive.loadStats(target)).resolves.toEqual(stats)
  })

  it('toolResultChars measures only text blocks of a tool-result block', () => {
    const data = {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('c'),
        content: [
          { type: 'text', text: 'abc' },
          { type: 'reasoning', text: 'ignored' },
        ],
        isError: false,
      }),
    } as never
    expect(costAdaptive.toolResultChars(data)).toBe(3)
  })

  it('resolveConfig applies every documented default to an empty input', () => {
    const resolved = costAdaptive.resolveConfig({})
    expect(resolved.thresholdChars).toBe(8192)
    expect(resolved.minCalls).toBe(3)
    expect(resolved.maxLines).toBe(2)
    expect(resolved.statsPath).toMatch(/cost-adaptive[\\/]stats\.json$/)
    expect(resolved.flushEveryTurns).toBe(1)
    expect(resolved.disabled).toBe(false)
  })

  it('resolveConfig keeps explicit values and disables observation', () => {
    const resolved = costAdaptive.resolveConfig({
      thresholdChars: 100,
      minCalls: 7,
      maxLines: 0,
      statsPath: '/tmp/override.json',
      flushEveryTurns: 3,
      disabled: true,
    })
    expect(resolved).toEqual({
      thresholdChars: 100,
      minCalls: 7,
      maxLines: 0,
      statsPath: '/tmp/override.json',
      flushEveryTurns: 3,
      disabled: true,
    })
  })
})

describe('cost-adaptive plugin (real session events)', () => {
  let tempDir: string
  let ctx: Context
  let fiber: { dispose(): Promise<void> }

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'cost-adaptive-'))
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(SessionStore)
    fiber = await ctx.plugin(costAdaptive, {
      statsPath: path.join(tempDir, 'stats.json'),
      minCalls: 1,
      maxLines: 5,
    })
  })

  afterEach(async () => {
    await fiber.dispose()
    await rm(tempDir, { recursive: true, force: true })
  })

  function session(): Session {
    return ctx.sessions.create(SessionId('cost-adaptive-test-session'), { meta: { cwd: '/tmp' } })
  }

  /** Append one closed turn with a single oversized tool result and usage. */
  function closedTurn(sess: Session, turn: number, text: string): void {
    const callId = CallId(`call_${turn}`)
    sess.append('tool/call', { turn, step: 1, callId, name: 'grep', arguments: '{}' })
    sess.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text }], isError: false }),
    }, { surfaceOp: 'append' })
    sess.append('assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({ content: [], source: { provider: 'test', model: 'test-model' } }),
      usage: USAGE,
    }, { surfaceOp: 'append' })
    sess.append('turn/end', { turn, reason: { kind: 'completed' } })
  }

  /** Wait until the file exists and its parsed JSON satisfies the predicate. */
  async function waitForFile<T>(target: string, predicate: (value: T) => boolean): Promise<T> {
    const deadline = Date.now() + 5_000
    let last: T | undefined
    while (Date.now() < deadline) {
      try {
        last = JSON.parse(await readFile(target, 'utf8')) as T
        if (predicate(last)) return last
      } catch {
        // File not written yet; keep polling.
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for ${target}; last=${JSON.stringify(last)}`)
  }

  /** Wait until the default statistics file shows the given turn count. */
  function waitForStats(turns: number): Promise<CostStats> {
    return waitForFile<CostStats>(path.join(tempDir, 'stats.json'), stats => stats.turns === turns)
  }

  it('settles a turn and persists statistics after tool/result + assistant/message events', { timeout: 20_000 }, async () => {
    const sess = session()
    closedTurn(sess, 1, 'x'.repeat(12_000))

    const persisted = await waitForStats(1)
    expect(persisted.sessions).toBe(1)
    expect(persisted.tools.grep).toMatchObject({ calls: 1, oversized: 1, totalChars: 12_000 })
  })

  it('assembles a guidance section from the learned snapshot', { timeout: 20_000 }, async () => {
    const sess = session()
    closedTurn(sess, 1, 'y'.repeat(20_000))

    await waitForStats(1)
    const assembled = await ctx.systemPrompt.assemble({ cwd: '/tmp', extra: [], tools: [], variables: {} } as never)
    const text = assembled.sections.map(section => section.text).join('\n')
    expect(text).toContain('grep')
    expect(text).toContain('oversized')
  })

  it('counts one session across many turns', { timeout: 20_000 }, async () => {
    const sess = session()
    closedTurn(sess, 1, 'x'.repeat(9_000))
    closedTurn(sess, 2, 'x'.repeat(9_000))

    const persisted = await waitForStats(2)
    expect(persisted.sessions).toBe(1)
    expect(persisted.tools.grep).toMatchObject({ calls: 2 })
  })

  it('keeps a clean session guidance-free', { timeout: 20_000 }, async () => {
    const sess = session()
    sess.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await new Promise(resolve => setTimeout(resolve, 30))
    const assembled = await ctx.systemPrompt.assemble({ cwd: '/tmp', extra: [], tools: [], variables: {} } as never)
    const text = assembled.sections.map(section => section.text).join('\n')
    expect(text).not.toContain('oversized')
  })

  it('does not register listeners or guidance when disabled', { timeout: 20_000 }, async () => {
    const disabledCtx = new Context()
    await disabledCtx.plugin(SystemPrompt)
    await disabledCtx.plugin(SessionStore)
    const disabledFiber = await disabledCtx.plugin(costAdaptive, {
      statsPath: path.join(tempDir, 'disabled.json'),
      disabled: true,
    })
    const sess = disabledCtx.sessions.create(SessionId('disabled-session'), { meta: { cwd: '/tmp' } })
    closedTurn(sess, 1, 'x'.repeat(12_000))
    await new Promise(resolve => setTimeout(resolve, 30))
    const assembled = await disabledCtx.systemPrompt.assemble({ cwd: '/tmp', extra: [], tools: [], variables: {} } as never)
    const text = assembled.sections.map(section => section.text).join('\n')
    expect(text).not.toContain('oversized')
    await expect(readFile(path.join(tempDir, 'disabled.json'), 'utf8')).rejects.toThrow('ENOENT')
    await disabledFiber.dispose()
  })

  it('flushes only when the turn cadence is due', { timeout: 20_000 }, async () => {
    const cadenceCtx = new Context()
    await cadenceCtx.plugin(SystemPrompt)
    await cadenceCtx.plugin(SessionStore)
    const cadenceFiber = await cadenceCtx.plugin(costAdaptive, {
      statsPath: path.join(tempDir, 'cadence.json'),
      flushEveryTurns: 2,
    })
    const sess = cadenceCtx.sessions.create(SessionId('cadence-session'), { meta: { cwd: '/tmp' } })
    closedTurn(sess, 1, 'x'.repeat(9_000))
    await new Promise(resolve => setTimeout(resolve, 40))
    // First turn does not reach the cadence, so nothing is persisted yet.
    await expect(readFile(path.join(tempDir, 'cadence.json'), 'utf8')).rejects.toThrow('ENOENT')
    closedTurn(sess, 2, 'x'.repeat(9_000))
    const persisted = await waitForFile<CostStats>(path.join(tempDir, 'cadence.json'), stats => stats.turns === 2)
    expect(persisted.turns).toBe(2)
    await cadenceFiber.dispose()
  })

  it('degrades to an empty snapshot when the durable file is unreadable', { timeout: 20_000 }, async () => {
    const statsDir = path.join(tempDir, 'stats-dir')
    await mkdir(statsDir)
    const degradedCtx = new Context()
    await degradedCtx.plugin(SystemPrompt)
    await degradedCtx.plugin(SessionStore)
    const degradedFiber = await degradedCtx.plugin(costAdaptive, {
      statsPath: statsDir,
      minCalls: 1,
    })
    const sess = degradedCtx.sessions.create(SessionId('degraded-session'), { meta: { cwd: '/tmp' } })
    closedTurn(sess, 1, 'x'.repeat(12_000))
    await new Promise(resolve => setTimeout(resolve, 50))
    const assembled = await degradedCtx.systemPrompt.assemble({ cwd: '/tmp', extra: [], tools: [], variables: {} } as never)
    const text = assembled.sections.map(section => section.text).join('\n')
    // The load failed but a turn still settled on the empty snapshot.
    expect(text).toContain('grep')
    await degradedFiber.dispose()
  })

  it('ignores events after a settings update disables the plugin', { timeout: 20_000 }, async () => {
    const settingsCtx = new Context()
    await settingsCtx.plugin(SystemPrompt)
    await settingsCtx.plugin(SessionStore)
    await settingsCtx.plugin(MemorySettings)
    const settingsFiber = await settingsCtx.plugin(costAdaptive, {
      statsPath: path.join(tempDir, 'settings.json'),
      minCalls: 1,
      maxLines: 5,
    })
    const sess = settingsCtx.sessions.create(SessionId('settings-session'), { meta: { cwd: '/tmp' } })
    closedTurn(sess, 1, 'x'.repeat(9_000))
    await waitForFile<CostStats>(path.join(tempDir, 'settings.json'), stats => stats.turns === 1)
    const provider = settingsCtx.get('settings') as MemorySettings
    await provider.update(costAdaptive.NS, { disabled: true })
    closedTurn(sess, 2, 'x'.repeat(12_000))
    await new Promise(resolve => setTimeout(resolve, 40))
    const persisted = await waitForFile<CostStats>(path.join(tempDir, 'settings.json'), stats => stats.turns === 1)
    expect(persisted.turns).toBe(1)
    await settingsFiber.dispose()
  })

  it('keys an uncalled tool result by its call id', { timeout: 20_000 }, async () => {
    const sess = session()
    sess.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('orphan-call'),
        content: [{ type: 'text', text: 'x'.repeat(9_000) }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    sess.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const persisted = await waitForStats(1)
    expect(persisted.tools['orphan-call']).toMatchObject({ calls: 1, oversized: 1 })
  })

  it('ignores non-observation session events without disturbing the stream', { timeout: 20_000 }, async () => {
    const sess = session()
    sess.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    sess.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await new Promise(resolve => setTimeout(resolve, 40))
    const assembled = await ctx.systemPrompt.assemble({ cwd: '/tmp', extra: [], tools: [], variables: {} } as never)
    const text = assembled.sections.map(section => section.text).join('\n')
    expect(text).not.toContain('oversized')
  })

  it('confirms a named tool from explicit feedback and persists it', { timeout: 20_000 }, async () => {
    const sess = session()
    closedTurn(sess, 1, 'x'.repeat(9_000))
    await waitForStats(1)
    // Feedback names the observed tool; it must land in the snapshot without
    // waiting for another turn boundary.
    sess.append('feedback/record', { text: 'keep grep output small' })
    const persisted = await waitForFile<CostStats>(path.join(tempDir, 'stats.json'), stats => (stats.tools.grep?.feedback ?? 0) >= 1)
    expect(persisted.tools.grep).toMatchObject({ feedback: 1 })
    const assembled = await ctx.systemPrompt.assemble({ cwd: '/tmp', extra: [], tools: [], variables: {} } as never)
    const text = assembled.sections.map(section => section.text).join('\n')
    expect(text).toContain('grep')
    expect(text).toContain('[confirmed]')
  })

  it('ignores feedback that names no observed tool', { timeout: 20_000 }, async () => {
    const sess = session()
    sess.append('feedback/record', { text: 'this whole session was great' })
    await new Promise(resolve => setTimeout(resolve, 30))
    const assembled = await ctx.systemPrompt.assemble({ cwd: '/tmp', extra: [], tools: [], variables: {} } as never)
    const text = assembled.sections.map(section => section.text).join('\n')
    expect(text).not.toContain('oversized')
  })

  it('drives a mounted tool-result pruner threshold from learned waste', { timeout: 20_000 }, async () => {
    const prunerCtx = new Context()
    await prunerCtx.plugin(SystemPrompt)
    await prunerCtx.plugin(SessionStore)
    await prunerCtx.plugin(TokenMeter)
    const prunerFiber = await prunerCtx.plugin(ToolResultPruner, {
      thresholdChars: 8192,
      headChars: 100,
      tailChars: 50,
    })
    await prunerCtx.plugin(costAdaptive, {
      statsPath: path.join(tempDir, 'pruner-stats.json'),
      minCalls: 1,
    })
    try {
      const pruner = prunerCtx.toolResultPruner
      expect(pruner.config.thresholdChars).toBe(8192)
      const sess = prunerCtx.sessions.create(SessionId('pruner-driven-session'), { meta: { cwd: '/tmp' } })
      const callId = CallId('pruner-call')
      sess.append('tool/call', { turn: 1, step: 1, callId, name: 'grep', arguments: '{}' })
      sess.append('tool/result', {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId,
          content: [{ type: 'text', text: 'x'.repeat(16_384) }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
      sess.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      // Half the observed chars are waste: factor = 1 - 0.5 * 0.4 = 0.8.
      await waitForFile<CostStats>(path.join(tempDir, 'pruner-stats.json'), stats => stats.turns >= 1)
      const update = (pruner as { updateThresholds?: (thresholds: unknown) => void }).updateThresholds
      if (typeof update !== 'function') {
        // Published pruner versions predating `updateThresholds` keep their
        // configured threshold; the plugin must not crash on the missing hook.
        expect(pruner.config.thresholdChars).toBe(8192)
        return
      }
      expect(pruner.config.thresholdChars).toBe(8192)
      expect(pruner.pruneContent([{ type: 'text', text: 'x'.repeat(6_600) }])).not.toBeNull()
    } finally {
      await prunerFiber.dispose()
      await prunerCtx.fiber.dispose()
    }
  })
})
