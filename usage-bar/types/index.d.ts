/** A rate-limit window: share used and when it resets (ISO 8601). */
export type Limit = { percent: number; resetsAt?: string }

/** The live context window. */
export type Context = { tokens: number; window: number; percent: number }

/** Extra-usage credits, in the account's minor units (cents). */
export type Credits = {
  isEnabled: boolean
  usedCents: number
  currency: string
  /** usedCents at this session's first reading: what was spent before it. */
  startCents: number
}

/** The main thread's prompt cache, as far as the mod can tell. */
export type Cache = {
  /** When the last main-thread request that read or wrote it finished. */
  lastAt: number
  /** Prompt tokens of that request: what a keep-alive reads back. */
  tokens: number
  /** Share of that request's prompt read from the cache, 0-100. */
  hitPercent: number
  /** The person chose to let this entry (this lastAt) expire. */
  isDismissed?: boolean
  /** A keep-alive request is running, or the last one failed. */
  keepAlive?: 'running' | 'failed'
  /** A compaction dropped the cache; the next request writes a new one. */
  isCompacted?: boolean
}

export type RunningAgent = { id: string; type: string; description: string }

export type Bar = {
  /** Clock reading the drawing counts down from; bumped every minute. */
  now: number
  context?: Context
  /** Context tokens after each recent prompt, oldest first. */
  readings: number[]
  session?: Limit
  weekly?: Limit
  credits?: Credits
  cache?: Cache
  /** Cache lifetime set by environment (FORCE_PROMPT_CACHING_5M, CLAUDE_CODE_PROMPT_CACHE_TTL, ENABLE_PROMPT_CACHING_1H). */
  forcedTtl?: '5m' | '1h'
  /** Lifetime the last cache write asked for, when the response split it (ephemeral_1h / ephemeral_5m). */
  writtenTtl?: '5m' | '1h'
  /** Cache lifetime learned from hits and misses, overriding the inferred one. */
  seenTtl?: '5m' | '1h'
  /** When the credits reading last went up: those requests ran on credits. */
  creditsMovedAt?: number
  /** Every subagent id seen this session. */
  agentIds: string[]
  running: RunningAgent[]
}

declare module 'claude-code' {
  interface PluginState {
    'usage-bar': { bar: Bar }
  }
}
