import { expect, mock, test } from 'claude-code/testing'

// October 20, 2026, 12:00 UTC.
const NOW = Date.UTC(2026, 9, 20, 12, 0)
const MINUTE = 60_000

const LIMITS = [
  // 5 hours: 32% used, 2 of 5 hours elapsed (40%): behind time.
  { kind: 'five_hour', percentUsed: 32, resetsAt: new Date(NOW + 3 * 3_600_000).toISOString() },
  // 7 days: 59% used, 4 of 7 days elapsed (57%): slightly ahead.
  { kind: 'seven_day', percentUsed: 59, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() },
]

const HIT = { model: 'claude-opus-5-5', input_tokens: 300, cache_read_input_tokens: 98_000, cache_creation_input_tokens: 1_700, output_tokens: 500 }

const api = (usedCredits: number, isEnabled = true) =>
  JSON.stringify({
    five_hour: { utilization: 32 },
    extra_usage: { is_enabled: isEnabled, monthly_limit: 5000, used_credits: usedCredits, currency: 'USD' },
  })

type World = { used: number; isEnabled: boolean; forks: number; agents: { id: string; status: string; type: string; description: string }[] }

function world(on: any, rateLimits: unknown[] = LIMITS, env: Record<string, string> = {}, usage: Record<string, unknown> = HIT) {
  const w: World = { used: 1234, isEnabled: true, forks: 0, agents: [] }
  const clock = mock.clock(on, { now: NOW }) as any
  mock.store(on)
  mock.env(on, env)
  on('ui.log', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd ?? '/tmp' }))
  on('session.measure', (_$: any, e: any) => ({ changed: e.changed }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { tokens: 412_000, window: 1_000_000, percent: 41 }, rateLimits } }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: api(w.used, w.isEnabled) } }))
  on('agent.list', () => ({ value: w.agents }))
  on('model.fork', () => {
    w.forks += 1
    return { value: { isAnswered: true, text: 'OK', usage: HIT } }
  })
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage }
  })
  // The engine's own band: nothing to draw.
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Box({ children: [] }))
  return { w, clock }
}

async function start($: any) {
  await $.session.start({ source: 'startup', cwd: '/tmp' })
}

// One main-thread request answered with HIT.
async function step($: any) {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 2 })
  for await (const _ of stream) {
  }
}

async function band($: any, surface: 'desktop' | 'terminal' = 'desktop', isWorking = false) {
  return $.ui.mount({
    plugin: 'usage-bar',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking, maxRows: 10, bodyColumns: 200, scroll: { offset: 0, bodyRows: 9 }, view: {} },
  })
}

// Every string beneath a drawn element description, in order.
function strings(node: any): string[] {
  if (node == null || node === false) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(strings)
  return strings(node.children ?? node.props?.children)
}

async function texts(ui: any) {
  return ((await ui.findAll({ type: 'Text' })) as any[]).map(t => t.text as string)
}

async function cardOf(ui: any, key: string) {
  const pill: any = await ui.find({ type: 'Box', key })
  const card = ((pill?.children ?? []) as any[]).find(c => c && typeof c === 'object' && c.props?.position === 'absolute')
  return card ? strings(card).join('\n') : null
}

test('context pill: fill glyph, tokens, chart and the last change', async ($, on) => {
  world(on)
  await start($)
  const ui = await band($)
  const all = await texts(ui)
  expect(all).toContain('◑')
  expect(all).toContain('412k')
  expect(await cardOf(ui, 'context')).toContain('Context 41% of 1M')
})

test('limit pills: share used, time left, reset in the card', async ($, on) => {
  world(on)
  await start($)
  const ui = await band($)
  const all = await texts(ui)
  expect(all).toContain('32%')
  expect(all).toContain('· 3h 0m')
  expect(all).toContain('59%')
  expect(all).toContain('· 3d 0h')
  const svgs = (await ui.findAll({ type: 'Svg' })) as any[]
  expect(svgs.filter(s => String(s.props?.alt).includes('used')).length).toBe(2)
  expect(await cardOf(ui, 'five_hour')).toContain('Session limit (5 hours): 32% used')
  expect(await cardOf(ui, 'seven_day')).toContain('Weekly limit (7 days): 59% used')
})

