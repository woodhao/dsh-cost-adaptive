/**
 * Public request and value vocabulary for the cost dashboard. This module
 * contains types only so generated Remote clients can consume it without
 * importing Host runtime code.
 *
 * @module @deepseek-ai/dsh-cost-adaptive/types
 */

/** One tool's ledger row as served to the dashboard. */
export interface CostToolSnapshot {
  /** Tool name (e.g. `bash`, `read`). */
  tool: string
  /** Total calls observed. */
  calls: number
  /** Calls whose result exceeded the configured threshold. */
  oversized: number
  /** Characters attributable to oversized results (size - threshold). */
  wasteChars: number
  /** Total result characters observed. */
  totalChars: number
  /** Explicit human feedback confirmations. */
  feedback: number
  /** Threshold in force for this tool (human override if set, else learned). */
  thresholdChars: number
}

/** One recent scored result of a tool, for the detail view. */
export interface CostRecentObservation {
  /** Result size in code points. */
  chars: number
  /** Whether this result exceeded the threshold in force at that time. */
  oversized: boolean
  /** Epoch millis of the observation. */
  at: number
}

/** One tool's detail view: aggregate row plus its recent observations. */
export interface CostToolDetail {
  /** The tool's aggregate ledger row. */
  row: CostToolSnapshot
  /** Recent observations, oldest first. */
  recent: CostRecentObservation[]
}

/** Ledger summary the cost dashboard renders. */
export interface CostSnapshot {
  /** Sessions that contributed observations. */
  sessions: number
  /** Turns that contributed observations. */
  turns: number
  /** Per-tool rows, ordered by waste. */
  tools: CostToolSnapshot[]
  /** Cumulative token usage, when any turn reported usage. */
  tokens?: {
    /** Total input tokens (cache hits included). */
    input: number
    /** Input tokens served from the prompt cache. */
    cached: number
    /** Total output tokens. */
    output: number
    /** Cache-hit rate 0–100. */
    cacheHitRate: number
  }
  /** Most recent turns' usage, newest last, for the comparison view. */
  recentRounds?: Array<{
    /** Input tokens of the turn (including cache reads). */
    input: number
    /** Input tokens served from the prompt cache. */
    cached: number
    /** Output tokens of the turn. */
    output: number
    /** Epoch millis of the turn end. */
    at: number
  }>
  /** Epoch millis of the newest observation. */
  lastSeen: number
}
