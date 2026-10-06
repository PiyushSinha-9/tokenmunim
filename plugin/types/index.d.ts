export type TaskStatus = 'open' | 'closed' | 'halted'

export type Task = {
  id: string
  name: string
  status: TaskStatus
  usd: number
  tokens: number
  // 0 means no budget in dollars: the general task, which catches unassigned
  // work, or a task whose budget is a share of the plan instead.
  budgetUsd: number
  // A budget as a share of a plan window: 2 means 2% of the week.
  budgetPct?: number
  budgetWindow?: PlanWindow
  calls: number
  fails: number
  blocked: number
  openedAt: number
  haltReason?: string
}

export type Outcome = 'ok' | 'fail' | 'blocked'

export type Entry = {
  at: number
  task: string
  tool: string
  summary: string
  ms: number
  outcome: Outcome
  note?: string
  // The loop that made the call: a subagent's id, absent for the main loop.
  agent?: string
}

export type TripKind = 'budget' | 'session' | 'halted' | 'loop' | 'burn'

export type Trip = {
  at: number
  kind: TripKind
  task: string
  taskId?: string
  tool: string
  summary: string
  reason: string
  // What the person did about it from the pane, once they did something.
  resolved?: string
}

export type Streak = { fp: string; n: number }

// A running total at a moment: dollars for the cost series, tokens for the token series.
export type Sample = { at: number; usd: number }
export type TokenSample = { at: number; n: number }

// A plan's usage window as the API last reported it: five_hour, seven_day, spend_limit.
export type RateWindow = { kind: string; percentUsed: number; resetsAt?: string }
export type LimitSample = { at: number; pct: number }

// Where a reply's tokens went, as the API counts them.
export type TokenMix = { input: number; cacheRead: number; cacheWrite: number; output: number }

// One loop's share of the session: the main loop, or a subagent.
export type AgentLedger = {
  id: string
  name: string
  type?: string
  status?: string
  model?: string
  usd: number
  tokens: number
  mix: TokenMix
  steps: number
  calls: number
  firstAt: number
  lastAt: number
}

// The plan windows a budget can be a share of.
export type PlanWindow = 'seven_day' | 'five_hour'

// What TokenMunim has learned about one plan window: how far the account's
// percent moved while this session spent, over the stretches it watched both.
export type Meter = {
  // The latest reading: the account's percent, this session's cost, and when.
  last?: { at: number; pct: number; usd: number; resetsAt?: string }
  // The last time the percent moved while watched: evidence runs from one
  // such tick to the next, so the percent's rounding never enters it.
  tick?: { pct: number; usd: number }
  // The evidence: percent moved and dollars spent at API prices, gaps left out.
  pct: number
  usd: number
  // Where this session stood when the current window was first seen.
  firstPct?: number
  windowUsd: number
  // The rate earlier sessions learned, until this one has learned its own.
  prior?: { pct: number; usd: number }
}

export type Book = {
  v: 7
  tasks: Task[]
  entries: Entry[]
  trips: Trip[]
  agents: AgentLedger[]
  active: string | null
  lastUsd: number | null
  samples: Sample[]
  tokens: number
  tokenSamples: TokenSample[]
  mix: TokenMix
  rateLimits: RateWindow[]
  limitSamples: Record<string, LimitSample[]>
  streaks: Record<string, Streak>
  burnPausedUntil: number
  // Calls the person let through a tripped circuit from the pane.
  passes: number
  meter: Partial<Record<PlanWindow, Meter>>
}

export type Tab = 'overview' | 'tasks' | 'activity' | 'alerts' | 'agents'

// What the pane is showing: its own state, apart from the book it draws.
export type View = {
  tab: Tab
  // Sections the person folded, and sections they opened. Their choice
  // always wins over the pane folding things itself to fit its height.
  folded: string[]
  opened: string[]
  task: string | null
  entry: number | null
}

export type SessionSummary = {
  startedAt: number
  usd: number
  tokens?: number
  tasks: { name: string; status: TaskStatus; usd: number; calls: number }[]
}

// The bar above the prompt: hidden until the person asks for it in a
// session, with a button that opens and closes the dashboard.
export type Bar = { shown: boolean; open: boolean }

declare module 'claude-code' {
  interface PluginState {
    tokenmunim: { book: Book; view: View; bar: Bar }
  }
}
