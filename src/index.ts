/**
 * Self-adapting context-cost guard for agent sessions.
 *
 * The plugin observes each turn's tool-result sizes and model usage through
 * the session event stream, folds them into a versioned cross-session
 * statistics file under the harness home, and derives one short guidance
 * section that is re-evaluated at every system-prompt assembly — so the model
 * sees the newest learned cost facts without any prompt reload.
 *
 * Learning is deterministic and explainable: nothing is trained or sampled;
 * each session simply accumulates per-tool counts, oversized rates, and waste
 * characters, and `deriveGuidance` turns the current snapshot into lines the
 * model can act on. User configuration (composition entry or the
 * `cost-adaptive` settings section) always wins over the learned layer.
 * @module @deepseek-ai/dsh-cost-adaptive
 */

import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
// Load the system-prompt declaration merge so `ctx.systemPrompt` types.
import type {} from '@deepseek-ai/dsh-system-prompt'
// Type-only: the `toolResultPruner` Context merge for the optional read.
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import {
  applyFeedback,
  applyObservation,
  applyTurn,
  codePointLength,
  deriveGuidance,
  derivePrunerThreshold,
  emptyStats,
  STATS_VERSION,
} from './store.ts'
import type { CostStats, ToolStats, TurnRecord } from './store.ts'
// Type-only: `command-feedback` owns the `feedback/record` SessionEventMap
// declaration; cost-adaptive consumes that event as explicit waste feedback.
import type {} from '@deepseek-ai/dsh-command-feedback'

/** The payload of a `tool/result` session event. */
type ToolResultData = SessionEventMap['tool/result']

export const name = 'cost-adaptive'

/** Services the plugin reads from the scoped context. */
export const inject = ['systemPrompt']

/** Settings namespace owning this plugin's user-configurable section. */
export const NS = settingsNamespace('cost-adaptive')

/** Plugin configuration, validated by the same-named schemastery schema. */
export interface Config {
  /** Result-size threshold in code points beyond which a tool result counts as oversized (default 8192). */
  thresholdChars?: number
  /** Minimum observed calls before a tool's record may influence guidance (default 3). */
  minCalls?: number
  /** Maximum guidance lines injected per assembly (default 2). */
  maxLines?: number
  /** Path to the cross-session statistics file; defaults to `$DSH_HOME/cost-adaptive/stats.json`. */
  statsPath?: string
  /** Persist statistics after every N turns (default 1). */
  flushEveryTurns?: number
  /** Disable observation and guidance entirely (default false). */
  disabled?: boolean
}

export const Config: z<Config> = z.object({
  thresholdChars: z.number().min(1).default(8192),
  minCalls: z.number().min(1).default(3),
  maxLines: z.number().min(0).default(2),
  statsPath: z.string().default(dshHomePath('cost-adaptive', 'stats.json')),
  flushEveryTurns: z.number().min(1).default(1),
  disabled: z.boolean().default(false),
})

/**
 * Resolve a partial configuration to the full set the plugin reads, applying
 * the same defaults the schema declares. Cordis validates plugin configs
 * against {@link Config} before {@link apply} runs, so the resolved object is
 * the authoritative input; the resolver keeps the defaulting explicit rather
 * than hidden in `?? fallback` reads throughout the plugin.
 * @param input - the validated (possibly partial) plugin config.
 * @returns the complete configuration with every field present.
 */
export function resolveConfig(input: Partial<Config>): ResolvedConfig {
  return {
    thresholdChars: input.thresholdChars ?? 8192,
    minCalls: input.minCalls ?? 3,
    maxLines: input.maxLines ?? 2,
    statsPath: input.statsPath ?? dshHomePath('cost-adaptive', 'stats.json'),
    flushEveryTurns: input.flushEveryTurns ?? 1,
    disabled: input.disabled ?? false,
  }
}

/** The fully resolved plugin configuration: every field is present. */
export type ResolvedConfig = Required<Config>

/** Guidance section order: tool-guidance band (100–199), before the tools' own descriptions. */
const GUIDANCE_ORDER = 150

/** One in-memory turn buffer awaiting settlement at `turn/end`. */
interface TurnBuffer {
  tools: Map<string, number>
  newInputTokens: number
  outputTokens: number
  turnEndedAt: number
}

/**
 * Load the statistics file if present, tolerating a missing file (first run)
 * and rejecting a corrupt or foreign-version document loudly — a wrong schema
 * must never be silently overwritten.
 * @param statsPath - file to read.
 * @returns the loaded snapshot, or a fresh empty one when the file is absent.
 */
