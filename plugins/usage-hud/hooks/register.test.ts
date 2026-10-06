import { expect, mock, test } from 'claude-code/testing'
import { bandLine, block, bubble, cells, money, num, tok, coin, ember, forecast, localTime, meter, moon, paceCells, perRow, pie, season, segments, usedTone, zoneLabel } from './register'
import type { Snap } from '../types'

test('meter fills to the fraction and always spans the width', () => {
  for (const [frac, w] of [[0, 10], [0.47, 34], [0.5, 9], [1, 8], [1.4, 8], [-1, 8]] as const) {
    const m = meter(frac, w)
    expect([...m.fill].length + [...m.track].length).toBe(w)
  }
  expect(meter(0.5, 10).fill).toBe('━━━━━')
  expect(meter(0.25, 10).fill).toBe('━━╸')
})

test('usage tone is a theme key, not a raw color', () => {
  expect(usedTone(10)).toBe('success')
  expect(usedTone(70)).toBe('warning')
  expect(usedTone(95)).toBe('error')
})

test('cards: four across when wide, two by two when not, stacked when narrow', () => {
  expect(perRow(200)).toBe(4)
  expect(perRow(120)).toBe(2)
  expect(perRow(60)).toBe(1)
})

test('card meters are solid blocks that span the width', () => {
  const m = block(0.1, 40)
  expect([...m.fill].length + [...m.track].length).toBe(40)
  expect(m.fill).toBe('▄▄▄▄')
})

test('reset times read in the local zone', () => {
  const at = Date.parse('2026-10-05T08:50:00Z')
  const d = new Date(at)
  const t = localTime(at)
  expect(t.time).toBe(`${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`)
  expect(t.date.endsWith(' Oct')).toBe(true)
  expect(zoneLabel(-330)).toBe('GMT+5:30')
  expect(zoneLabel(0)).toBe('GMT')
  expect(zoneLabel(300)).toBe('GMT-5')
  expect(zoneLabel(-60)).toBe('GMT+1')
})

test('context segments cover the width: categories, free, then the autocompact reserve', () => {
  const parts = [
    { name: 'Messages', tokens: 80_000, color: 'permission' },
    { name: 'System tools', tokens: 15_000, color: 'inactive' },
    { name: 'Memory files', tokens: 300, color: 'claude' },
  ]
  const segs = segments(parts, 0.4, 0.15, 50)
  expect(segs.reduce((n, g) => n + g.w, 0)).toBe(50)
  expect(segs.map(g => g.color)).toEqual(['permission', 'inactive', 'claude', 'subtle', 'inactive'])
  expect(segs[2]!.w).toBe(1)
  expect(segments([], 0, 0, 20)).toEqual([{ w: 20, color: 'subtle' }])
})

test('pace bar: needle at the clock, fill past it is ahead, gaps flow only while spending', () => {
  const g = { fill: '━', gap: '─', track: '━', needle: '┃' }
  const still = paceCells(0.6, 0.4, 10, g, 0, false)
  expect(still.map(c => c.role).join(',')).toBe('fill,fill,fill,fill,needle,ahead,track,track,track,track')
  expect(still.some(c => c.ch === '─')).toBe(false)
  const moving = paceCells(0.6, 0.4, 10, g, 1, true)
  expect(moving.filter(c => c.ch === '─').length).toBeGreaterThan(0)
  // the gap moves one cell right per frame
  const at = (p: number) => paceCells(1, null, 12, g, p, true).findIndex(c => c.ch === '─')
  expect(at(1)).toBe(at(0) + 1)
  expect(paceCells(0.2, null, 5, g, 0, false).some(c => c.role === 'needle')).toBe(false)
})

test('icons follow their values', () => {
  expect([0, 30, 50, 80, 100].map(moon).join('')).toBe('🌕🌖🌗🌘🌑')
  expect([10, 40, 60, 80, 99].map(season).join('')).toBe('🌱🌿🌳🍂🥀')
  expect([10, 50, 90].map(bubble).join('')).toBe('💧🎈💥')
  expect(ember(true, 30 * 60_000) + ember(true, 60_000) + ember(false, 0)).toBe('🔥⏳🧊')
  expect(coin(true) + coin(false)).toBe('💸💰')
  expect([0, 0.2, 0.5, 0.8, 1].map(pie).join('')).toBe('○◔◑◕●')
})

