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

// Reads the shared reading, fetching a new one once it is older than
// `maxAgeMs`, unless the endpoint asked everyone to back off. A call made
// while another runs waits for it, then reads again if it asked for fresher.
async function refreshCredits($: $, maxAgeMs = FRESH_MS) {
  if (inFlight) {
    await inFlight
    if (maxAgeMs >= FRESH_MS) return
  }
  inFlight = fetchCredits($, maxAgeMs).finally(() => (inFlight = undefined))
  await inFlight
}

// After a reply or a subagent's last turn: read again 5 seconds later, once,
// however many finish together, and only if the last reading is 30 s old.
const SOON_MS = 5_000
const SOON_MAX_AGE_MS = 30_000
let isSoon = false
async function refreshCreditsSoon($: $) {
  if (isSoon) return
  isSoon = true
  try {
    await $.clock.sleep(SOON_MS)
  } finally {
    isSoon = false
  }
  await refreshCredits($, SOON_MAX_AGE_MS)
}

async function fetchCredits($: $, maxAgeMs: number) {
  try {
    const now = await $.clock.now()
    const shared = (await $.store.get('reading')) as Shared | undefined
    const block = (await $.store.get('block')) as Block | undefined
    const isFresh = shared !== undefined && now - shared.fetchedAt < maxAgeMs
    const isBlocked = block !== undefined && now < block.until
    if (isFresh || isBlocked) {
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

// Credits are billed at API prices, which is what the session's own cost
// counts. The account says how much credit spend rose between two readings;
// this session claims that rise only up to its own cost of the last
// POOL_MS not yet claimed. So the figure never passes what the session cost
// nor what the account was charged: turning credits on (the account then
// shows earlier spend) or another session spending while this one idles adds
// nothing. Two sessions spending at the same moment can split it unevenly.
const POOL_MS = 15 * MINUTE

async function applyCredits($: $, reading: Shared) {
  const body = JSON.parse(reading.text) as ApiUsage
  const x = body.extra_usage
  if (!x) return
  const used = body.spend?.used
  const now = await $.clock.now()
  let costCents = 0
  try {
    costCents = ((await $.session.usage()).cost?.usd ?? 0) * 100
  } catch {
    // No ledger: nothing to match.
  }
  await update($, bar, b => {
    const usedCents = used ? toCents(used) : (x.used_credits ?? 0)
    const isEnabled = x.is_enabled === true
    const prev = b.credits
    // A first reading, or one from before the reset fix: start matching now.
    if (!prev || prev.pool === undefined) {
      const credits: Credits = { isEnabled, usedCents, currency: used?.currency ?? x.currency ?? 'USD', sessionCents: 0, costCents, pool: [] }
      return { ...b, credits }
    }
    const added = Math.max(0, costCents - prev.costCents)
    let pool = [...prev.pool, ...(added > 0 ? [{ at: now, cents: added }] : [])].filter(p => now - p.at < POOL_MS)
    let sessionCents = prev.sessionCents
    const rise = prev.isEnabled && isEnabled ? usedCents - prev.usedCents : 0
    if (rise > 0) {
      // Claim from the oldest unmatched cost first.
      let left = rise
      const kept: typeof pool = []
      for (const p of pool) {
        const take = Math.min(left, p.cents)
        left -= take
        sessionCents += take
        if (p.cents - take > 0.001) kept.push({ at: p.at, cents: p.cents - take })
      }
      pool = kept
    }
    const credits: Credits = { isEnabled, usedCents, currency: used?.currency ?? x.currency ?? 'USD', sessionCents, costCents, pool }
    return { ...b, credits, creditsMovedAt: rise > 0 ? now : b.creditsMovedAt }
  })
}

const money = (cents: number, currency: string) => {
  const symbol = ({ USD: '$', EUR: '€', GBP: '£' } as Record<string, string>)[currency.toUpperCase()]
  const amount = (cents / 100).toFixed(2)
  return symbol ? `${symbol}${amount}` : `${amount} ${currency}`
}

const creditsSpent = (c: Credits) => Math.round(c.sessionCents)

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

// As Claude's own usage bars: green under 75%, orange from 75%, red from 90%.
type Tone = 'success' | 'warning' | 'error'
const toneOf = (used: number): Tone => (used >= 90 ? 'error' : used >= 75 ? 'warning' : 'success')
// Bar colors, and text colors readable on the tinted pills (the theme's yellow
// is too bright on them: a deep amber).
const COLOR: Record<Tone, string> = { success: '#3fa66b', warning: '#d9962b', error: '#d64545' }
const TEXT_COLOR: Record<Tone, string | undefined> = { success: undefined, warning: '#a8690a', error: '#d64545' }
const GREY = 'rgba(127,127,127,0.55)'
const TRACK = 'rgba(127,127,127,0.2)'

// minWidth in cells (about 32 px; a cell is about 10 px), height in CSS pixels. The markup is drawn
// wider than any band (`drawnWidth`) and the app caps an Svg with no width
// prop at its slot, so the bar takes exactly the room its box is given.
const GAUGE = { minWidth: 3, height: 9, drawnWidth: 4000 }
const HATCH = { back: 'rgba(127,127,127,0.16)', line: 'rgba(127,127,127,0.6)' }
// A rounded bar, solid up to the share used; the gap to the time elapsed is
// hatched: grey after the bar (margin left), in the bar's color when use runs
// ahead of time. After Token Weather Usage's gauge (Apache-2.0, see NOTICE).
// Drawn in percentages with no viewBox, so it fits whatever width it is
// capped to while the stripes keep their size.
function gaugeSvg(id: string, usedPercent: number, elapsed: number | undefined, tone: Tone) {
  const { height } = GAUGE
  const radius = height / 2
  const used = Math.max(0, Math.min(100, usedPercent))
  const time = elapsed === undefined ? used : Math.max(0, Math.min(100, elapsed))
  const pct = (n: number) => `${n.toFixed(1)}%`
  const color = COLOR[tone]
  const stripes = (name: string, back: string, backOpacity: number, line: string) =>
    `<pattern id="${name}" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<rect width="4" height="4" fill="${back}" fill-opacity="${backOpacity}"/><rect width="1.6" height="4" fill="${line}"/></pattern>`
  const defs =
    `<defs>${stripes(id + 'm', HATCH.back, 1, HATCH.line)}${stripes(id + 'a', color, 0.35, color)}` +
    `<clipPath id="${id}t"><rect width="100%" height="${height}" rx="${radius}"/></clipPath>` +
    `<clipPath id="${id}b"><rect width="${pct(used)}" height="${height}" rx="${radius}"/></clipPath></defs>`
  let body = `<rect width="100%" height="${height}" fill="${TRACK}"/>`
  if (time > used) body += `<rect width="${pct(time)}" height="${height}" fill="url(#${id}m)"/>`
  body += `<g clip-path="url(#${id}b)"><rect width="${pct(Math.min(used, time))}" height="${height}" fill="${color}"/>`
  if (used > time) body += `<rect x="${pct(time)}" width="${pct(used - time)}" height="${height}" fill="url(#${id}a)"/>`
  body += '</g>'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${GAUGE.drawnWidth}" height="${height}">${defs}<g clip-path="url(#${id}t)">${body}</g></svg>`
}

// "2h 24m", "2d 20h", "8m": time until a reset.
function left(resetsAt: string | undefined, now: number) {
  const at = resetsAt ? Date.parse(resetsAt) : NaN
  if (Number.isNaN(at) || now === 0) return ''
  const ms = Math.max(0, at - now)
  const d = Math.floor(ms / DAY)
  const h = Math.floor((ms % DAY) / HOUR)
  const m = Math.floor((ms % HOUR) / MINUTE)
  // Non-breaking spaces: a squeezed pill must not break "2h 14m" over two lines.
  if (d > 0) return `${d}d\u00a0${h}h`
  if (h > 0) return `${h}h\u00a0${m}m`
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
    lastLayout && `Band ${lastLayout}`,
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
    // A subagent finished its job: its spend reaches the account too.
    if (e.agentId) {
      void refreshAgents($)
      void refreshCreditsSoon($)
      return result
    }
    try {
      const usage = await $.session.usage()
      const context = toContext(usage.context)
      if (context) await update($, bar, b => ({ ...b, context, readings: pushReading(b.readings, context.tokens) }))
    } catch {
      // No reading this turn: the band keeps the previous one.
    }
    void refreshCreditsSoon($)
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

  on('command.run', { command: 'usage-bar' }, async ($, e) => {
    await refreshCredits($, 0)
    // `/usage-bar reset`: count credits from now on.
    if (e.args.trim() === 'reset') await update($, bar, b => (b.credits ? { ...b, credits: { ...b.credits, sessionCents: 0, pool: [] } } : b))
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
    const line = drawLine($, els, b, e.props.isWorking, e.props.bodyColumns)
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
// Pills, icons and tints adapted from Token Weather Usage by Eric Cologni
// (https://github.com/augiefra/claude-mods, Apache-2.0); see NOTICE.

// Desktop pills: a light tint and a slightly stronger outline per pill.
const TINTS: Record<string, [string, string]> = {
  context: ['rgba(47,104,192,0.10)', 'rgba(47,104,192,0.28)'],
  five_hour: ['rgba(63,166,107,0.13)', 'rgba(63,166,107,0.32)'],
  seven_day: ['rgba(140,100,210,0.13)', 'rgba(140,100,210,0.32)'],
  cache: ['rgba(27,161,196,0.11)', 'rgba(27,161,196,0.30)'],
  cacheSoon: ['rgba(217,150,43,0.14)', 'rgba(217,150,43,0.36)'],
  cacheGone: ['rgba(214,69,69,0.12)', 'rgba(214,69,69,0.36)'],
  credits: ['rgba(184,140,40,0.13)', 'rgba(184,140,40,0.34)'],
  agents: ['rgba(196,80,127,0.11)', 'rgba(196,80,127,0.32)'],
}

// Icon colors: deeper than the pill's tint, readable on light and dark backgrounds.
const ICON_COLOR = {
  context: '#2f68c0',
  five_hour: '#3a9a62',
  seven_day: '#8a5fd0',
  cache: '#1b9cbe',
  cacheSoon: '#d9962b',
  cacheGone: '#d64545',
  credits: '#b8892a',
  agents: '#c4507f',
}

const ICON_SIZE = 16
const SMALL_ICON = 14

// Small outlined icons, drawn on a 24-unit grid in the pill's color.
const ICONS = {
  gauge: (c: string) =>
    `<g transform="translate(0 0.5)"><path d="M3.6 18.5a9.5 9.5 0 1 1 16.8 0" fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round"/><path d="M12 14.5l4.3-4.6" fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="14.5" r="1.7" fill="${c}"/></g>`,
  calendar: (c: string) =>
    `<rect x="3" y="4.5" width="18" height="17" rx="3" fill="none" stroke="${c}" stroke-width="2"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round"/><text x="12" y="19.2" font-size="8.5" font-weight="700" font-family="-apple-system,Helvetica,Arial,sans-serif" text-anchor="middle" fill="${c}">7</text>`,
  // A clock turning back: the time left before the window starts over.
  clock: (c: string) =>
    `<path d="M4.2 13A8 8 0 1 0 6.6 6.2" fill="none" stroke="${c}" stroke-width="2.1" stroke-linecap="round"/><path d="M3.4 3.6v4.2h4.2" fill="none" stroke="${c}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 8v4.6l3 1.8" fill="none" stroke="${c}" stroke-width="2.1" stroke-linecap="round"/>`,
  bolt: (c: string) =>
    `<path d="M13.2 2 4 13.6h7.2L10.4 22l9.2-11.6h-7.2z" fill="${c}" fill-opacity="0.18" stroke="${c}" stroke-width="2" stroke-linejoin="round"/>`,
  coin: (c: string) =>
    `<circle cx="12" cy="12" r="9.5" fill="${c}" fill-opacity="0.16" stroke="${c}" stroke-width="2"/><path d="M15 8.8c-.5-1-1.6-1.6-3-1.6-1.7 0-3 .9-3 2.2s1.3 1.8 3 2.1 3 .9 3 2.2-1.3 2.3-3 2.3c-1.4 0-2.5-.6-3.1-1.6M12 5.6v1.6M12 16.8v1.6" fill="none" stroke="${c}" stroke-width="1.9" stroke-linecap="round"/>`,
  agents: (c: string) =>
    `<rect x="4" y="7.5" width="16" height="12.5" rx="3.5" fill="${c}" fill-opacity="0.14" stroke="${c}" stroke-width="2"/><path d="M12 7.5V4M2 12.5v3M22 12.5v3" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="3.2" r="1.3" fill="${c}"/><circle cx="9" cy="13" r="1.5" fill="${c}"/><circle cx="15" cy="13" r="1.5" fill="${c}"/><path d="M9.5 16.8h5" fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round"/>`,
}

function icon({ Svg }: Els, key: string, body: string, alt: string, size = ICON_SIZE) {
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">${body}</svg>`
  return <Svg key={key} source={source} alt={alt} width={size} height={size} />
}

// The context icon: ○ ◔ ◑ ◕ ● drawn as a pie, filled by quarters.
function fillIcon(percent: number, color: string) {
  const quarters = percent < 12.5 ? 0 : percent < 37.5 ? 1 : percent < 62.5 ? 2 : percent < 87.5 ? 3 : 4
  const ring = `<circle cx="12" cy="12" r="9" fill="none" stroke="${color}" stroke-width="2"/>`
  if (quarters === 0) return ring
  if (quarters === 4) return `${ring}<circle cx="12" cy="12" r="6.5" fill="${color}"/>`
  // A wedge from 12 o'clock, clockwise.
  const r = 6.5
  const angle = (quarters / 4) * 2 * Math.PI
  const x = 12 + r * Math.sin(angle)
  const y = 12 - r * Math.cos(angle)
  const wedge = `<path d="M12 12V${12 - r}A${r} ${r} 0 ${quarters > 2 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}z" fill="${color}"/>`
  return `${ring}${wedge}`
}

const divider = ({ Text }: Els, key: string) => (
  <Text key={key} dimColor>
    │
  </Text>
)

// A card under the pointer: hidden until the pill is hovered, drawn above the
// band in the theme's own colors. An indented line is a detail: dim.
// No key: a keyed Box would scope its own hover, and a hidden one is never hovered.
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

// A tinted, outlined pill that never shrinks (squeezed, the app breaks "24 %"
// over two lines). The app rounds a Box only through its border, whose padding
// would make the band taller than the prompt box: paddingY takes it back.
// A keyed pill is a hover scope: its card shows while the pointer is over it.
// The limit pills grow (`grow`) to share the row's spare width, their bars
// stretching with them, so the band spans the full width whichever pills show.
// No pill shrinks: a row too narrow wraps (see drawLine) rather than squeeze.
function pill({ Box }: Els, key: string, tint: [string, string], parts: unknown[], card: unknown, grow = false) {
  return (
    <Box
      key={key}
      flexDirection="row"
      alignItems="center"
      columnGap={0.5}
      flexGrow={grow ? 1 : 0}
      flexShrink={0}
      paddingX={1}
      paddingY={0}
      borderStyle="round"
      borderColor={tint[1]}
      backgroundColor={tint[0]}
    >
      {parts.filter(Boolean) as never}
      {card as never}
    </Box>
  )
}

// Whether one row fits: the band's width comes in cells of the app's code
// font (about 10 px each); what the pills need is estimated in CSS pixels,
// from sizes measured in the app. Kept for /usage-bar, to tune.
let lastLayout = ''

const PX = {
  cell: 10,
  char: 7.5, // the app's proportional text, on average (digits run wider)
  icon: ICON_SIZE,
  smallIcon: SMALL_ICON,
  gap: 5, // columnGap 0.5 inside a pill
  pill: 22, // border and padding, both sides
  between: 10, // columnGap 1 between pills
  band: 20, // the band's own padding
  button: 12, // the native button's chrome around its label
  sparkBar: SPARK.bar + SPARK.gap,
}
// Spare room kept on a one-row band (split view showed the estimate runs short).
const MARGIN_CELLS = 6
// Once on two rows, one row comes back only with this much more room: no bouncing.
const HYSTERESIS_CELLS = 4
let wasTwoRows = false
const textPx = (text: string) => text.length * PX.char
const pillPx = (parts: number[]) => PX.pill + parts.reduce((a, n) => a + n, 0) + (parts.length - 1) * PX.gap

// Each changing value counts at its widest form, so a ticking countdown or a
// growing token count never moves the threshold.
const widest = (text: string, template: string) => textPx(text.length > template.length ? text : template)

function oneRowCells(b: Bar, isWorking: boolean) {
  const widths: number[] = []
  if (b.context) {
    widths.push(pillPx([PX.icon, widest(short(b.context.tokens), '999.9k'), (HISTORY - 1) * PX.sparkBar, widest(trend(b.readings), '▲ +99.9k')]))
  }
  for (const l of [b.session, b.weekly]) {
    if (!l) continue
    widths.push(pillPx([PX.icon, textPx('5h'), GAUGE.minWidth * PX.cell, textPx('100%'), PX.smallIcon, textPx('22h\u00a059m')]))
  }
  if (b.cache) {
    const v = cacheView(b, b.cache, isWorking)
    // The widest it gets: the reminder, with both buttons.
    widths.push(pillPx([PX.icon, widest(v.status, '60m'), textPx('↻\u00a0Keep\u00a0alive') + PX.button, textPx('Let it expire')]))
  }
  if (b.credits) widths.push(pillPx([PX.icon, widest(creditsText(b.credits), '€000.00')]))
  if (b.agentIds.length > 0) widths.push(pillPx([PX.icon, widest(agentsText(b), '9 running · 99')]))
  const px = widths.reduce((a, n) => a + n, 0) + (widths.length - 1) * PX.between + PX.band
  return Math.ceil(px / PX.cell) + MARGIN_CELLS
}

function drawLine($: $, els: Els, b: Bar, isWorking: boolean, columns: number) {
  const { Box } = els
  const usage = [
    b.context && contextPill(els, b),
    b.session && limitPill(els, 'five_hour', '5h', b.session, b.now),
    b.weekly && limitPill(els, 'seven_day', '7d', b.weekly, b.now),
  ].filter(Boolean)
  const cache = b.cache && cachePill($, els, b, b.cache, isWorking)
  const credits = b.credits && creditsPill(els, b.credits)
  const agents = b.agentIds.length > 0 && agentsPill(els, b)
  const needs = oneRowCells(b, isWorking)
  const isOneRow = columns >= needs + (wasTwoRows ? HYSTERESIS_CELLS : 0)
  wasTwoRows = !isOneRow
  lastLayout = `${columns} columns, one row needs ~${needs}: ${isOneRow ? 'one row' : 'two rows'}`
  // One row: the limit pills take the spare width, or give it back, their bars
  // stretching or shrinking down to a minimum.
  if (isOneRow)
    return (
      // Wrap only as a fallback, when the estimate let through a row that
      // does not fit: pills move down rather than spill.
      <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1} rowGap={1} paddingX={1}>
        {[...usage, cache, credits, agents].filter(Boolean) as never}
      </Box>
    )
  // Too narrow (the narrow chat column): usage on the first row; cache,
  // agents and credits on the second, right-aligned at their own size.
  const second = [cache, agents, credits].filter(Boolean)
  return (
    <Box flexDirection="column" rowGap={1} paddingX={1}>
      <Box key="usage-row" flexDirection="row" flexWrap="nowrap" alignItems="center" columnGap={1}>
        {usage as never}
      </Box>
      {second.length > 0 && (
        <Box key="extras-row" flexDirection="row" flexWrap="nowrap" alignItems="center" justifyContent="flex-end" columnGap={1}>
          {second as never}
        </Box>
      )}
    </Box>
  )
}

function contextPill(els: Els, b: Bar) {
  const { Text, Svg } = els
  const c = b.context!
  const tone = contextTone(c.percent)
  const color = tone === 'success' ? ICON_COLOR.context : COLOR[tone]
  const spark = sparkSvg(b.readings, color)
  const t = trend(b.readings)
  const parts = [
    icon(els, 'icon', fillIcon(c.percent, color), `Context ${c.percent}% full`),
    <Text key="tokens" bold>
      {short(c.tokens)}
    </Text>,
    spark && <Svg key="spark" source={spark.source} alt="Tokens added by recent prompts" width={spark.width} height={SPARK.height} />,
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
  return pill(els, 'context', TINTS.context!, parts, card)
}

function limitPill(els: Els, kind: 'five_hour' | 'seven_day', label: string, l: Limit, now: number) {
  const { Box, Text, Svg } = els
  const elapsed = elapsedPercent(l, SPANS[kind] ?? DAY, now)
  const tone = toneOf(l.percent)
  const rest = left(l.resetsAt, now)
  const color = ICON_COLOR[kind]
  const parts = [
    icon(els, 'icon', kind === 'five_hour' ? ICONS.gauge(color) : ICONS.calendar(color), kind === 'five_hour' ? 'Session limit' : 'Weekly limit'),
    <Text key="label">{label}</Text>,
    // The bar starts at its minimum and grows into the pill's share of the
    // spare width; nothing in a pill shrinks, so no pill gets narrower than
    // its content and its reset time never spills out. No key: a keyed Box is
    // a hover scope, and the pill's own must hold.
    <Box width={GAUGE.minWidth} flexGrow={1} flexShrink={0}>
      <Svg source={gaugeSvg(kind, l.percent, elapsed, tone)} alt={`${label} ${l.percent}% used`} height={GAUGE.height} />
    </Box>,
    <Text key="value" bold color={TEXT_COLOR[tone]}>
      {Math.round(l.percent)}%
    </Text>,
    rest && icon(els, 'clock', ICONS.clock(color), 'Resets in', SMALL_ICON),
    rest && (
      <Text key="left" dimColor>
        {rest}
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
  return pill(els, kind, TINTS[kind]!, parts, card, true)
}

// What the cache pill shows; shared with the width estimate.
function cacheView(b: Bar, c: Cache, isWorking: boolean) {
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
            ? `${minutes}m`
            : '<\u00a01m'
  const buttonLabel = isAsking ? '↻\u00a0Keep\u00a0alive' : '↻\u00a0Extend'
  return { isExpired, isAsking, canExtend, status, buttonLabel }
}

function cachePill($: $, els: Els, b: Bar, c: Cache, isWorking: boolean) {
  const { Text, Button } = els
  const ttl = ttlMs(b)
  const { isExpired, isAsking, canExtend, status, buttonLabel } = cacheView(b, c, isWorking)
  const look = isExpired ? 'cacheGone' : isAsking ? 'cacheSoon' : 'cache'
  const tone: Tone = isExpired ? 'error' : isAsking ? 'warning' : 'success'
  const parts = [
    icon(els, 'icon', ICONS.bolt(ICON_COLOR[look]), 'Prompt cache'),
    <Text key="status" bold={!c.isCompacted} dimColor={c.isCompacted} color={TEXT_COLOR[tone]}>
      {status}
    </Text>,
    c.keepAlive === 'failed' && divider(els, 'sep'),
    c.keepAlive === 'failed' && (
      <Text key="failed" dimColor>
        extend failed
      </Text>
    ),
    canExtend && (
      // The app's own button, not plain text: it reads as something to press.
      <Button
        key="extend"
        label={buttonLabel}
        variant={isAsking ? 'primary' : 'secondary'}
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
  return pill(els, 'cache', TINTS[look]!, parts, card)
}

// What the credits pill reads: the spend since the session started, or
// "disabled" while extra usage is off on the account.
const creditsText = (c: Credits) => (c.isEnabled ? money(creditsSpent(c), c.currency) : 'disabled')

function creditsPill(els: Els, c: Credits) {
  const { Text, Link } = els
  const parts = [
    icon(els, 'icon', ICONS.coin(ICON_COLOR.credits), 'Usage credits'),
    <Text key="value" bold={c.isEnabled} dimColor={!c.isEnabled}>
      {creditsText(c)}
    </Text>,
  ]
  const lines = c.isEnabled
    ? [
        'Usage credits this session spent',
        "  Your account's credit spend, matched to this session's own cost",
        '  Read from your account 5 seconds after each reply',
      ]
    : ['Usage credits are turned off for your account', '  Turn them on in your usage settings']
  const card = hoverCard(els, lines, <Link key="balance" href={BALANCE_URL} label="Balance" />)
  return pill(els, 'credits', TINTS.credits!, parts, card)
}

function agentsText(b: Bar) {
  const total = b.agentIds.length
  const running = b.running.length
  return running > 0 ? `${running} running · ${total}` : total === 1 ? '1 agent' : `${total} agents`
}

function agentsPill(els: Els, b: Bar) {
  const { Text } = els
  const total = b.agentIds.length
  const text = agentsText(b)
  const parts = [
    icon(els, 'icon', ICONS.agents(ICON_COLOR.agents), 'Subagents'),
    <Text key="value" bold>
      {text}
    </Text>,
  ]
  const card = hoverCard(els, [
    `${total} subagent${total === 1 ? '' : 's'} this session`,
    ...b.running.map(a => `  ${a.type}${a.description ? ` · ${a.description}` : ''}`),
  ])
  return pill(els, 'agents', TINTS.agents!, parts, card)
}