export async function loadStats(statsPath: string): Promise<CostStats> {
  let raw: string
  try {
    raw = await readFile(statsPath, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStats()
    throw error
  }
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`cost-adaptive: statistics file ${statsPath} is not a JSON object`)
  }
  const candidate = parsed as Partial<CostStats>
  if (candidate.version !== STATS_VERSION) {
    throw new Error(
      `cost-adaptive: statistics file ${statsPath} has version ${String(candidate.version)}, expected ${STATS_VERSION}`,
    )
  }
  return candidate as CostStats
}

/**
 * Persist a snapshot atomically, creating the parent directory as needed.
 * Concurrent calls are safe: {@link writeFileAtomic} writes a random-suffix
 * sibling and renames it over the target, so a slower caller can never
 * clobber a newer snapshot mid-write (the last rename wins whole). The file
 * holds per-user cross-session statistics, so the tree stays private.
 * @param statsPath - file to write.
 * @param stats - snapshot to persist.
 */
export async function saveStats(statsPath: string, stats: CostStats): Promise<void> {
  await writeFileAtomic(statsPath, `${JSON.stringify(stats)}\n`, { mode: 0o600, dirMode: 0o700 })
}

/**
 * Compute the model-visible character size of one tool result.
 * @param data - the `tool/result` event payload.
 * @returns code-point length of every text block in the result.
 */
export function toolResultChars(data: ToolResultData): number {
  const block = data.message.content[0]
  let total = 0
  for (const part of block.content) {
    if (part.type === 'text') total += codePointLength(part.text)
  }
  return total
}

export function apply(ctx: Context, config: Config): void {
  if (config.disabled) return

  // The schema has already validated and defaulted `config`; resolveConfig
  // re-applies defaults so settings updates (partial user overrides) stay
  // complete, and every read goes through it (Explicit > implicit).
  let currentConfig: () => Config = () => config
  let stats: CostStats = emptyStats()
  let turnsSinceFlush = 0
  let sessionsSeen = new Set<string>()
  let writes: Promise<void> = Promise.resolve()
  const turnBuffers = new Map<Session, TurnBuffer>()
  const callNames = new Map<string, string>()

  const statsPathOf = (): string => resolveConfig(currentConfig()).statsPath
  const thresholdOf = (): number => resolveConfig(currentConfig()).thresholdChars

  // Chain of promises that must complete before a turn settles: the durable
  // load first, then each turn's settlement in arrival order. A load failure
  // degrades to an empty snapshot instead of blocking the chain.
  let statsReady: Promise<void> = loadStats(statsPathOf())
    .then((prior) => { stats = prior })
    .catch((error: unknown) => {
      ctx.logger.warn(`cost-adaptive: statistics load failed, starting empty: ${String(error)}`)
    })

  /** Fold every buffered observation of one turn into the snapshot. */
  const settleTurn = (session: Session, buffer: TurnBuffer): void => {
    const threshold = thresholdOf()
    const at = buffer.turnEndedAt
    for (const [tool, chars] of buffer.tools) {
      stats = applyObservation(stats, { tool, chars, thresholdChars: threshold, at })
    }
    const sessionIsNew = !sessionsSeen.has(session.id)
    if (sessionIsNew) sessionsSeen = new Set(sessionsSeen).add(session.id)
    const record: TurnRecord = { newInputTokens: buffer.newInputTokens, outputTokens: buffer.outputTokens, at }
    stats = applyTurn(stats, record, sessionIsNew)
    turnsSinceFlush += 1
    applyAdaptivePrunerThreshold()
  }

  /**
   * Drive the mounted tool-result pruner's threshold from the learned
   * snapshot. Optional: without a mounted pruner this is a no-op, so the
   * plugin stays composable on its own. The pruner's configured head and tail
   * budgets stay untouched; only the threshold moves, tightened from its own
   * configured base by the observed waste ratio.
   */
  const applyAdaptivePrunerThreshold = (): void => {
    const pruner = ctx.get('toolResultPruner')
    // The adaptive driver requires the pruner's runtime threshold override
    // (`updateThresholds`); older published pruner versions lack it, so the
    // optional tightening silently no-ops until the pruner catches up.
    if (pruner === undefined) return
    const update = (pruner as { updateThresholds?: (thresholds: unknown) => void }).updateThresholds
    if (typeof update !== 'function') return
    update({
      ...pruner.config,
      thresholdChars: derivePrunerThreshold(stats, pruner.config.thresholdChars),
    })
  }

  /** Persist the snapshot when the flush cadence is due; never await in the loop. */
  const maybeFlush = (): void => {
    if (turnsSinceFlush < resolveConfig(currentConfig()).flushEveryTurns) return
    turnsSinceFlush = 0
    persistNow()
  }

  /**
   * Persist the current snapshot immediately (used for rare explicit feedback).
   * Writes serialize on one queue so the final file always carries the newest
   * snapshot: `writeFileAtomic` renames whole, and the last queued write is
   * the last to rename, so an older snapshot can never land after a newer one.
   */
  const persistNow = (): void => {
    const snapshot = stats
    const statsPath = statsPathOf()
    writes = writes.then(() => saveStats(statsPath, snapshot)).catch((error: unknown) => {
      ctx.logger.warn(`cost-adaptive: statistics write failed: ${String(error)}`)
    })
  }

  const onSessionEvent = (session: Session, event: SessionEvent): void => {
    if (resolveConfig(currentConfig()).disabled) return
    let buffer = turnBuffers.get(session)
    if (event.type === 'tool/call') {
      callNames.set(String(event.data.callId), event.data.name)
    } else if (event.type === 'tool/result') {
      const nameOf = resolveToolName(event.data, callNames)
      buffer ??= freshBuffer()
      const chars = toolResultChars(event.data)
      buffer.tools.set(nameOf, (buffer.tools.get(nameOf) ?? 0) + chars)
      turnBuffers.set(session, buffer)
    } else if (event.type === 'assistant/message' && event.data.usage !== undefined) {
      buffer ??= freshBuffer()
      buffer.newInputTokens += event.data.usage.inputTokens
      buffer.outputTokens += event.data.usage.outputTokens
      turnBuffers.set(session, buffer)
    } else if (event.type === 'feedback/record') {
      // Explicit human feedback (e.g. the `command-feedback` plugin): confirm
      // the named tool as a context waster. It applies immediately — no turn
      // settlement needed — so the next assembly already carries it. Like
      // turn settlement, it waits for the prior snapshot load so a slow load
      // can never overwrite a confirmation that already landed.
      const text = event.data.text
      statsReady = statsReady.then(() => {
        for (const tool of toolsNamedInFeedback(text, stats.tools)) {
          stats = applyFeedback(stats, tool)
        }
        // Feedback is rare and explicit: persist immediately rather than
        // waiting for the next turn-cadence flush.
        applyAdaptivePrunerThreshold()
        persistNow()
      })
    } else if (event.type === 'turn/end') {
      const settled = buffer ?? freshBuffer()
      settled.turnEndedAt = Date.now()
      turnBuffers.delete(session)
      // The first turn may settle before the durable file finishes loading;
      // fold the turn only after the prior snapshot is present so a load can
      // never overwrite observations that already settled.
      statsReady = statsReady.then(() => {
        settleTurn(session, settled)
        maybeFlush()
      })
    }
  }

  ctx.on('session/event', onSessionEvent)

  // Re-evaluate the guidance section at every assembly so the newest learned
  // snapshot reaches the very next request. Empty guidance contributes
  // nothing to the prompt. The section registers a Cordis effect, so it is
  // disposed with this plugin's fiber.
  ctx.systemPrompt.section({
    name: 'cost-adaptive:guidance',
    order: GUIDANCE_ORDER,
    text: () => {
      const resolved = resolveConfig(currentConfig())
      return deriveGuidance(stats, resolved.minCalls, resolved.maxLines).join('\n')
    },
  })

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      currentConfig = source
    },
    onChange: () => {},
  })
}

