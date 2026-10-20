import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Bar, Cache, Credits, Limit } from '../types'

// One band above the prompt in the desktop app:
//   ◑ 412k ▃▄▂█▆ ▲ +6.3k │ 5h ━━━╍── 74% · 2h 24m │ 7d ━━── 65% · 2d 20h │ cache 52 min [Extend] │ credits $1.84 │ 2 running · 7 agents
// Each pill has a hover card with the detail.

type $ = EngineInterface
type Els = Elements['desktop']

const bar = atom({ plugin: 'usage-bar', key: 'bar' } as const, { now: 0, readings: [], agentIds: [], running: [] } as Bar)

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// ---------- Usage credits: the account endpoint the /usage screen reads ----------

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
// The balance is only on the settings page: the endpoint does not report it.
const BALANCE_URL = 'https://claude.ai/settings/usage'
// The endpoint rate-limits, so all sessions share one reading through $.store:
// a session fetches only when the shared reading is older than FRESH_MS, and
// after a 429 every session waits out a backoff (Retry-After when given).
const FRESH_MS = 3 * MINUTE
const BACKOFF_MS = { first: 5 * MINUTE, max: HOUR }

type ApiUsage = {
  extra_usage?: { is_enabled?: boolean; used_credits?: number | null; currency?: string } | null
  // The same spend as money, in the account's currency.
  spend?: { used?: Money | null } | null
}
type Money = { amount_minor: number; currency: string; exponent: number }
type Shared = { fetchedAt: number; text: string }
type Block = { until: number; backoffMs: number }

const toCents = (m: Money) => Math.round(m.amount_minor * 10 ** (2 - m.exponent))

let inFlight: Promise<void> | undefined
let lastRaw = ''

// Reads the shared reading, fetching a new one when it is stale (or `force`),
// unless the endpoint asked everyone to back off. A call made while another
// runs waits for it; a forced one then reads again.
async function refreshCredits($: $, force = false) {
  if (inFlight) {
    await inFlight
    if (!force) return
  }
  inFlight = fetchCredits($, force).finally(() => (inFlight = undefined))
  await inFlight
}

async function fetchCredits($: $, force: boolean) {
  try {
    const now = await $.clock.now()
    const shared = (await $.store.get('reading')) as Shared | undefined
    const block = (await $.store.get('block')) as Block | undefined
    const isFresh = shared !== undefined && now - shared.fetchedAt < FRESH_MS
    const isBlocked = block !== undefined && now < block.until
    if ((isFresh && !force) || isBlocked) {
      if (shared) await applyCredits($, shared)
      return
    }
    const auth = await $.session.authorize()
    if (auth?.kind !== 'bearer') return // API key or 3P provider: no credits
    const res = await $.http.fetch(USAGE_URL, {
      auth: auth.handle,
      headers: { 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' },
    })
    lastRaw = res.text
    if (res.status === 429) {
      const backoffMs = Math.min(BACKOFF_MS.max, block ? block.backoffMs * 2 : BACKOFF_MS.first)
      const retryAfterMs = Number(res.headers['retry-after']) * 1000
      await $.store.set('block', { until: now + (retryAfterMs > 0 ? retryAfterMs : backoffMs), backoffMs } satisfies Block)
      if (shared) await applyCredits($, shared)
      return
    }
    if (!res.ok) {
      $.ui.log(`usage-bar: ${USAGE_URL} answered ${res.status}`, { to: 'debug' })
      return
    }
    const reading: Shared = { fetchedAt: now, text: res.text }
    await $.store.set('reading', reading)
    await $.store.delete('block')
    await applyCredits($, reading)
  } catch (error) {
    $.ui.log(`usage-bar: credits refresh failed: ${String(error)}`, { to: 'debug' })
  }
}

async function applyCredits($: $, reading: Shared) {
  const body = JSON.parse(reading.text) as ApiUsage
  const x = body.extra_usage
  if (!x) return
  const used = body.spend?.used
  const now = await $.clock.now()
  await update($, bar, b => {
    const usedCents = used ? toCents(used) : (x.used_credits ?? 0)
    // The first reading of the session is the baseline; a monthly reset (used
    // drops below it) starts the count from zero.
    const baseline = b.credits?.startCents ?? usedCents
    const credits: Credits = {
      isEnabled: x.is_enabled === true,
      usedCents,
      currency: used?.currency ?? x.currency ?? 'USD',
      startCents: usedCents < baseline ? 0 : baseline,
    }
    const hasMoved = b.credits !== undefined && usedCents > b.credits.usedCents
    return { ...b, credits, creditsMovedAt: hasMoved ? now : b.creditsMovedAt }
  })
}

const money = (cents: number, currency: string) => {
  const symbol = ({ USD: '$', EUR: '€', GBP: '£' } as Record<string, string>)[currency.toUpperCase()]
  const amount = (cents / 100).toFixed(2)
  return symbol ? `${symbol}${amount}` : `${amount} ${currency}`
}

const creditsSpent = (c: Credits) => Math.max(0, c.usedCents - c.startCents)

// ---------- Limits ----------

const SPANS: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 7 * DAY }

