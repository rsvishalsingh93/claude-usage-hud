import type { EngineInterface, Register } from 'claude-code'

import type { Limit, Part, Sample, Snap, Turn } from '../types'

const TTL_API_MS = 5 * 60 * 1000
const TTL_SUB_MS = 60 * 60 * 1000
const TICK_MS = 1000
const ANIM_MS = 300
const REFRESH_MS = 10_000
const WINDOW_MS: Record<string, number> = { five_hour: 5 * 3600_000, seven_day: 7 * 86400_000 }
const CARD_MIN = 34
const empty: Snap = { limits: [], ctx: null, usd: 0, model: '', ttl: TTL_SUB_MS, lastAt: 0, turns: [], now: 0, open: false, parts: [], buffer: 0, samples: {}, phase: 0, startedAt: 0, calm: false, working: false }

let isOpen = false
let isLooping = false

// Every color is a theme key, so the HUD follows the light, dark, daltonized and ANSI themes alike.
const C = {
  text: 'text',
  muted: 'inactive',
  track: 'subtle',
  ok: 'success',
  warn: 'warning',
  bad: 'error',
  blue: 'permission',
  accent: 'claude',
} as const

// A reading the host left out, or one a gateway or cloud provider sent as null or text, counts as nothing.
export const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
// Short counts: 950, 9.5k, 95k, 1.2M. The cut-offs sit where rounding would carry into the next unit.
export const tok = (n: number) => {
  const v = Math.max(0, num(n))
  return v < 999.5 ? `${Math.round(v)}` : v < 9950 ? `${(v / 1e3).toFixed(1)}k` : v < 999_500 ? `${Math.round(v / 1e3)}k` : v < 9.95e6 ? `${(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1e6)}M`
}
// Dollars: cents while small, whole dollars past $100, then k, so a long API session never runs to five digits.
export const money = (usd: number) => {
  const v = Math.max(0, num(usd))
  return v < 99.995 ? `$${v.toFixed(2)}` : v < 999.5 ? `$${Math.round(v)}` : v < 9950 ? `$${(v / 1e3).toFixed(1)}k` : v < 999_500 ? `$${Math.round(v / 1e3)}k` : `$${(v / 1e6).toFixed(1)}M`
}
// Cells a string takes in the terminal: an emoji two, a variation selector or joiner none, the rest one.
export const cells = (str: string) =>
  [...str].reduce((n, ch) => {
    const cp = ch.codePointAt(0)!
    return n + (cp === 0xfe0f || cp === 0x200d ? 0 : cp >= 0x1f000 || cp === 0x23f3 ? 2 : 1)
  }, 0)