/**
 * Extract the tool names a feedback text names, restricted to tools that
 * already have an observation record — feedback can only reinforce what was
 * observed. Matching is whole-token against the lowercased text, so a
 * feedback "keep grep output small" yields `grep`, and a mention like
 * "bashfulness" never matches `bash`.
 * @param text - the human feedback text.
 * @param tools - the current per-tool statistics records.
 * @returns the known tool names named by the feedback, in stats order.
 */
function toolsNamedInFeedback(text: string, tools: Record<string, ToolStats>): string[] {
  const words = new Set(text.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean))
  return Object.keys(tools).filter(tool => words.has(tool.toLowerCase()))
}

/** A fresh per-turn observation buffer. */
function freshBuffer(): TurnBuffer {
  return { tools: new Map(), newInputTokens: 0, outputTokens: 0, turnEndedAt: Date.now() }
}

/**
 * Resolve a tool result's tool name through the call-id map recorded from
 * `tool/call` events, falling back to the call id itself when the call was
 * never observed (replay boundary) — the fallback stays stable per call, so
 * aggregation still groups consistently.
 * @param data - the `tool/result` event payload.
 * @param callNames - call-id to tool-name map built from `tool/call` events.
 * @returns the tool name, or the call id when unknown.
 */
function resolveToolName(
  data: ToolResultData,
  callNames: Map<string, string>,
): string {
  const callId = String(data.message.content[0].toolCallId)
  return callNames.get(callId) ?? callId
}

export type { CostStats, ToolObservation, TurnRecord } from './store.ts'
export { applyFeedback, applyObservation, applyTurn, codePointLength, deriveGuidance, derivePrunerThreshold, emptyStats, STATS_VERSION } from './store.ts'