const fromLimit = (limits: SessionRateLimit[], kind: string): Limit | undefined => {
  const hit = limits.find(l => l.kind === kind)
  return hit && { percent: hit.percentUsed, resetsAt: hit.resetsAt }
}

// Share of the window's time already gone, 0-100; undefined without a reset time.
const elapsedPercent = (l: Limit, span: number, now: number) => {
  const at = l.resetsAt ? Date.parse(l.resetsAt) : NaN
  if (Number.isNaN(at) || now === 0) return undefined
  return Math.max(0, Math.min(100, (1 - (at - now) / span) * 100))
}

// Green while use keeps behind time; amber ahead of it; red from 90%, or when
// the pace would use the window up well before its reset.
type Tone = 'success' | 'warning' | 'error'
const toneOf = (used: number, elapsed: number | undefined): Tone => {
  if (used >= 90) return 'error'
  if (elapsed === undefined || used <= elapsed) return 'success'
  return elapsed > 5 && used / elapsed >= 1.3 ? 'error' : 'warning'
}
const COLOR: Record<Tone, string> = { success: '#30a46c', warning: '#e5a000', error: '#e5484d' }
const GREY = 'rgba(127,127,127,0.55)'
const TRACK = 'rgba(127,127,127,0.2)'

const GAUGE = { width: 54, height: 8 }
// Used share solid; the gap to the time elapsed hatched: grey while there is
// margin, in the bar's color when use runs ahead of time.
function gaugeSvg(used: number, elapsed: number | undefined, tone: Tone) {
  const { width: w, height: h } = GAUGE
  const x = (p: number) => (Math.max(0, Math.min(100, p)) / 100) * w
  const color = COLOR[tone]
  const parts = [`<rect width="${w}" height="${h}" rx="2" fill="${TRACK}"/>`]
  const solidTo = elapsed === undefined ? used : Math.min(used, elapsed)
  parts.push(`<rect width="${x(solidTo).toFixed(1)}" height="${h}" rx="2" fill="${color}"/>`)
  if (elapsed !== undefined && Math.abs(used - elapsed) >= 1) {
    const from = x(Math.min(used, elapsed))
    const to = x(Math.max(used, elapsed))
    const hatch = used > elapsed ? color : GREY
    parts.push(`<rect x="${from.toFixed(1)}" width="${(to - from).toFixed(1)}" height="${h}" fill="url(#hatch)"/>`)
    parts.unshift(
      `<defs><pattern id="hatch" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
        `<rect width="1.4" height="3" fill="${hatch}"/></pattern></defs>`,
    )
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join('')}</svg>`
}

// "2h 24m", "2d 20h", "8m": time until a reset.
function left(resetsAt: string | undefined, now: number) {
  const at = resetsAt ? Date.parse(resetsAt) : NaN
  if (Number.isNaN(at) || now === 0) return ''
  const ms = Math.max(0, at - now)
  const d = Math.floor(ms / DAY)
  const h = Math.floor((ms % DAY) / HOUR)
  const m = Math.floor((ms % HOUR) / MINUTE)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const clockTime = (ms: number) => {
  const at = new Date(ms)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}
const dayTime = (ms: number) => `${DAYS[new Date(ms).getDay()]} ${clockTime(ms)}`

// ---------- Context ----------

const HISTORY = 6 // readings kept: five deltas for the chart
const SPARK = { height: 14, bar: 5, gap: 2 }

// ○ ◔ ◑ ◕ ●: the window filling up.
const fillGlyph = (percent: number) =>
  percent < 12.5 ? '○' : percent < 37.5 ? '◔' : percent < 62.5 ? '◑' : percent < 87.5 ? '◕' : '●'
const contextTone = (percent: number): Tone => (percent >= 75 ? 'error' : percent >= 50 ? 'warning' : 'success')

const pushReading = (readings: number[], tokens: number) => {
  // The start reading is 0 before the first answer: drop it once a real one arrives.
  const kept = readings.filter(t => t > 0)
  // A reopened session reads the same context again: no duplicate.
  if (tokens > 0 && kept[kept.length - 1] === tokens) return kept
  return [...kept, tokens].slice(-HISTORY)
}

const toContext = (c: SessionContextUsage) =>
  c.window > 0
    ? { tokens: c.tokens ?? 0, window: c.window, percent: c.percent ?? Math.round(((c.tokens ?? 0) / c.window) * 100) }
    : undefined

// Tokens each recent prompt added; a compaction counts as 0.
const deltas = (readings: number[]) => readings.slice(1).map((t, i) => Math.max(0, t - (readings[i] ?? t)))

function sparkSvg(readings: number[], color: string) {
  const ds = deltas(readings)
  if (ds.length === 0) return undefined
  const top = Math.max(...ds, 1)
  const { height, bar: w, gap } = SPARK
  const width = ds.length * w + (ds.length - 1) * gap
  const rects = ds.map((d, i) => {
    const h = Math.max(1, (d / top) * height)
    const fill = i === ds.length - 1 ? color : GREY
    return `<rect x="${i * (w + gap)}" y="${(height - h).toFixed(1)}" width="${w}" height="${h.toFixed(1)}" rx="1.5" fill="${fill}"/>`
  })
  return { width, source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${rects.join('')}</svg>` }
}

function trend(readings: number[]) {
  if (readings.length < 2) return ''
  const d = (readings[readings.length - 1] ?? 0) - (readings[readings.length - 2] ?? 0)
  return d > 0 ? `▲ +${short(d)}` : d < 0 ? `▼ −${short(-d)}` : '='
}

// 1.2M, 107k, 98.3k, 950
function short(n: number) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 100_000) return `${Math.round(n / 1_000)}k`
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}k`
  return String(n)
}

// ---------- Prompt cache ----------

const TTL = { '5m': 5 * MINUTE, '1h': HOUR }

// The lifetime, first match wins: an environment override; what the last
// cache write asked for; what hits and misses proved. Otherwise Claude Code's
// default: 1 hour on a plan within its limits, 5 minutes once requests run on
// usage credits (a credits reading that just went up, or a limit at 100%).
function ttlMs(b: Bar) {
  const known = b.forcedTtl ?? b.writtenTtl ?? b.seenTtl
  if (known) return TTL[known]
  if (b.creditsMovedAt !== undefined && b.now - b.creditsMovedAt < 15 * MINUTE) return TTL['5m']
  const limits = [b.session, b.weekly].filter(Boolean) as Limit[]
  return limits.length > 0 && limits.every(l => l.percent < 100) ? TTL['1h'] : TTL['5m']
}

const ttlSource = (b: Bar) =>
  b.forcedTtl ? 'set by environment' : b.writtenTtl ? 'from the last cache write' : b.seenTtl ? 'seen in traffic' : 'inferred'

const isOn = (v: string | undefined) => /^(1|true|yes|on)$/i.test((v ?? '').trim())

// The overrides Claude Code reads, in its own order (the promptCacheTtl
// setting is not read here).
async function envTtl($: $): Promise<'5m' | '1h' | undefined> {
  try {
    if (isOn(await $.env.get('FORCE_PROMPT_CACHING_5M'))) return '5m'
    const ttl = (await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'))?.trim()
    if (ttl === '5m' || ttl === '1h') return ttl
    if (isOn(await $.env.get('ENABLE_PROMPT_CACHING_1H'))) return '1h'
  } catch {
    // No environment to read: Claude Code's defaults apply.
  }
  return undefined
}

const cacheLeftMs = (b: Bar, c: Cache) => c.lastAt + ttlMs(b) - b.now
// The reminder comes 5 minutes before expiry, 1 minute for a 5-minute entry.
const remindBeforeMs = (ttl: number) => Math.min(5 * MINUTE, ttl / 5)
const isReminding = (b: Bar, c: Cache) => {
  const ms = cacheLeftMs(b, c)
  return !c.isDismissed && !c.isCompacted && ms > 0 && ms <= remindBeforeMs(ttlMs(b))
}

// A response below these shares of cache reads, with a real write, missed.
const MISS_SHARE = 50
const MISS_WRITE = 2_000

type StepUsage = {
  input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  model?: string
  // The API's split of the write by lifetime; not in the mod API's types, read when present.
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number }
}

// A main-thread request finished: its prompt read or wrote the cache, whose
// lifetime starts over. A hit more than 5 minutes after the previous request
// proves the 1-hour lifetime; a miss within the hour says 5 minutes.
function recordRequest(b: Bar, at: number, u: StepUsage, model: string): Bar {
  const read = u.cache_read_input_tokens ?? 0
  const write = u.cache_creation_input_tokens ?? 0
  const tokens = read + write + (u.input_tokens ?? 0)
  const hitPercent = tokens > 0 ? Math.round((read / tokens) * 100) : 0
  const prev = b.cache
  let seenTtl = b.seenTtl
  if (prev && !prev.isCompacted) {
    const gap = at - prev.lastAt
    const missed = hitPercent < MISS_SHARE && write > MISS_WRITE
    if (!missed && read > 0 && gap > TTL['5m']) seenTtl = '1h'
    else if (missed && gap > TTL['5m'] && gap < TTL['1h'] && tokens >= prev.tokens && model === lastModel) seenTtl = '5m'
  }
  lastModel = model
  const split = u.cache_creation
  const writtenTtl =
    (split?.ephemeral_1h_input_tokens ?? 0) > 0 ? '1h' : (split?.ephemeral_5m_input_tokens ?? 0) > 0 ? '5m' : b.writtenTtl
  return { ...b, now: at, seenTtl, writtenTtl, cache: { lastAt: at, tokens, hitPercent } }
}
let lastModel = ''

let remindedFor = 0
// The last keep-alive, for /usage-bar: when, and how much of it the cache served.
let lastKeepAlive = ''

// One tiny request over the conversation: it reads the cached prefix, which
// starts the entry's lifetime over. Costs a cache read of the whole context.
async function keepAlive($: $) {
  await update($, bar, b => (b.cache ? { ...b, cache: { ...b.cache, keepAlive: 'running' as const } } : b))
  const startedAt = await $.clock.now()
  const reply = await $.model.fork({ prompt: 'Reply with just: OK' })
  const now = await $.clock.now()
  lastKeepAlive = reply.isAnswered
    ? `${clockTime(startedAt)}, read ${reply.usage?.cache_read_input_tokens ?? 0} / wrote ${reply.usage?.cache_creation_input_tokens ?? 0} / uncached ${reply.usage?.input_tokens ?? 0} tokens`
    : `${clockTime(startedAt)}, failed: ${reply.reason}`
  await update($, bar, b => {
    if (!b.cache) return b
    if (!reply.isAnswered) return { ...b, now, cache: { ...b.cache, keepAlive: 'failed' as const } }
    return { ...b, now, cache: { ...b.cache, lastAt: startedAt, isDismissed: false, keepAlive: undefined } }
  })
  if (!reply.isAnswered) $.ui.toast(`Cache keep-alive failed: ${reply.reason}`)
}

async function letExpire($: $) {
  await update($, bar, b => (b.cache ? { ...b, cache: { ...b.cache, isDismissed: true } } : b))
}

// ---------- Agents ----------

async function refreshAgents($: $) {
  let list
  try {
    list = await $.agent.list()
  } catch {
    return
  }
  const running = list
    .filter(a => a.status === 'running')
    .map(a => ({ id: a.id, type: a.type ?? '', description: a.description ?? '' }))
  const ids = list.map(a => a.id)
  const b = await read($, bar)
  const isNewId = ids.some(id => !b.agentIds.includes(id))
  const isSameRunning = running.map(a => a.id).join() === b.running.map(a => a.id).join()
  if (!isNewId && isSameRunning) return
  await update($, bar, b => ({
    ...b,
    agentIds: [...b.agentIds, ...ids.filter(id => !b.agentIds.includes(id))],
    running,
  }))
}

// ---------- Ticking ----------

// Each minute: redraw the countdowns, remind before the cache expires, and read
// the credits again once the shared reading is stale.
async function tick($: $) {
  const now = await $.clock.now()
  const b = await update($, bar, b => ({ ...b, now }))
  if (b.cache && isReminding(b, b.cache) && remindedFor !== b.cache.lastAt) {
    remindedFor = b.cache.lastAt
    $.ui.toast('Prompt cache expires soon. Keep it alive from the band above the prompt.', { timeoutMs: 15_000 })
  }
  await refreshCredits($)
}

const summary = (b: Bar) =>
  [
    b.context && `Context ${b.context.tokens} / ${b.context.window} tokens (${b.context.percent}%)`,
    b.session && `5h ${b.session.percent}% (resets ${b.session.resetsAt ?? '?'})`,
    b.weekly && `7d ${b.weekly.percent}% (resets ${b.weekly.resetsAt ?? '?'})`,
    b.cache && `Cache ${Math.round(cacheLeftMs(b, b.cache) / 1000)}s left of ${ttlMs(b) / MINUTE} min (${ttlSource(b)}), ${b.cache.hitPercent}% hit`,
    b.credits && `Credits ${b.credits.isEnabled ? money(creditsSpent(b.credits), b.credits.currency) : 'off'} this session`,
    `Agents ${b.running.length} running, ${b.agentIds.length} seen`,
    lastKeepAlive && `Last keep-alive ${lastKeepAlive}`,
  ]
    .filter(Boolean)
    .join('\n')

// ---------- Hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-bar',
      description: 'Refresh the usage bar now and show its raw figures',
    })
    const usage = await $.session.usage()
    const now = await $.clock.now()
    const forcedTtl = await envTtl($)
    await update($, bar, b => {
      const context = toContext(usage.context) ?? b.context
      return {
        ...b,
        now,
        forcedTtl,
        context,
        readings: context ? pushReading(b.readings, context.tokens) : b.readings,
        session: fromLimit(usage.rateLimits, 'five_hour') ?? b.session,
        weekly: fromLimit(usage.rateLimits, 'seven_day') ?? b.weekly,
      }
    })
    void refreshCredits($)
    void refreshAgents($)
    $.clock.every(MINUTE, () => void tick($))
    $.clock.every(10_000, () => void refreshAgents($))
    return next(e)
  })

  // Pushed by the engine after each response and whenever a window moves a point.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits') || e.changed.includes('context')) {
      const now = await $.clock.now()
      await update($, bar, b => ({
        ...b,
        now,
        context: toContext(e.context) ?? b.context,
        session: fromLimit(e.rateLimits, 'five_hour') ?? b.session,
        weekly: fromLimit(e.rateLimits, 'seven_day') ?? b.weekly,
      }))
    }
    return next(e)
  })

  // Each main-thread request: how much of its prompt the cache served, and
  // when the entry's lifetime starts over. Subagents have their own caches.
  // The lifetime counts from the start of the request that read or wrote the entry.
  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    const result = yield* next(e)
    if (!e.agentId && result?.usage) {
      const usage = result.usage
      await update($, bar, b => recordRequest(b, startedAt, usage, usage.model || e.model))
    }
    void refreshAgents($)
    return result
  })

  // One context reading per main-thread prompt; credits move only through the
  // endpoint, so read them again (if stale).
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) {
      void refreshAgents($)
      return result
    }
    try {
      const usage = await $.session.usage()
      const context = toContext(usage.context)
      if (context) await update($, bar, b => ({ ...b, context, readings: pushReading(b.readings, context.tokens) }))
    } catch {
      // No reading this turn: the band keeps the previous one.
    }
    void refreshCredits($)
    return result
  })

  // A compaction: the context drops now, and the next request writes a new cache.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || e.trigger === 'precompute' || !result || 'skip' in result) return result
    try {
      const context = (result.tokensAfter ?? 0) > 0 ? undefined : toContext((await $.session.usage()).context)
      await update($, bar, b => {
        const tokens = result.tokensAfter ?? context?.tokens ?? 0
        const window = b.context?.window ?? context?.window ?? 0
        const dropped: Bar = { ...b, cache: b.cache && { ...b.cache, isCompacted: true, keepAlive: undefined } }
        if (window === 0) return dropped
        return {
          ...dropped,
          context: { tokens, window, percent: Math.round((tokens / window) * 100) },
          readings: pushReading(b.readings, tokens),
        }
      })
    } catch {
      // The band catches up at the end of the next prompt.
    }
    return result
  })

  on('command.run', { command: 'usage-bar' }, async $ => {
    await refreshCredits($, true)
    await refreshAgents($)
    const now = await $.clock.now()
    const b = await update($, bar, b => ({ ...b, now }))
    return { text: `${summary(b)}\n\nCredits endpoint: ${lastRaw || '(no response)'}` }
  })

  // Desktop app only: the band above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.surface !== 'desktop') return next(e)
    const b = await read($, bar)
    if (!b.context && !b.session && !b.weekly) return next(e)
    const els = $.ui.resolve(e)
    const line = drawLine($, els, b, e.props.isWorking)
    // Mods placed after us draw below our line.
    const below = await next(e)
    return isBlank(below) ? line : <els.Box flexDirection="column">{line}{below}</els.Box>
  })
}