const clip = (str: string, w: number) => ([...str].length <= w ? str : `${[...str].slice(0, Math.max(0, w - 1)).join('')}…`)
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`
const span = (ms: number) => {
  if (ms <= 0) return 'now'
  const m = Math.floor(ms / 60000)
  const d = Math.floor(m / 1440)
  const hrs = Math.floor((m % 1440) / 60)
  return d > 0 ? `${d}d ${hrs}h` : hrs > 0 ? `${hrs}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`
}
// Reset times in the computer's own time zone: the module's Date follows the host's, daylight saving included.
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function localTime(at: number) {
  const d = new Date(at)
  const hour = d.getHours()
  const time = `${hour % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`
  const day = DAYS[d.getDay()]!
  return { time, day, date: `${day} ${d.getDate()} ${MONTHS[d.getMonth()]}` }
}
// The zone as an offset from GMT (getTimezoneOffset counts minutes the other way round): -330 is GMT+5:30.
export function zoneLabel(offsetMin: number) {
  if (offsetMin === 0) return 'GMT'
  const m = Math.abs(offsetMin)
  return `GMT${offsetMin < 0 ? '+' : '-'}${Math.floor(m / 60)}${m % 60 ? `:${String(m % 60).padStart(2, '0')}` : ''}`
}

// Usage: the more used, the worse. Hit rate: the reverse.
export const usedTone = (pct: number) => (pct >= 85 ? C.bad : pct >= 60 ? C.warn : C.ok)
const hitTone = (pct: number) => (pct >= 80 ? C.ok : pct >= 40 ? C.warn : C.bad)

// A one-row meter: the filled run and the track, in whole and half cells of a heavy line.
export function meter(frac: number, width: number) {
  const halves = Math.round(Math.max(0, Math.min(1, frac)) * width * 2)
  const full = Math.floor(halves / 2)
  const half = halves % 2 === 1
  return { fill: '━'.repeat(full) + (half ? '╸' : ''), track: '━'.repeat(Math.max(0, width - full - (half ? 1 : 0))) }
}

// The cards' meter: a solid half-height block, so it reads as a gauge and not as a divider line.
export function block(frac: number, width: number) {
  const full = Math.round(Math.max(0, Math.min(1, frac)) * width)
  return { fill: '▄'.repeat(full), track: '▄'.repeat(width - full) }
}

// The context bar's cells: the used run split among the categories by their share, then free space,
// then the autocompact reserve at the right end. Every cell is accounted for, and a category with tokens keeps one.
export function segments(parts: Part[], usedFrac: number, bufferFrac: number, width: number) {
  const used = Math.round(Math.max(0, Math.min(1, usedFrac)) * width)
  const reserve = Math.min(width - used, Math.round(Math.max(0, bufferFrac) * width))
  const total = parts.reduce((n, p) => n + p.tokens, 0)
  // parts come largest first: the largest absorbs the rounding, so the smallest still shows.
  const ws =
    used < parts.length ? parts.map((_, i) => (i < used ? 1 : 0)) : parts.map(p => Math.max(1, Math.round((p.tokens / Math.max(1, total)) * used)))
  if (ws.length && used >= parts.length) ws[0] = Math.max(1, ws[0]! + used - ws.reduce((n, w) => n + w, 0))
  const out = parts.map((p, i) => ({ w: ws[i]!, color: p.color }))
  const left = used - ws.reduce((n, w) => n + w, 0)
  if (left > 0) out.push({ w: left, color: C.blue })
  out.push({ w: width - used - reserve, color: C.track })
  if (reserve > 0) out.push({ w: reserve, color: C.muted })
  return out.filter(o => o.w > 0)
}

// The forecast: where a limit lands at its reset if the pace holds. The pace is the last half hour's when there is
// at least ten minutes of it, else the window's average so far (usage over the time since the window opened).
export function forecast(pct: number, resetAt: number, windowMs: number, now: number, samples: Sample[]) {
  const left = resetAt - now
  if (!resetAt || left <= 0) return null
  let rate: number | null = null
  const first = samples[0]
  const last = samples[samples.length - 1]
  if (first && last && last.t - first.t >= 10 * 60_000) rate = Math.max(0, (last.pct - first.pct) / (last.t - first.t))
  else {
    const elapsed = now - (resetAt - windowMs)
    if (elapsed >= 5 * 60_000) rate = pct / elapsed
  }
  if (rate === null) return null
  const projected = pct + rate * left
  const outAt = rate > 0 && projected > 100 ? now + (100 - pct) / rate : null
  return { projected, outAt }
}

// The pace bar: the fill is how much of a limit is used, the needle how far through its window the clock is.
// Fill past the needle is usage running ahead of the clock. While Claude is spending tokens, gaps flow along
// the fill toward its head; when nothing is being spent the bar stands still.
export type Cell = { ch: string; role: 'fill' | 'ahead' | 'track' | 'needle' }
export function paceCells(
  usedFrac: number,
  timeFrac: number | null,
  width: number,
  g: { fill: string; gap: string; track: string; needle: string },
  phase: number,
  flowing: boolean,
) {
  const clamp = (v: number) => Math.max(0, Math.min(1, v))
  const used = Math.round(clamp(usedFrac) * width)
  const needle = timeFrac === null ? -1 : Math.min(width - 1, Math.floor(clamp(timeFrac) * width))
  const cells: Cell[] = []
  for (let i = 0; i < width; i++) {
    if (i === needle) cells.push({ ch: g.needle, role: 'needle' })
    else if (i < used) cells.push({ ch: flowing && (((i - phase) % 4) + 4) % 4 === 0 ? g.gap : g.fill, role: needle >= 0 && i > needle ? 'ahead' : 'fill' })
    else cells.push({ ch: g.track, role: 'track' })
  }
  return cells
}
// Runs of one role, so a bar is a handful of Text elements rather than one per cell.
const runs = (cells: Cell[]) =>
  cells.reduce<{ text: string; role: Cell['role'] }[]>((out, c) => {
    const tail = out[out.length - 1]
    if (tail && tail.role === c.role) tail.text += c.ch
    else out.push({ text: c.ch, role: c.role })
    return out
  }, [])

// How far through its window a limit's clock is, 0 to 1.
const timeFrac = (kind: string, resetAt: number, now: number) => {
  const w = WINDOW_MS[kind]
  return w && resetAt ? Math.max(0, Math.min(1, (now - (resetAt - w)) / w)) : null
}

// Icons that change with the value beside them.
// The 5-hour limit is a moon waning as it drains; the week a plant ageing through its season; the context a
// bubble filling toward the pop of autocompact; the cache a fire that dies to ice; the cost a coin, flying while spent.
export const moon = (used: number) => ['🌕', '🌖', '🌗', '🌘', '🌑'][Math.max(0, Math.min(4, Math.round(used / 25)))]!
export const season = (used: number) => (used < 25 ? '🌱' : used < 50 ? '🌿' : used < 75 ? '🌳' : used < 95 ? '🍂' : '🥀')
// Only emoji every terminal's width table knows: a newer one (🫧, 🪙) drawn one cell wide where the layout counts
// two shifts the rest of the row, and the next redraw leaves stray letters behind ("cachre").
export const bubble = (ctxPct: number) => (ctxPct < 40 ? '💧' : ctxPct < 80 ? '🎈' : '💥')
export const ember = (warm: boolean, remain: number) => (!warm ? '🧊' : remain < 5 * 60_000 ? '⏳' : '🔥')
export const coin = (spending: boolean) => (spending ? '💸' : '💰')
const card = () => '💳'
const LIMIT_ICON: Record<string, (used: number) => string> = { five_hour: moon, seven_day: season, spend_limit: card }
const LIMIT_LABEL: Record<string, string> = { five_hour: '5h', seven_day: 'week', spend_limit: 'spend' }

// The prompt cache as a pie that empties as its time runs out.
const PIE = ['○', '◔', '◑', '◕', '●']
export const pie = (frac: number) => PIE[frac <= 0 ? 0 : Math.max(1, Math.min(4, Math.round(frac * 4)))]!

const SPARK = '▁▂▃▄▅▆▇█'
const spark = (pct: number) => SPARK[Math.min(7, Math.floor((pct / 100) * 8))]

// The session's snapshot. Reading it while drawing makes the drawing follow its writes.
async function load($: EngineInterface): Promise<Snap> {
  const { value } = await $.state.get({ plugin: 'usage-hud', key: 'snap' })
  return { ...empty, ...value }
}
// Writes are version-checked and retried, so the clock and a turn's hooks never overwrite each other.
async function save($: EngineInterface, change: (s: Snap) => Snap) {
  for (;;) {
    const { value, version } = await $.state.get({ plugin: 'usage-hud', key: 'snap' })
    const { isSet } = await $.state.set({ plugin: 'usage-hud', key: 'snap' }, change({ ...empty, ...value }), { ifVersion: version })
    if (isSet) return
  }
}

async function refresh($: EngineInterface) {
  // The per-category breakdown (local estimates, as /context's summary) is only read while the cards show it.
  const u = await $.session.usage(isOpen ? { breakdown: 'summary' } : undefined)
  const now = await $.clock.now()
  const limits = (u.rateLimits ?? [])
    .filter((r: any) => typeof r?.kind === 'string' && Number.isFinite(r.percentUsed))
    .map((r: any) => ({ kind: r.kind, pct: Math.max(0, r.percentUsed), resetsAt: r.resetsAt && Number.isFinite(Date.parse(r.resetsAt)) ? r.resetsAt : undefined }))
  const tokens = num(u.context?.tokens)
  const window = num(u.context?.window)
  const ctx = u.context?.tokens === undefined || window <= 0 ? null : { tokens, window, pct: Number.isFinite(u.context.percent) ? u.context.percent! : (tokens / window) * 100 }
  const usd = num(u.cost?.usd)
  // Subscription accounts report rate-limit windows and get the 1-hour prompt cache; API keys get 5 minutes.
  const ttl = limits.some((l: any) => l.kind !== 'spend_limit') ? TTL_SUB_MS : TTL_API_MS
  const b = u.context.breakdown
  const parts: Part[] | undefined = b?.categories
    .filter((c: any) => c.kind === 'used' && c.tokens > 0)
    .sort((x: any, y: any) => y.tokens - x.tokens)
    .map((c: any) => ({ name: String(c.name), tokens: num(c.tokens), color: c.color }))
  const buffer = b ? num(b.categories.find((c: any) => c.kind === 'buffer')?.tokens) : undefined
  await save($, (s: Snap) => {
    // Keep the last half hour of readings per limit; a drop means the window reset, so its history starts over.
    const samples: Record<string, Sample[]> = {}
    for (const l of limits as { kind: string; pct: number }[]) {
      const prev = (s.samples ?? {})[l.kind] ?? []
      const tail = prev[prev.length - 1]
      const kept = tail && l.pct < tail.pct - 1 ? [] : prev.filter(x => now - x.t <= 30 * 60_000)
      samples[l.kind] = !tail || now - tail.t >= 60_000 || l.pct !== tail.pct ? [...kept, { t: now, pct: l.pct }].slice(-40) : kept
    }
    return { ...s, limits, ctx, usd, now, ttl, parts: parts ?? s.parts, buffer: buffer ?? s.buffer, samples, startedAt: num(u.startedAt) || s.startedAt }
  })
}

// The bars only move while tokens are being spent.
const animating = (s: Snap) => !s.calm && s.working

// The clock: a frame every 300ms while tokens flow, else once a second for the countdowns; usage every 10s.
async function pulse($: EngineInterface) {
  isLooping = true
  let lastRead = 0
  for (;;) {
    const s = await load($)
    await $.clock.sleep(animating(s) ? ANIM_MS : TICK_MS)
    const now = await $.clock.now()
    if (now - lastRead >= REFRESH_MS) {
      lastRead = now
      await refresh($)
    }
    await save($, (v: Snap) => ({ ...v, now, phase: v.phase + 1 }))
  }
}

// The details live in the band itself, drawn on the terminal's own background: no docked pane, no slab of
// theme colour beside the transcript, and the transcript keeps its full width.
async function setOpen($: EngineInterface, open: boolean) {
  isOpen = open
  if (open) await refresh($)
  await save($, (s: Snap) => ({ ...s, open }))
}

// The collapsed line as styled runs, at the most detail that fits `width` cells. Each step drops the least useful
// part: reset notes, then the run-out forecast, then shorter bars, the cache, the context, the bars, the labels.
export type Span = { text: string; color?: string; bold?: boolean }
const LEVELS = [
  { bar: 12, note: true, out: true, cache: true, ctx: true, label: true, sep: '  │  ' },
  { bar: 12, note: false, out: true, cache: true, ctx: true, label: true, sep: '  │  ' },
  { bar: 8, note: false, out: false, cache: true, ctx: true, label: true, sep: '  │  ' },
  { bar: 6, note: false, out: false, cache: false, ctx: true, label: true, sep: ' │ ' },
  { bar: 4, note: false, out: false, cache: false, ctx: false, label: true, sep: ' │ ' },
  { bar: 0, note: false, out: false, cache: false, ctx: false, label: false, sep: ' │ ' },
]
export function bandLine(s: Snap, width: number): Span[] {
  const resetAt = (l: Limit) => (l.resetsAt ? Date.parse(l.resetsAt) : 0)
  const when = (t: number) => (localTime(t).date === localTime(s.now).date ? localTime(t).time : `${localTime(t).day} ${localTime(t).time}`)
  const age = s.lastAt ? s.now - s.lastAt : s.ttl
  const remain = Math.max(0, s.ttl - age)
  const isWarm = s.lastAt > 0 && remain > 0
  const shown = ['five_hour', 'seven_day', 'spend_limit'].map(k => s.limits.find(l => l.kind === k)).filter((l): l is Limit => !!l)
  const build = (o: (typeof LEVELS)[number]) => {
    const groups: Span[][] = shown.map(l => {
      const out = forecast(l.pct, resetAt(l), WINDOW_MS[l.kind] ?? 0, s.now, s.samples[l.kind] ?? [])?.outAt
      const m = meter(l.pct / 100, o.bar)
      const note = !l.resetsAt ? '' : l.kind === 'five_hour' ? `${span(resetAt(l) - s.now)} · ${localTime(resetAt(l)).time}` : `${localTime(resetAt(l)).day} ${localTime(resetAt(l)).time}`
      return [
        { text: `${(LIMIT_ICON[l.kind] ?? moon)(l.pct)} ` },
        ...(o.label ? [{ text: `${LIMIT_LABEL[l.kind] ?? l.kind} `, color: C.muted }] : []),
        ...(o.bar ? [{ text: m.fill, color: usedTone(l.pct) }, { text: m.track, color: C.track }, { text: ' ' }] : []),
        { text: `${Math.round(l.pct)}%`, color: usedTone(l.pct), bold: true },
        ...(o.out && out ? [{ text: ` · runs out ~${when(out)}`, color: l.pct >= 85 ? C.bad : C.warn }] : []),
        ...(o.note && note ? [{ text: ` · ${note}`, color: C.muted }] : []),
      ]
    })
    if (o.ctx && s.ctx)
      groups.push([
        { text: `${bubble(s.ctx.pct)} ` },
        ...(o.label ? [{ text: 'ctx ', color: C.muted }] : []),
        { text: tok(s.ctx.tokens), bold: true },
        { text: `/${tok(s.ctx.window)}`, color: C.muted },
      ])
    if (o.cache && s.lastAt > 0)
      groups.push([
        { text: `${ember(isWarm, remain)} ` },
        ...(o.label ? [{ text: 'cache ', color: C.muted }] : []),
        { text: isWarm ? (remain < 5 * 60_000 ? clock(remain) : span(remain)) : 'cold', color: !isWarm ? C.muted : remain < 5 * 60_000 ? C.warn : C.ok },
      ])
    groups.push([{ text: `${coin(s.working)} ` }, { text: money(s.usd), bold: true }, ...(o.label ? [{ text: ' est.', color: C.muted }] : [])])
    return groups.flatMap((g, i) => (i ? [{ text: o.sep, color: C.track }, ...g] : g))
  }
  const fits = (line: Span[]) => line.reduce((n, sp) => n + cells(sp.text), 0) <= width
  for (const o of LEVELS) {
    const line = build(o)
    if (fits(line)) return line
  }
  return build(LEVELS[LEVELS.length - 1]!)
}

// How many cards sit side by side in the band's width.
export const perRow = (cols: number) => (cols >= 4 * CARD_MIN + 3 ? 4 : cols >= 2 * CARD_MIN + 1 ? 2 : 1)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'hud', description: 'Show or hide the usage cards; /hud calm turns the animations off and on' })
    $.ui.status(undefined)
    await save($, (s: Snap) => ({ ...s, open: false }))
    await refresh($)
    // The loop's pending sleep is aborted when the module unloads (a reload, the session's end): nothing to report.
    if (!isLooping)
      pulse($).catch(() => {
        isLooping = false
      })
    return next(e)
  })

  on('command.run', { command: 'hud' }, async ($, e) => {
    if (e.args.trim() === 'calm') {
      const calm = !(await load($)).calm
      await save($, (s: Snap) => ({ ...s, calm }))
      return { text: calm ? 'Usage HUD animations off.' : 'Usage HUD animations on.' }
    }
    const open = !(await load($)).open
    await setOpen($, open)
    return { text: open ? 'Usage cards shown above the prompt.' : 'Usage cards hidden.' }
  })

  on('session.measure', async ($, e, next) => {
    await refresh($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await save($, (s: Snap) => ({ ...s, working: true }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await save($, (s: Snap) => ({ ...s, working: false }))
    // turn.complete's usage sums every request of the turn, so a tool-heavy turn counts the whole prompt once per step.
    // The window's last response is what the context bar measures: use that so both agree.
    const win = (await $.session.usage({ breakdown: 'summary' })).context.breakdown?.apiUsage
    const u = win ?? e.usage
    if (u) {
      const at = await $.clock.now()
      // Bedrock, Vertex and gateways may leave the cache fields out.
      const read = num(u.cache_read_input_tokens)
      const wrote = num(u.cache_creation_input_tokens)
      const fresh = num(u.input_tokens)
      const turn: Turn = { read, wrote, fresh, hit: Math.round((read / Math.max(1, read + wrote + fresh)) * 100) }
      await save($, (s: Snap) => ({ ...s, model: e.usage?.model ?? s.model, lastAt: at, turns: [...s.turns, turn].slice(-12) }))
    }
    await refresh($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await load($)
    const five = s.limits.find(l => l.kind === 'five_hour')
    const week = s.limits.find(l => l.kind === 'seven_day')
    const spend = s.limits.find(l => l.kind === 'spend_limit')
    if (e.props.hasSurvey || (!s.limits.length && !s.ctx)) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const cols = Math.max(20, num(e.props.bodyColumns) || 80)
    const resetAt = (l?: { resetsAt?: string }) => (l?.resetsAt ? Date.parse(l.resetsAt) : 0)
    const flowing = animating(s)
    const roleColor = (role: Cell['role'], pct: number) =>
      role === 'ahead' ? (pct >= 85 ? C.bad : C.warn) : role === 'fill' ? usedTone(pct) : role === 'track' ? C.track : undefined
    const PaceBar = (p: { l: { kind: string; pct: number; resetsAt?: string }; width: number; g: { fill: string; gap: string; track: string; needle: string }; flow: boolean }) => (
      <Text>
        {runs(paceCells(p.l.pct / 100, null, p.width, p.g, s.phase, p.flow && flowing)).map((r, i) => (
          <Text key={`r${i}`} color={roleColor(r.role, p.l.pct)} bold={r.role === 'needle'}>
            {r.text}
          </Text>
        ))}
      </Text>
    )
    const fc = (l: { kind: string; pct: number; resetsAt?: string }) => forecast(l.pct, resetAt(l), WINDOW_MS[l.kind] ?? 0, s.now, s.samples[l.kind] ?? [])
    // A time today reads as the time alone; any other day gets its weekday.
    const when = (t: number) => (localTime(t).date === localTime(s.now).date ? localTime(t).time : `${localTime(t).day} ${localTime(t).time}`)
    // Cache
    const age = s.lastAt ? s.now - s.lastAt : s.ttl
    const remain = Math.max(0, s.ttl - age)
    const isWarm = s.lastAt > 0 && remain > 0
    const cacheTone = !isWarm ? C.muted : remain < 5 * 60_000 ? C.warn : C.ok

    // Collapsed: one quiet line, cut down to the band's width so it never wraps (a wrapped row garbles on redraw
    // and can push the button off the line).
    if (!s.open) {
      // The terminal reports clicks to Claude Code only in its fullscreen layout; on the main screen a click never
      // arrives, so the button there names the command instead of looking clickable. Enter presses it either way
      // once ctrl+x tab has focused the band.
      const clickable = e.surface !== 'terminal' || e.viewport?.isFullscreen !== false
      const label = clickable ? 'details ›' : '/hud for details'
      const line = bandLine(s, cols - cells(label) - 2)
      return (
        <Box>
          <Box flexShrink={1}>
            <Text wrap="truncate">
              {line.map((sp, i) => (
                <Text key={`b${i}`} color={sp.color} bold={sp.bold}>
                  {sp.text}
                </Text>
              ))}
            </Text>
          </Box>
          <Box flexShrink={0} marginLeft={2}>
            <Button key="open" label={label} plain dimColor onPress={() => setOpen($, true)} />
          </Box>
        </Box>
      )
    }

    // Expanded: a row of cards, four across on a wide terminal, two by two on a narrower one.
    const n = perRow(cols)
    const cardW = Math.floor((cols - (n - 1)) / n)
    const W = cardW - 4

    const Bar = (p: { frac: number; color: string }) => {
      const m = block(p.frac, W)
      return (
        <Text>
          <Text color={p.color}>{m.fill}</Text>
          <Text color={C.track}>{m.track}</Text>
        </Text>
      )
    }
    const Row = (p: { left: any; right: any }) => (
      <Box justifyContent="space-between" width={W}>
        {p.left}
        {p.right}
      </Box>
    )
    const Card = (p: { title: string; right?: any; children: any }) => (
      <Box flexDirection="column" width={cardW} borderStyle="round" borderColor={C.track} paddingX={1}>
        <Row left={<Text bold color={C.accent}>{p.title}</Text>} right={p.right ?? <Text> </Text>} />
        {p.children}
      </Box>
    )
    const CARD = { fill: '▄', gap: '▂', track: '▄', needle: '' }
    // One line under a limit's bar: how far ahead of or behind the clock it is, and where the pace lands it.
    const Pace = (p: { l: { kind: string; pct: number; resetsAt?: string } }) => {
      const t = timeFrac(p.l.kind, resetAt(p.l), s.now)
      const f = fc(p.l)
      if (t === null) return null
      return (
        <Text color={C.muted} wrap="truncate">
          {Math.round(t * 100)}% of window gone
          {f ? (
            f.outAt ? (
              <Text color={p.l.pct >= 85 ? C.bad : C.warn} bold> · runs out ~{when(f.outAt)}</Text>
            ) : (
              ` · ~${Math.min(100, Math.round(f.projected))}% by reset`
            )
          ) : (
            ''
          )}
        </Text>
      )
    }
    const Limit = (p: { title: string; l?: { kind: string; pct: number; resetsAt?: string } }) => (
      <Box flexDirection="column" marginTop={1}>
        <Row
          left={
            <Text bold>
              {p.l ? `${(LIMIT_ICON[p.l.kind] ?? moon)(p.l.pct)} ` : ''}
              {p.title}
            </Text>
          }
          right={p.l ? <Text bold color={usedTone(p.l.pct)}>{Math.round(p.l.pct)}%</Text> : <Text color={C.muted}>—</Text>}
        />
        {p.l ? <PaceBar l={p.l} width={W} g={CARD} flow /> : <Bar frac={0} color={C.track} />}
        {p.l && <Pace l={p.l} />}
        {p.l?.resetsAt ? (
          <Text color={C.muted} wrap="truncate">
            {localTime(resetAt(p.l)).date}, <Text bold>{localTime(resetAt(p.l)).time}</Text> · in {span(resetAt(p.l) - s.now)}
          </Text>
        ) : (
          <Text color={C.muted}>{p.l ? `${Math.round(100 - p.l.pct)}% left` : 'no reading yet'}</Text>
        )}
      </Box>
    )

    const last = s.turns[s.turns.length - 1]
    const prompt = last ? last.read + last.wrote + last.fresh : 0
    const mix = last
      ? segments(
          [
            { name: 'cached', tokens: last.read, color: C.ok },
            { name: 'written', tokens: last.wrote, color: C.warn },
            { name: 'new', tokens: last.fresh, color: C.blue },
          ].filter(p => p.tokens > 0),
          1,
          0,
          W,
        )
      : []
    const legend = [...s.parts.slice(0, 4), ...(s.parts.length > 4 ? [{ name: 'Other', tokens: s.parts.slice(4).reduce((t, p) => t + p.tokens, 0), color: C.muted }] : [])]

    return (
      <Box flexDirection="column">
        <Box flexWrap="wrap" columnGap={1}>
          <Card title="Limits" right={<Text color={C.muted}>resets · {zoneLabel(new Date(s.now).getTimezoneOffset())}</Text>}>
            {five || week ? <Limit title="5-hour" l={five} /> : null}
            {five || week ? <Limit title="Weekly" l={week} /> : null}
            {spend ? <Limit title="Spend limit" l={spend} /> : null}
            {!five && !week && !spend ? (
              <Box marginTop={1} flexDirection="column">
                <Text color={C.muted} wrap="truncate">no plan limits on this account</Text>
                <Text color={C.muted} wrap="truncate">(API key or cloud billing)</Text>
              </Box>
            ) : null}
          </Card>

          <Card
            title={`${s.ctx ? bubble(s.ctx.pct) : '🫧'} Context`}
            right={
              s.ctx ? (
                <Text>
                  <Text bold>{tok(s.ctx.tokens)}</Text>
                  <Text color={C.muted}> / {tok(s.ctx.window)}</Text>
                </Text>
              ) : (
                <Text color={C.muted}>—</Text>
              )
            }
          >
            <Box marginTop={1} flexDirection="column">
              {s.ctx && s.parts.length ? (
                <Text>
                  {segments(s.parts, s.ctx.tokens / s.ctx.window, s.buffer / s.ctx.window, W).map((g, i) => (
                    <Text key={`c${i}`} color={g.color}>{'▄'.repeat(g.w)}</Text>
                  ))}
                </Text>
              ) : (
                <Bar frac={s.ctx ? s.ctx.tokens / s.ctx.window : 0} color={C.blue} />
              )}
              <Text color={C.muted} wrap="truncate">
                {s.ctx ? `${Math.round(s.ctx.pct)}% full · ${tok(Math.max(0, s.ctx.window - s.ctx.tokens))} free${s.buffer ? ` · ${tok(s.buffer)} reserve` : ''}` : 'no reading yet'}
              </Text>
            </Box>
            <Box marginTop={1} flexDirection="column">
              {legend.length > 0 && <Text color={C.muted}>by category (est.)</Text>}
              {legend.map((p, i) => (
                <Row
                  key={`l${i}`}
                  left={
                    <Text wrap="truncate">
                      <Text color={p.color}>●</Text>
                      <Text color={C.muted}> {p.name}</Text>
                    </Text>
                  }
                  right={<Text>{tok(p.tokens)}</Text>}
                />
              ))}
            </Box>
          </Card>

          <Card
            title={`${ember(isWarm, remain)} Cache · ${s.ttl === TTL_SUB_MS ? '1h' : '5m'}`}
            right={
              isWarm ? (
                <Text>
                  <Text bold color={cacheTone}>{pie(remain / s.ttl)} warm</Text>
                  <Text color={C.muted}> {clock(remain)}</Text>
                </Text>
              ) : (
                // No turn seen by this process (a fresh start, or a resumed session): the cache may well be warm.
                <Text color={C.muted}>{s.lastAt ? '○ cold' : '— unknown'}</Text>
              )
            }
          >
            <Box marginTop={1} flexDirection="column">
              <Bar frac={isWarm ? remain / s.ttl : 0} color={C.ok} />
              <Text color={C.muted}>{isWarm ? 'time left before the cache expires' : s.lastAt ? 'next turn re-writes the prompt' : 'known after the first reply'}</Text>
            </Box>
            {last ? (
              <Box marginTop={1} flexDirection="column">
                <Row left={<Text bold>Last request</Text>} right={<Text bold color={hitTone(last.hit)}>{last.hit}% hit</Text>} />
                <Text>
                  {mix.map((g, i) => (
                    <Text key={`m${i}`} color={g.color}>{'▄'.repeat(g.w)}</Text>
                  ))}
                </Text>
                <Row left={<Text color={C.muted}><Text color={C.ok}>●</Text> cached</Text>} right={<Text>{tok(last.read)}</Text>} />
                <Row left={<Text color={C.muted}><Text color={C.warn}>●</Text> written</Text>} right={<Text>{tok(last.wrote)}</Text>} />
                <Row left={<Text color={C.muted}><Text color={C.blue}>●</Text> new</Text>} right={<Text>{tok(last.fresh)}</Text>} />
              </Box>
            ) : (
              <Box marginTop={1}>
                <Text color={C.muted}>no turn yet this session</Text>
              </Box>
            )}
          </Card>

          <Card title={`${coin(s.working)} Session`} right={<Text bold>≈ {money(s.usd)}</Text>}>
            <Box marginTop={1} flexDirection="column">
              <Text color={C.muted} wrap="truncate">{five || week ? 'est. at API prices, not a bill' : 'est. at API list prices'}</Text>
              <Row left={<Text color={C.muted}>model</Text>} right={<Text>{clip(s.model || '—', W - 7)}</Text>} />
              <Row left={<Text color={C.muted}>turns</Text>} right={<Text>{s.turns.length}</Text>} />
              {/* Under ten minutes in, an hourly rate is mostly noise: one big turn reads as hundreds an hour. */}
              {s.startedAt > 0 && s.now - s.startedAt >= 10 * 60_000 && (
                <Row left={<Text color={C.muted}>burn (est.)</Text>} right={<Text>≈ {money(s.usd / ((s.now - s.startedAt) / 3_600_000))}/h</Text>} />
              )}
              {s.turns.length >= 3 && (
                <Row
                  left={<Text color={C.muted}>hit rate</Text>}
                  right={
                    <Text>
                      {s.turns.map((t, i) => (
                        <Text key={`s${i}`} color={hitTone(t.hit)}>{spark(t.hit)}</Text>
                      ))}
                    </Text>
                  }
                />
              )}
            </Box>
            <Box marginTop={1}>
              <Button key="close" label="‹ hide" plain dimColor onPress={() => setOpen($, false)} />
              <Text color={C.muted}>  · /hud toggles</Text>
            </Box>
          </Card>
        </Box>
      </Box>
    )
  })
}
