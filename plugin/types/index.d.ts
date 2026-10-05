export type KhataStatus = 'open' | 'closed' | 'halted'

export type Khata = {
  id: string
  name: string
  status: KhataStatus
  usd: number
  tokens: number
  // 0 means no budget: the general khata, which catches unassigned work.
  budgetUsd: number
  calls: number
  fails: number
  blocked: number
  openedAt: number
  haltReason?: string
}

export type Outcome = 'ok' | 'fail' | 'blocked'

export type Entry = {
  at: number
  khata: string
  tool: string
  summary: string
  ms: number
  outcome: Outcome
  note?: string
}

export type TripKind = 'budget' | 'session' | 'halted' | 'loop' | 'burn'

export type Trip = {
  at: number
  kind: TripKind
  khata: string
  tool: string
  summary: string
  reason: string
}

export type Streak = { fp: string; n: number }

// A running total at a moment: dollars for the cost series, tokens for the token series.
export type Sample = { at: number; usd: number }
export type TokenSample = { at: number; n: number }

// A plan's usage window as the API last reported it: five_hour, seven_day, spend_limit.
export type RateWindow = { kind: string; percentUsed: number; resetsAt?: string }

export type Book = {
  v: 3
  khatas: Khata[]
  entries: Entry[]
  trips: Trip[]
  active: string | null
  lastUsd: number | null
  samples: Sample[]
  tokens: number
  tokenSamples: TokenSample[]
  rateLimits: RateWindow[]
  streaks: Record<string, Streak>
  burnPausedUntil: number
  saved: number
}

export type SessionSummary = {
  startedAt: number
  usd: number
  tokens?: number
  khatas: { name: string; status: KhataStatus; usd: number; calls: number }[]
}

declare module 'claude-code' {
  interface PluginState {
    tokenmunim: { book: Book }
  }
}