function isBlank(node: unknown) {
  if (node === null || node === undefined || node === false) return true
  const n = node as { props?: { children?: unknown } }
  const children = n.props?.children
  return Array.isArray(children) ? children.every(isBlank) : children === undefined
}

// ---------- Drawing ----------

// A card under the pointer: hidden until the pill is hovered, drawn above the band.
// An indented line is a detail of the one above it: dim.
function hoverCard({ Box, Text }: Els, lines: (string | false | undefined)[], extra?: unknown) {
  const shown = lines.filter((l): l is string => typeof l === 'string')
  return (
    <Box
      position="absolute"
      bottom={1}
      left={0}
      display="none"
      hover={{ display: 'flex' }}
      flexDirection="column"
      paddingX={1}
      borderStyle="round"
      borderColor="subtle"
      backgroundColor="background"
    >
      {shown.map((line, i) => (
        <Text key={`l${i}`} dimColor={line.startsWith('  ')}>
          {line}
        </Text>
      ))}
      {extra as never}
    </Box>
  )
}

function pill(els: Els, key: string, body: unknown, card: unknown) {
  const { Box } = els
  return (
    <Box key={key} position="relative" flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
      {body as never}
      {card as never}
    </Box>
  )
}

function drawLine($: $, els: Els, b: Bar, isWorking: boolean) {
  const { Box, Text } = els
  const pills = [
    b.context && contextPill(els, b),
    b.session && limitPill(els, 'five_hour', '5h', b.session, b.now),
    b.weekly && limitPill(els, 'seven_day', '7d', b.weekly, b.now),
    b.cache && cachePill($, els, b, b.cache, isWorking),
    b.credits?.isEnabled && creditsPill(els, b.credits),
    b.agentIds.length > 0 && agentsPill(els, b),
  ].filter(Boolean)
  const children: unknown[] = []
  pills.forEach((p, i) => {
    if (i > 0)
      children.push(
        <Text key={`sep${i}`} dimColor>
          │
        </Text>,
      )
    children.push(p)
  })
  return (
    <Box flexDirection="row" alignItems="center" columnGap={1} flexWrap="wrap">
      {children as never}
    </Box>
  )
}

