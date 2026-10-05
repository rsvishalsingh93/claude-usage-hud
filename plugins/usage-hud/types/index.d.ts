export type Limit = { kind: string; pct: number; resetsAt?: string }
export type Turn = { read: number; wrote: number; fresh: number; hit: number }
export type Part = { name: string; tokens: number; color: string }
export type Sample = { t: number; pct: number }
export type Snap = {
  limits: Limit[]
  ctx: { tokens: number; window: number; pct: number } | null
  usd: number
  model: string
  ttl: number
  lastAt: number
  turns: Turn[]
  now: number
  open: boolean
  parts: Part[]
  buffer: number
  samples: Record<string, Sample[]>
  phase: number
  startedAt: number
  calm: boolean
  working: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'usage-hud': { snap: Snap }
  }
}