test('credits: spent since the session started, with the Balance link', async ($, on) => {
  const { w } = world(on)
  await start($)
  await $.command.run({ command: 'usage-bar', args: '', origin: { kind: 'person' }, presentation: { isFullscreen: false, columns: 120 } } as never)
  w.used = 1276
  const ran = await $.command.run({ command: 'usage-bar', args: '', origin: { kind: 'person' }, presentation: { isFullscreen: false, columns: 120 } } as never)
  expect(ran.text).toContain('Credits $0.42 this session')
  const ui = await band($)
  expect(await texts(ui)).toContain('$0.42')
  expect((await ui.find({ type: 'Link' }))?.props.href).toBe('https://claude.ai/settings/usage')
})

test('credits: hidden when extra usage is off', async ($, on) => {
  const { w } = world(on)
  w.isEnabled = false
  await start($)
  const ui = await band($)
  expect(await ui.find({ type: 'Box', key: 'credits' })).toBeUndefined()
})

test('cache: counts down an hour on a plan, Extend restarts it', async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await step($)
  let ui = await band($)
  expect(await texts(ui)).toContain('60 min')
  expect(await ui.find({ type: 'Button', key: 'extend' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'let-expire' })).toBeUndefined()

  // 56 minutes on: the reminder, Keep alive and Let it expire.
  await clock.advance(56 * MINUTE)
  ui = await band($)
  expect(await texts(ui)).toContain('4 min')
  expect((await ui.find({ type: 'Button', key: 'extend' }))?.props.label).toBe('Keep alive')
  expect(await ui.find({ type: 'Button', key: 'let-expire' })).toBeDefined()

  await ui.press({ key: 'extend' })
  expect(w.forks).toBe(1)
  ui = await band($)
  expect(await texts(ui)).toContain('60 min')
})

test('cache: Let it expire hides the question', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await step($)
  await clock.advance(56 * MINUTE)
  let ui = await band($)
  await ui.press({ key: 'let-expire' })
  ui = await band($)
  expect(await ui.find({ type: 'Button', key: 'let-expire' })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'extend' }))?.props.label).toBe('Extend')
})

test('cache: 5 minutes once past a limit, then expired with no button', async ($, on) => {
  const { clock } = world(on, [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(NOW + 3_600_000).toISOString() }])
  await start($)
  await step($)
  let ui = await band($)
  expect(await texts(ui)).toContain('5 min')
  await clock.advance(6 * MINUTE)
  ui = await band($)
  expect(await texts(ui)).toContain('expired')
  expect(await ui.find({ type: 'Button', key: 'extend' })).toBeUndefined()
})

test('cache: an environment override wins over the plan default', async ($, on) => {
  world(on, LIMITS, { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' })
  await start($)
  await step($)
  const ui = await band($)
  expect(await texts(ui)).toContain('5 min')
  expect(await cardOf(ui, 'cache')).toContain('Lifetime 5 minutes (set by environment)')
})

test('cache: a 5-minute write within plan limits (credits-only model) means 5 minutes', async ($, on) => {
  world(on, LIMITS, {}, { ...HIT, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 1_700 } })
  await start($)
  await step($)
  const ui = await band($)
  expect(await texts(ui)).toContain('5 min')
  expect(await cardOf(ui, 'cache')).toContain('Lifetime 5 minutes (from the last cache write)')
})

test('cache: no Extend while a turn runs', async ($, on) => {
  world(on)
  await start($)
  await step($)
  const ui = await band($, 'desktop', true)
  expect(await texts(ui)).toContain('in use')
  expect(await ui.find({ type: 'Button', key: 'extend' })).toBeUndefined()
})

test('agents: running and total, the running ones in the card', async ($, on) => {
  const { w } = world(on)
  w.agents = [
    { id: 'a1', status: 'running', type: 'Explore', description: 'Find the config' },
    { id: 'a2', status: 'completed', type: 'general-purpose', description: 'Write tests' },
  ]
  await start($)
  await step($)
  const ui = await band($)
  expect(await texts(ui)).toContain('1 running · 2')
  expect(await cardOf(ui, 'agents')).toContain('Explore · Find the config')
})

test('terminal: the engine draws its own band', async ($, on) => {
  world(on)
  await start($)
  const ui = await band($, 'terminal')
  expect(await ui.find({ type: 'Box', key: 'context' })).toBeUndefined()
})