function contextPill(els: Els, b: Bar) {
  const { Text, Svg } = els
  const c = b.context!
  const tone = contextTone(c.percent)
  const spark = sparkSvg(b.readings, COLOR[tone])
  const t = trend(b.readings)
  const body = [
    <Text key="glyph" color={tone}>
      {fillGlyph(c.percent)}
    </Text>,
    <Text key="tokens">{short(c.tokens)}</Text>,
    spark && (
      <Svg key="spark" source={spark.source} alt="Tokens added by recent prompts" width={spark.width} height={SPARK.height} />
    ),
    t && (
      <Text key="trend" dimColor>
        {t}
      </Text>
    ),
  ]
  const card = hoverCard(els, [
    `Context ${c.percent}% of ${short(c.window)}`,
    `  ${c.tokens.toLocaleString('en-US')} tokens`,
    deltas(b.readings).length > 0 && `  Last prompts: ${deltas(b.readings).map(d => `+${short(d)}`).join(', ')}`,
  ])
  return pill(els, 'context', body, card)
}

function limitPill(els: Els, kind: string, label: string, l: Limit, now: number) {
  const { Text, Svg } = els
  const elapsed = elapsedPercent(l, SPANS[kind] ?? DAY, now)
  const tone = toneOf(l.percent, elapsed)
  const rest = left(l.resetsAt, now)
  const body = [
    <Text key="label" dimColor>
      {label}
    </Text>,
    <Svg
      key="gauge"
      source={gaugeSvg(l.percent, elapsed, tone)}
      alt={`${label} ${l.percent}% used`}
      width={GAUGE.width}
      height={GAUGE.height}
    />,
    <Text key="value" color={tone === 'success' ? undefined : tone}>
      {Math.round(l.percent)}%
    </Text>,
    rest && (
      <Text key="left" dimColor>
        · {rest}
      </Text>
    ),
  ]
  const at = l.resetsAt ? Date.parse(l.resetsAt) : NaN
  const title = kind === 'five_hour' ? 'Session limit (5 hours)' : 'Weekly limit (7 days)'
  const card = hoverCard(els, [
    `${title}: ${l.percent}% used`,
    elapsed !== undefined && `  ${Math.round(elapsed)}% of the window has passed`,
    !Number.isNaN(at) && `  Resets ${kind === 'five_hour' ? `at ${clockTime(at)}` : dayTime(at)}`,
  ])
  return pill(els, kind, body, card)
}