test('forecast: the window average says where the pace lands, and when it runs out', () => {
  const H = 3_600_000
  const reset = 10 * H
  // half the window gone, 40% used: on pace for 80%
  expect(Math.round(forecast(40, reset, 5 * H, reset - 2.5 * H, [])!.projected)).toBe(80)
  expect(forecast(40, reset, 5 * H, reset - 2.5 * H, [])!.outAt).toBe(null)
  // one hour in, 50% used: out after one more hour
  expect(forecast(50, reset, 5 * H, reset - 4 * H, [])!.outAt).toBe(reset - 3 * H)
  expect(forecast(50, 0, 5 * H, reset, [])).toBe(null)
})

const snap = (over: Partial<Snap> = {}): Snap => ({
  limits: [],
  ctx: null,
  usd: 0,
  model: '',
  ttl: 3_600_000,
  lastAt: 0,
  turns: [],
  now: Date.parse('2026-10-06T17:00:00Z'),
  open: false,
  parts: [],
  buffer: 0,
  samples: {},
  phase: 0,
  startedAt: 0,
  calm: false,
  working: false,
  ...over,
})
const width = (line: { text: string }[]) => line.reduce((n, sp) => n + cells(sp.text), 0)

test('counts and dollars stay short however large they get', () => {
  expect([0, 950, 999.7, 9_949, 9_960, 123_456, 999_600, 1_234_567, 45_000_000].map(tok)).toEqual(['0', '950', '1.0k', '9.9k', '10k', '123k', '1.0M', '1.2M', '45M'])
  expect([0, 4.5, 99.99, 123.4, 1234.5, 98_765].map(money)).toEqual(['$0.00', '$4.50', '$99.99', '$123', '$1.2k', '$99k'])
  expect(tok(NaN) + money(undefined as any) + num(null) + num('3')).toBe('0$0.0000')
})

test('emoji count two cells, so the row is measured as the terminal draws it', () => {
  expect(cells('🌗 5h')).toBe(5)
  expect(cells('⏳')).toBe(2)
})

test('collapsed line drops detail to fit, and never runs past the width', () => {
  const s = snap({
    limits: [
      { kind: 'five_hour', pct: 13, resetsAt: '2026-10-06T20:10:00Z' },
      { kind: 'seven_day', pct: 69, resetsAt: '2026-10-11T13:00:00Z' },
    ],
    ctx: { tokens: 123_456, window: 200_000, pct: 62 },
    lastAt: Date.parse('2026-10-06T16:55:00Z'),
    usd: 12_345.6,
  })
  for (const w of [200, 140, 100, 80, 60, 45]) expect(width(bandLine(s, w))).toBeLessThanOrEqual(w)
  const wide = bandLine(s, 300).map(sp => sp.text).join('')
  expect(wide).toContain('cache ')
  expect(wide).toContain('$12k')
  expect(bandLine(s, 60).map(sp => sp.text).join('')).not.toContain('cache')
})

test('API key and gateway accounts: no plan windows, a spend limit shows as one', () => {
  const api = bandLine(snap({ ctx: { tokens: 5_000, window: 200_000, pct: 3 }, ttl: 300_000 }), 120).map(sp => sp.text).join('')
  expect(api).toContain('ctx 5.0k/200k')
  expect(api).not.toContain('5h')
  const gw = bandLine(snap({ limits: [{ kind: 'spend_limit', pct: 104 }] }), 120).map(sp => sp.text).join('')
  expect(gw).toContain('spend')
  expect(gw).toContain('104%')
})

test('details opens the cards and hide closes them', async ($, on) => {
  const now = Date.parse('2026-10-06T17:00:00Z')
  mock.clock(on, { now })
  on('session.usage', async () => ({ value: {
    startedAt: now - 3_600_000,
    context: { tokens: 50_000, window: 200_000, percent: 25 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 13, resetsAt: '2026-10-06T20:10:00Z' }],
    cost: { usd: 1.5 },
  } }) as any)
  on('command.register', async () => ({ value: undefined }) as any)
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as any)
  on('ui.status', async () => ({ value: undefined }) as any)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-hud', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120 } as any })
    expect(await ui.find({ key: 'open' })).toBeDefined()
    await ui.press({ key: 'open' })
    expect(await ui.find({ key: 'close' })).toBeDefined()
    await ui.press({ key: 'close' })
    expect(await ui.find({ key: 'open' })).toBeDefined()
    await ui.unmount()
  }
  // On the terminal's main screen no click arrives: the button names the command instead.
  const main = await $.ui.mount({ plugin: 'usage-hud', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120 } as any, viewport: { columns: 125, rows: 40, isFullscreen: false } } as any)
  expect((await main.find({ key: 'open' }))?.text).toContain('/hud')
  await main.unmount()
})
