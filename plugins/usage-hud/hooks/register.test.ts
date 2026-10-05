import { expect, test } from 'claude-code/testing'
import { block, bubble, coin, ember, forecast, localTime, meter, moon, paceCells, perRow, pie, season, segments, usedTone, zoneLabel } from './register'

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
  expect([10, 50, 90].map(bubble).join('')).toBe('🫧🎈💥')
  expect(ember(true, 30 * 60_000) + ember(true, 60_000) + ember(false, 0)).toBe('🔥⏳🧊')
  expect(coin(true) + coin(false)).toBe('💸🪙')
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