function cachePill($: $, els: Els, b: Bar, c: Cache, isWorking: boolean) {
  const { Text, Button } = els
  const ttl = ttlMs(b)
  const ms = cacheLeftMs(b, c)
  const minutes = Math.ceil(ms / MINUTE)
  const isExpired = ms <= 0 && !c.isCompacted
  const isAsking = !isWorking && c.keepAlive !== 'running' && isReminding(b, c)
  const canExtend = !isWorking && !isExpired && !c.isCompacted && c.keepAlive !== 'running'
  const status = isWorking
    ? 'in use'
    : c.isCompacted
      ? 'rebuilds next message'
      : c.keepAlive === 'running'
        ? 'extending…'
        : isExpired
          ? 'expired'
          : minutes > 1
            ? `${minutes} min`
            : '< 1 min'
  const color = isExpired ? 'error' : isAsking ? 'warning' : undefined
  const body = [
    <Text key="label" dimColor>
      cache
    </Text>,
    <Text key="status" color={color} dimColor={!color && !isWorking}>
      {status}
      {c.keepAlive === 'failed' ? ' · extend failed' : ''}
    </Text>,
    canExtend && (
      <Button
        key="extend"
        label={isAsking ? 'Keep alive' : 'Extend'}
        variant={isAsking ? 'primary' : 'secondary'}
        plain={isAsking ? undefined : true}
        onPress={() => keepAlive($)}
      />
    ),
    isAsking && <Button key="let-expire" label="Let it expire" plain dimColor onPress={() => letExpire($)} />,
  ]
  const card = hoverCard(els, [
    isExpired ? `Prompt cache expired at ${clockTime(c.lastAt + ttl)}` : `Prompt cache expires at ${clockTime(c.lastAt + ttl)}`,
    `  Lifetime ${ttl === HOUR ? '1 hour' : '5 minutes'} (${ttlSource(b)})`,
    `  Last request read ${c.hitPercent}% of ${short(c.tokens)} tokens from the cache`,
    canExtend && `  Extend sends one tiny request that reads ${short(c.tokens)} tokens from the cache`,
    canExtend && '  (about a tenth of the input price, counted against your limits)',
  ])
  return pill(els, 'cache', body, card)
}

function creditsPill(els: Els, c: Credits) {
  const { Text, Link } = els
  const body = [
    <Text key="label" dimColor>
      credits
    </Text>,
    <Text key="value">{money(creditsSpent(c), c.currency)}</Text>,
  ]
  const card = hoverCard(
    els,
    [
      'Usage credits spent since this session started',
      '  Across your whole account, not only this session',
      '  Read from your account every few minutes',
    ],
    <Link key="balance" href={BALANCE_URL} label="Balance" />,
  )
  return pill(els, 'credits', body, card)
}

function agentsPill(els: Els, b: Bar) {
  const { Text } = els
  const total = b.agentIds.length
  const running = b.running.length
  const text = running > 0 ? `${running} running · ${total}` : total === 1 ? '1 agent' : `${total} agents`
  const body = [
    <Text key="value" color={running > 0 ? 'claude' : undefined} dimColor={running === 0}>
      {text}
    </Text>,
  ]
  const card = hoverCard(els, [
    `${total} subagent${total === 1 ? '' : 's'} this session`,
    ...b.running.map(a => `  ${a.type}${a.description ? ` · ${a.description}` : ''}`),
  ])
  return pill(els, 'agents', body, card)
}
