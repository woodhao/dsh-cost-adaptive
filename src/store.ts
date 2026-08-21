/**
 * Versioned cross-session cost statistics for `@deepseek-ai/dsh-cost-adaptive`.
 *
 * The store owns one immutable snapshot per flush: load merges any existing
 * file, `applyTurn` folds one scored turn into the snapshot, and `save` writes
 * atomically. All mutation happens on copies so a failed write never corrupts
 * the in-memory state.
 *
 * @module @deepseek-ai/dsh-cost-adaptive/store
 */

/** Version of the on-disk statistics schema. Bump on any breaking format change. */
export const STATS_VERSION = 2

/** Per-tool aggregated cost observations across sessions. */
/** One scored tool result kept for the per-tool detail view (bounded window). */
export interface RecentObservation {
  /** Result size in code points. */
  chars: number
  /** Whether this result exceeded the threshold in force at that time. */
  oversized: boolean
  /** Epoch millis of the observation. */
  at: number
}

/** How many recent observations one tool retains for the detail view. */
export const RECENT_WINDOW = 12

export interface ToolStats {
  /** Total tool calls observed. */
  calls: number
  /** Calls whose result text exceeded the configured threshold. */
  oversized: number
  /** Total result characters observed for this tool. */
  totalChars: number
  /** Characters attributable to results over the threshold (size - threshold, floored at 0). */
  wasteChars: number
  /** Epoch millis of the newest observation. */
  lastSeen: number
  /** Explicit human confirmations that this tool wastes context (feedback events naming it). */
  feedback: number
  /** Most recent scored results, newest last, for the detail view. */
  recent: RecentObservation[]
}

/** Cumulative token usage across sessions (model request accounting). */
export interface TokenTotals {
  /** Total input tokens sent (including cache reads). */
  input: number
  /** Input tokens served from the provider's prompt cache. */
  cached: number
  /** Total output tokens produced. */
  output: number
  /** Input tokens of the most recently recorded turn. */
  lastInput: number
  /** Cached input tokens of the most recently recorded turn. */
  lastCached: number
  /** Output tokens of the most recently recorded turn. */
  lastOutput: number
}

/** One turn's token usage kept for the recent-rounds comparison view. */
export interface TurnSample {
  /** Input tokens of the turn (including cache reads). */
  input: number
  /** Input tokens served from the prompt cache. */
  cached: number
  /** Output tokens of the turn. */
  output: number
  /** Epoch millis of the turn end. */
  at: number
}

/** How many recent turns the comparison view retains. */
export const RECENT_TURNS = 10

/** One turn's scored usage deltas, ready to be recorded. */
export interface TurnRecord {
  /** New (uncached) input tokens written by this turn's requests. */
  newInputTokens: number
  /** Input tokens this turn read from the provider's prompt cache. */
  cachedInputTokens?: number
  /** Output tokens produced by this turn's requests. */
  outputTokens: number
  /** Epoch millis of the turn end. */
  at: number
}

/** One scored tool result folded into the store. */
export interface ToolObservation {
  /** Tool name (e.g. `grep`, `read`, `bash`). */
  tool: string
  /** Result text code-point length. */
  chars: number
  /** The threshold this observation was judged against. */
  thresholdChars: number
  /** Epoch millis of the observation. */
  at: number
}

/** The complete versioned statistics document. */
export interface CostStats {
  version: typeof STATS_VERSION
  /** Number of sessions that contributed observations. */
  sessions: number
  /** Number of turns that contributed observations. */
  turns: number
  /** Aggregated per-tool observations, keyed by tool name. */
  tools: Record<string, ToolStats>
  /** Cumulative token usage across sessions. */
  tokens?: TokenTotals
  /** Most recent turns' token usage, newest last, for the comparison view. */
  recentTurns?: TurnSample[]
  /**
   * Human-set per-tool threshold overrides in code points, keyed by tool
   * name. A present key pins that tool's threshold regardless of what the
   * learned layer would derive; absence means the learned value applies.
   */
  userThresholds?: Record<string, number>
}

/**
 * An empty statistics document at the current schema version.
 * @returns a fresh snapshot with no sessions, turns, or tool records.
 */
export function emptyStats(): CostStats {
  return { version: STATS_VERSION, sessions: 0, turns: 0, tools: {} }
}

/**
 * Set or clear a human threshold override for one tool and return a new
 * snapshot. The input snapshot is not mutated. Setting to `null` clears the
 * override so the learned layer governs again.
 * @param stats - snapshot to modify.
 * @param tool - tool whose threshold the human overrides.
 * @param thresholdChars - override in code points, or `null` to clear it.
 * @returns a new snapshot with the override applied.
 */
export function setUserThreshold(
  stats: CostStats,
  tool: string,
  thresholdChars: number | null,
): CostStats {
  if (thresholdChars === null) {
    if (stats.userThresholds === undefined || stats.userThresholds[tool] === undefined) return stats
    const { [tool]: _removed, ...userThresholds } = stats.userThresholds
    void _removed
    if (Object.keys(userThresholds).length === 0) {
      const { userThresholds: _rest, ...rest } = stats
      void _rest
      return rest
    }
    return { ...stats, userThresholds }
  }
  return {
    ...stats,
    userThresholds: { ...stats.userThresholds, [tool]: thresholdChars },
  }
}

/**
 * Code-point length of a string without splitting surrogate pairs.
 * @param value - the string to measure.
 * @returns the number of Unicode code points.
 */
export function codePointLength(value: string): number {
  return Array.from(value).length
}

/**
 * Fold one tool observation into a snapshot and return a new snapshot.
 * The input snapshot is not mutated.
 * @param stats - snapshot to fold into.
 * @param observation - the observed tool result.
 * @returns a new snapshot with the observation merged.
 */
export function applyObservation(stats: CostStats, observation: ToolObservation): CostStats {
  const next = { ...stats, tools: { ...stats.tools } }
  const prior = next.tools[observation.tool]
  const observationEntry: RecentObservation = {
    chars: observation.chars,
    oversized: observation.chars > observation.thresholdChars,
    at: observation.at,
  }
  next.tools[observation.tool] = prior === undefined
    ? {
      calls: 1,
      oversized: observationEntry.oversized ? 1 : 0,
      totalChars: observation.chars,
      wasteChars: Math.max(0, observation.chars - observation.thresholdChars),
      lastSeen: observation.at,
      feedback: 0,
      recent: [observationEntry],
    }
    : {
      calls: prior.calls + 1,
      oversized: prior.oversized + (observationEntry.oversized ? 1 : 0),
      totalChars: prior.totalChars + observation.chars,
      wasteChars: prior.wasteChars + Math.max(0, observation.chars - observation.thresholdChars),
      lastSeen: observation.at,
      feedback: prior.feedback,
      recent: [...(prior.recent ?? []), observationEntry].slice(-RECENT_WINDOW),
    }
  return next
}

/**
 * Fold one explicit human feedback confirmation into a snapshot and return a
 * new snapshot. The input snapshot is not mutated. A tool that has no record
 * yet is left untouched — feedback can only reinforce an observed tool.
 * @param stats - snapshot to fold into.
 * @param tool - the tool the feedback named as wasting context.
 * @returns a new snapshot with the tool's feedback count incremented, or the
 * input unchanged when the tool has no record.
 */
export function applyFeedback(stats: CostStats, tool: string): CostStats {
  const prior = stats.tools[tool]
  if (prior === undefined) return stats
  return {
    ...stats,
    tools: {
      ...stats.tools,
      [tool]: { ...prior, feedback: prior.feedback + 1 },
    },
  }
}

/** One turn's scored usage deltas, ready to be recorded. */
export interface TurnRecord {
  /** New (uncached) input tokens written by this turn's requests. */
  newInputTokens: number
  /** Output tokens produced by this turn's requests. */
  outputTokens: number
  /** Epoch millis of the turn end. */
  at: number
}

/**
 * Fold one scored turn into a snapshot and return a new snapshot.
 * The input snapshot is not mutated.
 * @param stats - snapshot to fold into.
 * @param record - the scored turn.
 * @param sessionIsNew - whether this turn belongs to a session not yet counted.
 * @returns a new snapshot with the turn recorded.
 */
export function applyTurn(stats: CostStats, record: TurnRecord, sessionIsNew: boolean): CostStats {
  const priorTokens = stats.tokens ?? { input: 0, cached: 0, output: 0, lastInput: 0, lastCached: 0, lastOutput: 0 }
  const cached = record.cachedInputTokens ?? 0
  // Providers report `newInputTokens` excluding the cached portion (the
  // DeepSeek provider subtracts cache reads from prompt tokens), so the
  // ledger's `input` folds both: cached is a strict subset of input.
  const input = record.newInputTokens + cached
  const tokens: TokenTotals = {
    input: priorTokens.input + input,
    cached: priorTokens.cached + cached,
    output: priorTokens.output + record.outputTokens,
    lastInput: input,
    lastCached: cached,
    lastOutput: record.outputTokens,
  }
  const sample: TurnSample = { input, cached, output: record.outputTokens, at: record.at }
  return {
    ...stats,
    sessions: stats.sessions + (sessionIsNew ? 1 : 0),
    turns: stats.turns + 1,
    tokens,
    recentTurns: [...(stats.recentTurns ?? []), sample].slice(-RECENT_TURNS),
  }
}

/**
 * Deterministic snapshot-derived guidance: the tools that most often exceed
 * their result budget, plus any tool an explicit feedback named as wasting
 * context, capped at `maxLines`. Empty when nothing is learned yet — so an
 * idle deployment contributes nothing to the prompt.
 *
 * A tool qualifies when it has enough observations with oversized results,
 * OR when a human feedback confirmed it wastes context (explicit confirmation
 * outweighs the observation minimum). Within the qualified set, feedback
 * confirmations double the tool's weight against the observed waste.
 * @param stats - current statistics snapshot.
 * @param minCalls - minimum observed calls before an observed-only tool's record is trusted.
 * @param maxLines - maximum guidance lines to emit.
 * @returns one guidance line per offender, highest-weight first, or an empty array.
 */
export function deriveGuidance(
  stats: CostStats,
  minCalls: number,
  maxLines: number,
): string[] {
  const offenders = Object.entries(stats.tools)
    .filter(([, tool]) => (tool.calls >= minCalls && tool.oversized > 0) || tool.feedback > 0)
    .sort((a, b) => weightOf(b[1]) - weightOf(a[1]))
    .slice(0, maxLines)
  return offenders.map(([tool, record]) => {
    const rate = Math.round((record.oversized / record.calls) * 100)
    const chars = record.totalChars.toLocaleString('en-US')
    const confirmed = record.feedback > 0 ? ' [confirmed]' : ''
    return `${tool}: ${record.calls} calls, ${rate}% oversized, ${chars} chars total — narrow the query or read in offset/limit slices.${confirmed}`
  })
}

/** Guidance weight: observed waste, doubled per explicit feedback confirmation. */
function weightOf(tool: ToolStats): number {
  return tool.wasteChars * (tool.feedback + 1)
}

/**
 * Derive an adaptive tool-result-pruner threshold from the learned snapshot.
 * The pruner's job is to rewrite results that overflow context; the more the
 * observed sessions waste on oversized results, the earlier (lower) the
 * pruning threshold should cut. The tightening is bounded so a cold or clean
 * deployment never prunes aggressively.
 *
 * Tension scales with the waste ratio: at or below the observation floor the
 * base threshold is returned; at a 100% waste ratio (every recorded char is
 * waste) the threshold falls to 60% of base. Each explicit feedback
 * confirmation of waste tightens an additional 10%, to a 50% floor.
 * @param stats - current statistics snapshot.
 * @param baseThreshold - the configured default pruning threshold.
 * @returns the derived pruning threshold for the current snapshot.
 */
export function derivePrunerThreshold(stats: CostStats, baseThreshold: number): number {
  const totals = { waste: 0, chars: 0 }
  for (const tool of Object.values(stats.tools)) {
    totals.waste += tool.wasteChars
    totals.chars += tool.totalChars
  }
  if (totals.chars === 0) return baseThreshold
  const wasteRatio = totals.waste / totals.chars
  const feedbackCount = Object.values(stats.tools).reduce((sum, tool) => sum + tool.feedback, 0)
  const tightening = Math.min(0.4 + feedbackCount * 0.1, 0.5)
  const factor = 1 - wasteRatio * tightening
  return Math.max(1, Math.round(baseThreshold * factor))
}
