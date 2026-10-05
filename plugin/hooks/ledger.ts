// The munim's arithmetic: pure functions over a Book, so every rule is testable
// without a session. register.tsx wires them to events, pane.tsx draws them.

import type {
  AgentLedger,
  Book,
  Entry,
  Task,
  LimitSample,
  Outcome,
  RateWindow,
  Sample,
  SessionSummary,
  TokenMix,
  TokenSample,
  Trip,
  TripKind,
} from '../types'

export type Limits = {
  taskBudgetUsd: number
  sessionBudgetUsd: number
  loopLimit: number
  burnLimitUsdPerMin: number
}

export type Verdict = { kind: TripKind; reason: string; short: string }

// A reply's usage as the API reports it.
export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model?: string
}

export const GENERAL = 'general'
export const MAIN = 'main'
export const MAX_ENTRIES = 2000
export const MAX_TRIPS = 100
export const MAX_AGENTS = 50
export const SAMPLE_KEEP_MS = 30 * 60_000
export const BURN_WINDOW_MS = 120_000
export const BURN_PAUSE_MS = 120_000
export const RUNWAY_WINDOW_MS = 20 * 60_000

const emptyMix = (): TokenMix => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })

export const emptyBook = (): Book => ({
  v: 6,
  tasks: [],
  entries: [],
  trips: [],
  agents: [],
  active: null,
  lastUsd: null,
  samples: [],
  tokens: 0,
  tokenSamples: [],
  mix: emptyMix(),
  rateLimits: [],
  limitSamples: {},
  streaks: {},
  burnPausedUntil: 0,
  passes: 0,
  saved: 0,
})

// A book as older versions saved it. Before version 5 a task was a "khata",
// an activity entry pointed at its "khata", and a trip named its "khata".
type LegacyTask = Omit<Task, 'tokens'> & { tokens?: number }
type OlderBook = Partial<Omit<Book, 'v' | 'tasks' | 'entries' | 'trips'>> & {
  v?: number
  tasks?: LegacyTask[]
  khatas?: LegacyTask[]
  entries?: (Omit<Entry, 'task'> & { task?: string; khata?: string })[]
  trips?: (Omit<Trip, 'task'> & { task?: string; khata?: string; khataId?: string })[]
}

// Brings a book written by an older version up to this one. Version 2 took the
// budget off the general task (lifting a budget halt on it), version 3 counts
// tokens, version 4 adds agents, the token mix and the limit history, and
// version 5 names things in plain words: tasks, activity, the ledger, and
// version 6 carries those words into alert text saved before them.
export const normalize = (book: OlderBook | Book | undefined | null): Book => {
  if (book && book.v === 6) return book as Book
  const src = (book ?? {}) as OlderBook
  const { khatas: _oldTasks, ...current } = src
  const base = { ...emptyBook(), ...current, v: 6 as const }
  const tasks = (src.tasks ?? src.khatas ?? []).map(t => {
    const counted: Task = { ...t, tokens: t.tokens ?? 0 }
    return t.id === GENERAL && (src.v ?? 1) < 2
      ? { ...counted, budgetUsd: 0, status: src.active === GENERAL ? 'open' : 'closed', haltReason: undefined }
      : counted
  })
  const entries: Entry[] = (src.entries ?? []).map(({ khata, ...e }) => ({ ...e, task: e.task ?? khata ?? GENERAL }))
  // Alert text saved before version 5 spoke of khatas too.
  const plain = (text: string) => text.replace(/\bKhata\b/g, 'Task').replace(/\bkhatas\b/g, 'tasks').replace(/\bkhata\b/g, 'task')
  const trips: Trip[] = (src.trips ?? []).map(({ khata, khataId, ...t }) => ({
    ...t,
    task: t.task ?? khata ?? 'general',
    taskId: t.taskId ?? khataId,
    reason: plain(t.reason),
  }))
  return {
    ...base,
    tasks,
    entries,
    trips,
    agents: src.agents ?? [],
    tokens: src.tokens ?? 0,
    tokenSamples: src.tokenSamples ?? [],
    mix: src.mix ?? emptyMix(),
    rateLimits: src.rateLimits ?? [],
    limitSamples: src.limitSamples ?? {},
    passes: src.passes ?? 0,
  }
}

export const limitsFrom = (options: Readonly<Record<string, unknown>>): Limits => {
  const num = (key: string, fallback: number) => {
    const value = Number(options[key])
    return Number.isFinite(value) && value > 0 ? value : fallback
  }
  return {
    taskBudgetUsd: num('taskBudgetUsd', 1),
    sessionBudgetUsd: num('sessionBudgetUsd', 20),
    loopLimit: Math.max(2, Math.round(num('loopLimit', 3))),
    burnLimitUsdPerMin: num('burnLimitUsdPerMin', 2),
  }
}

export const money = (n: number) => `$${n.toFixed(2)}`

// ---- tasks ----------------------------------------------------------------

const newTask = (id: string, name: string, budgetUsd: number, now: number): Task => ({
  id,
  name,
  status: 'open',
  usd: 0,
  tokens: 0,
  budgetUsd,
  calls: 0,
  fails: 0,
  blocked: 0,
  openedAt: now,
})

const withTask = (book: Book, id: string, fn: (k: Task) => Task): Book => ({
  ...book,
  tasks: book.tasks.map(k => (k.id === id ? fn(k) : k)),
})

// The task new work is booked to: the open one, else the general task,
// which has no budget of its own and only answers to the session budget.
export const activeTask = (book: Book, now: number): [Book, Task] => {
  const open = book.tasks.find(k => k.id === book.active)
  if (open) return [book, open]
  const general = book.tasks.find(k => k.id === GENERAL)
  if (general) return [{ ...book, active: GENERAL }, general]
  const made = newTask(GENERAL, 'general', 0, now)
  return [{ ...book, active: GENERAL, tasks: [...book.tasks, made] }, made]
}

export const haltedNamed = (book: Book, name: string): Task | undefined =>
  book.tasks.find(k => k.status === 'halted' && k.name.toLowerCase() === name.toLowerCase())

export const startTask = (book: Book, name: string, budgetUsd: number, now: number): [Book, Task] => {
  // Opening the task that is already open carries on with it.
  const current = book.tasks.find(k => k.id === book.active)
  if (current && current.status === 'open' && current.name === name) return [book, current]
  const closed = endTask(book)
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'task'
  const id = `${slug}-${closed.tasks.length + 1}`
  const made = newTask(id, name, budgetUsd, now)
  return [{ ...closed, active: id, tasks: [...closed.tasks, made] }, made]
}

// Closes the open task. Only one task is ever open, so any other left open
// (by a book from an older version) is closed with it.
export const endTask = (book: Book): Book => {
  if (book.active === null && !book.tasks.some(k => k.status === 'open')) return book
  return { ...book, active: null, tasks: book.tasks.map(k => (k.status === 'open' ? { ...k, status: 'closed' } : k)) }
}

// ---- agents ----------------------------------------------------------------

const newAgent = (id: string, now: number): AgentLedger => ({
  id,
  name: id === MAIN ? 'main' : 'subagent',
  usd: 0,
  tokens: 0,
  mix: emptyMix(),
  steps: 0,
  calls: 0,
  firstAt: now,
  lastAt: now,
})

const withAgent = (book: Book, agentId: string | undefined, now: number, fn: (a: AgentLedger) => AgentLedger): Book => {
  const id = agentId ?? MAIN
  const found = book.agents.some(a => a.id === id)
  const agents = found ? book.agents : [...book.agents, newAgent(id, now)].slice(-MAX_AGENTS)
  return { ...book, agents: agents.map(a => (a.id === id ? fn(a) : a)) }
}

// Names and states from the engine's list of agents.
export const nameAgents = (book: Book, infos: readonly { id: string; description: string; type: string; status: string }[]): Book => ({
  ...book,
  agents: book.agents.map(a => {
    const info = infos.find(i => i.id === a.id)
    return info ? { ...a, name: info.description || info.type || a.name, type: info.type, status: info.status } : a
  }),
})

export const noteAgentCall = (book: Book, agentId: string | undefined, now: number): Book =>
  withAgent(book, agentId, now, a => ({ ...a, calls: a.calls + 1, lastAt: now }))

// ---- cost and tokens -------------------------------------------------------

// Books what the session spent since the last reading to the active task and
// to the loop whose reply or call brought the reading.
export const bookCost = (book: Book, usd: number | undefined, now: number, agentId?: string): Book => {
  if (usd === undefined) return book
  const samples = [...book.samples, { at: now, usd }].filter(s => now - s.at <= SAMPLE_KEEP_MS).slice(-800)
  if (book.lastUsd === null) return { ...book, lastUsd: usd, samples }
  const delta = Math.max(0, usd - book.lastUsd)
  const [withActive, task] = activeTask(book, now)
  const charged = withTask(withActive, task.id, k => ({ ...k, usd: k.usd + delta }))
  const byAgent = delta > 0 ? withAgent(charged, agentId, now, a => ({ ...a, usd: a.usd + delta, lastAt: now })) : charged
  return { ...byAgent, lastUsd: usd, samples }
}

const addMix = (a: TokenMix, b: TokenMix): TokenMix => ({
  input: a.input + b.input,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  output: a.output + b.output,
})

export const mixOf = (u: Usage): TokenMix => ({
  input: u.input_tokens,
  cacheRead: u.cache_read_input_tokens,
  cacheWrite: u.cache_creation_input_tokens,
  output: u.output_tokens,
})

export const mixTotal = (m: TokenMix): number => m.input + m.cacheRead + m.cacheWrite + m.output

// The share of input the prompt cache served: high is cheap.
export const cacheHit = (m: TokenMix): number => {
  const input = m.input + m.cacheRead + m.cacheWrite
  return input > 0 ? m.cacheRead / input : 0
}

// Books one reply: its tokens to the session, the active task and its loop.
export const bookTokens = (book: Book, usage: Usage, now: number, agentId?: string): Book => {
  const mix = mixOf(usage)
  const tokens = mixTotal(mix)
  if (!(tokens > 0)) return book
  const [b, task] = activeTask(book, now)
  const total = b.tokens + tokens
  const first: TokenSample[] = b.tokenSamples.length === 0 ? [{ at: now - 1, n: b.tokens }] : []
  const tokenSamples = [...b.tokenSamples, ...first, { at: now, n: total }].filter(s => now - s.at <= SAMPLE_KEEP_MS).slice(-800)
  const counted = withTask(b, task.id, k => ({ ...k, tokens: k.tokens + tokens }))
  const byAgent = withAgent(counted, agentId, now, a => ({
    ...a,
    tokens: a.tokens + tokens,
    mix: addMix(a.mix, mix),
    steps: a.steps + 1,
    model: usage.model ?? a.model,
    lastAt: now,
  }))
  return { ...byAgent, tokens: total, tokenSamples, mix: addMix(b.mix, mix) }
}

// What was spent between t0 and t1. A cost reading only arrives with the next
// tool call or reply, so each delta is spread over the time it was really
// spent in; a long think followed by one call is not a spike.
export const spendBetween = (samples: readonly Sample[], t0: number, t1: number): number => {
  let spent = 0
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]
    const cur = samples[i]
    if (!prev || !cur) continue
    const delta = Math.max(0, cur.usd - prev.usd)
    if (delta === 0) continue
    const start = prev.at
    const end = Math.max(cur.at, prev.at + 1)
    const overlap = Math.min(end, t1) - Math.max(start, t0)
    if (overlap > 0) spent += (delta * overlap) / (end - start)
  }
  return spent
}

export const burnRate = (book: Book, now: number): number =>
  (spendBetween(book.samples, now - BURN_WINDOW_MS, now) / BURN_WINDOW_MS) * 60_000

// The burn chart's columns, oldest first, each the spend rate in USD per minute.
export const burnSeries = (book: Book, now: number, columns: number, bucketMs: number): number[] =>
  Array.from({ length: columns }, (_, i) => {
    const t1 = now - (columns - 1 - i) * bucketMs
    return (spendBetween(book.samples, t1 - bucketMs, t1) / bucketMs) * 60_000
  })

// Tokens per minute, column by column, for the token sparkline.
export const tokenSeries = (book: Book, now: number, columns: number, bucketMs: number): number[] => {
  const asSamples: Sample[] = book.tokenSamples.map(s => ({ at: s.at, usd: s.n }))
  return Array.from({ length: columns }, (_, i) => {
    const t1 = now - (columns - 1 - i) * bucketMs
    return (spendBetween(asSamples, t1 - bucketMs, t1) / bucketMs) * 60_000
  })
}

export const tokenRate = (book: Book, now: number): number => {
  const asSamples: Sample[] = book.tokenSamples.map(s => ({ at: s.at, usd: s.n }))
  return (spendBetween(asSamples, now - BURN_WINDOW_MS, now) / BURN_WINDOW_MS) * 60_000
}

// ---- plan limits -----------------------------------------------------------

export const setLimits = (book: Book, windows: readonly RateWindow[] | undefined, now?: number): Book => {
  if (windows === undefined || windows.length === 0) return book
  const rateLimits = windows.map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt }))
  if (now === undefined) return { ...book, rateLimits }
  const limitSamples: Record<string, LimitSample[]> = { ...book.limitSamples }
  for (const w of rateLimits) {
    const kept = (limitSamples[w.kind] ?? []).filter(s => now - s.at <= RUNWAY_WINDOW_MS)
    const last = kept[kept.length - 1]
    // A window that reset starts its history over.
    const fresh = last !== undefined && w.percentUsed < last.pct ? [] : kept
    limitSamples[w.kind] = [...fresh, { at: now, pct: w.percentUsed }].slice(-200)
  }
  return { ...book, rateLimits, limitSamples }
}

export type Runway =
  | { state: 'measuring' }
  | { state: 'steady' }
  | { state: 'lasts'; minutes: number }
  | { state: 'runs-out'; minutes: number }

// How long a plan window lasts at the pace of the last twenty minutes, set
// against when it resets: whether this pace makes it to the reset or not.
export const runway = (book: Book, kind: string, now: number): Runway => {
  const window = book.rateLimits.find(w => w.kind === kind)
  const samples = (book.limitSamples[kind] ?? []).filter(s => now - s.at <= RUNWAY_WINDOW_MS)
  const first = samples[0]
  const last = samples[samples.length - 1]
  if (!window || !first || !last || last.at - first.at < 120_000) return { state: 'measuring' }
  const perMin = ((last.pct - first.pct) / (last.at - first.at)) * 60_000
  if (!(perMin > 0)) return { state: 'steady' }
  const minutes = Math.max(0, (100 - window.percentUsed) / perMin)
  const resetIn = window.resetsAt ? (Date.parse(window.resetsAt) - now) / 60_000 : Number.POSITIVE_INFINITY
  return minutes < resetIn ? { state: 'runs-out', minutes } : { state: 'lasts', minutes }
}

// ---- describing calls ------------------------------------------------------

// What identifies "the same action": the tool and its main argument, with
// long digit runs (timestamps, ports, ids) folded so they don't hide a loop.
export const mainArg = (input: Readonly<Record<string, unknown>>): string => {
  for (const key of ['command', 'file_path', 'notebook_path', 'url', 'pattern', 'query', 'path', 'prompt', 'description', 'skill']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return ''
}

export const fingerprint = (tool: string, input: Readonly<Record<string, unknown>>): string =>
  `${tool}:${mainArg(input).trim().replace(/\s+/g, ' ').replace(/\d{4,}/g, '#').slice(0, 240)}`

export const shortPath = (path: string, cwd: string | undefined, home: string | undefined): string => {
  let p = path
  if (cwd && (p === cwd || p.startsWith(`${cwd}/`))) p = p.slice(cwd.length + 1) || '.'
  else if (home && p.startsWith(`${home}/`)) p = `~/${p.slice(home.length + 1)}`
  const parts = p.split('/')
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : p
}

// The activity's words for a call: what it was for, not its raw arguments.
export const summarize = (
  tool: string,
  input: Readonly<Record<string, unknown>>,
  cwd?: string,
  home?: string,
): string => {
  const str = (key: string) => (typeof input[key] === 'string' ? (input[key] as string).trim() : '')
  const oneLine = (s: string) => s.replace(/\s+/g, ' ')
  if (tool === 'Bash') return oneLine(str('description') || str('command'))
  if (['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(tool)) {
    const path = str('file_path') || str('notebook_path')
    return path ? shortPath(path, cwd, home) : ''
  }
  if (tool === 'Grep' || tool === 'Glob') return oneLine(`${str('pattern')}${str('path') ? ` in ${shortPath(str('path'), cwd, home)}` : ''}`)
  if (tool === 'WebFetch') return str('url').replace(/^https?:\/\//, '')
  if (tool === 'Agent' || tool === 'Task') return oneLine(str('description') || str('prompt'))
  return oneLine(mainArg(input))
}

export const toolLabel = (tool: string): string => {
  const names: Record<string, string> = {
    MultiEdit: 'Edit', WebFetch: 'Fetch', WebSearch: 'Web', ToolSearch: 'Tools',
    TodoWrite: 'Todo', NotebookEdit: 'Note', Task: 'Agent',
  }
  const mcp = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(tool)
  return (names[tool] ?? (mcp?.[1] ?? tool)).slice(0, 6)
}

// ---- the circuit breaker ---------------------------------------------------

// Decides whether a call may run. Returns the book (a task may be halted, a
// burn pause started, a pass used up) and a verdict when the call must not run.
export const check = (book: Book, fp: string, limits: Limits, now: number): [Book, Verdict | null] => {
  const [b, task] = activeTask(book, now)
  const [decided, verdict] = decide(b, task, fp, limits, now)
  if (verdict === null || b.passes <= 0) return [decided, verdict]
  // The person let one call through from the pane: this is it.
  const streaks = { ...b.streaks }
  delete streaks[task.id]
  return [{ ...b, passes: b.passes - 1, streaks, burnPausedUntil: now + BURN_PAUSE_MS }, null]
}

const decide = (b: Book, task: Task, fp: string, limits: Limits, now: number): [Book, Verdict | null] => {
  const leave = 'Leave this task: do not reopen it under another task. Tell the user it hit its budget, then open a task for the next task with the start_task tool (load it with ToolSearch if it is not listed), or stop.'

  const spent = sessionUsd(b)
  if (spent >= limits.sessionBudgetUsd) {
    return [b, {
      kind: 'session',
      short: `Session budget of ${money(limits.sessionBudgetUsd)} is spent. Agent stopped.`,
      reason: `The session budget of ${money(limits.sessionBudgetUsd)} is spent (${money(spent)}). Stop and report to the user.`,
    }]
  }
  if (task.status === 'halted') {
    return [b, {
      kind: 'halted',
      short: `Task "${task.name}" is halted. The agent has to move on.`,
      reason: `Task "${task.name}" is halted: ${task.haltReason ?? 'over budget'}. ${leave}`,
    }]
  }
  if (task.budgetUsd > 0 && task.usd >= task.budgetUsd) {
    const why = `${money(task.usd)} of its ${money(task.budgetUsd)} budget`
    const halted = withTask(b, task.id, k => ({ ...k, status: 'halted', haltReason: `spent ${why}` }))
    return [halted, {
      kind: 'budget',
      short: `"${task.name}" spent ${why}. Halted.`,
      reason: `Task "${task.name}" spent ${why} and is now halted. ${leave}`,
    }]
  }
  const streak = b.streaks[task.id]
  if (streak && streak.fp === fp && streak.n >= limits.loopLimit) {
    return [b, {
      kind: 'loop',
      short: `Same failing action ${streak.n} times in a row. Retry blocked.`,
      reason: `This exact action has failed ${streak.n} times in a row, so retrying it is blocked. Read the error, change the approach, or skip this step.`,
    }]
  }
  const rate = burnRate(b, now)
  if (rate > limits.burnLimitUsdPerMin && now >= b.burnPausedUntil) {
    return [{ ...b, burnPausedUntil: now + BURN_PAUSE_MS }, {
      kind: 'burn',
      short: `Burning ${money(rate)}/min, over the ${money(limits.burnLimitUsdPerMin)}/min limit. Paused.`,
      reason: `Spending ${money(rate)}/min, over the ${money(limits.burnLimitUsdPerMin)}/min limit. Work leaner before continuing: sample big files and outputs instead of reading them whole.`,
    }]
  }
  return [b, null]
}

export const addTrip = (book: Book, trip: Trip): Book => ({ ...book, trips: [...book.trips, trip].slice(-MAX_TRIPS) })

// A reply can carry a task past its budget between two tool calls. Halt it
// then, so the very next call is stopped and the overspend shows as a trip.
export const haltIfOver = (book: Book, now: number): Book => {
  const task = book.tasks.find(k => k.id === book.active)
  if (!task || task.status !== 'open' || !(task.budgetUsd > 0) || task.usd < task.budgetUsd) return book
  const why = `${money(task.usd)} of its ${money(task.budgetUsd)} budget`
  const halted = withTask(book, task.id, k => ({ ...k, status: 'halted', haltReason: `spent ${why}` }))
  return addTrip(halted, {
    at: now,
    kind: 'budget',
    task: task.name,
    taskId: task.id,
    tool: 'reply',
    summary: 'the reply that crossed the budget',
    reason: `"${task.name}" spent ${why}. Halted.`,
  })
}

// ---- what the person can do from the pane ----------------------------------

const resolveLatest = (book: Book, taskId: string | undefined, text: string): Book => {
  const index = [...book.trips].reverse().findIndex(t => t.resolved === undefined && (taskId === undefined || t.taskId === taskId))
  if (index < 0) return book
  const at = book.trips.length - 1 - index
  return { ...book, trips: book.trips.map((t, i) => (i === at ? { ...t, resolved: text } : t)) }
}

// Gives a task more budget; a task halted for its budget can carry on.
export const raiseBudget = (book: Book, taskId: string, by: number): Book => {
  const task = book.tasks.find(k => k.id === taskId)
  if (!task) return book
  const budgetUsd = Math.round((task.budgetUsd + by) * 100) / 100
  const lifted = withTask(book, taskId, k => ({
    ...k,
    budgetUsd,
    status: k.status === 'halted' ? (book.active === k.id ? 'open' : 'closed') : k.status,
    haltReason: k.status === 'halted' ? undefined : k.haltReason,
  }))
  return resolveLatest(lifted, taskId, `budget raised to ${money(budgetUsd)} by you`)
}

// Lets the next call through whatever circuit stands in its way, once.
export const allowOnce = (book: Book): Book =>
  resolveLatest({ ...book, passes: book.passes + 1, burnPausedUntil: 0 }, undefined, 'one call allowed by you')

// Stops the agent's work on a task: its next call is told to move on.
export const skipTask = (book: Book, taskId: string): Book => {
  const task = book.tasks.find(k => k.id === taskId)
  if (!task || task.id === GENERAL) return book
  const halted = withTask(book, taskId, k => ({ ...k, status: 'halted', haltReason: 'skipped by you' }))
  return resolveLatest(halted, taskId, 'task skipped by you')
}

// ---- the activity --------------------------------------------------------------

// Writes one entry into the ledger and keeps the task's counters and loop streak.
export const record = (book: Book, entry: Omit<Entry, 'task'>, fp: string): Book => {
  const [b, task] = activeTask(book, entry.at)
  const outcome: Outcome = entry.outcome
  const prior = b.streaks[task.id]
  const streak =
    outcome === 'ok' ? undefined
    : outcome === 'fail' ? (prior && prior.fp === fp ? { fp, n: prior.n + 1 } : { fp, n: 1 })
    : prior
  const streaks = { ...b.streaks }
  if (streak) streaks[task.id] = streak
  else delete streaks[task.id]

  // A blocked repeat is worth roughly one average call of this task.
  const perCall = task.calls > 0 ? task.usd / task.calls : 0
  const saved = outcome === 'blocked' ? b.saved + perCall : b.saved

  const counted = withTask(b, task.id, k => ({
    ...k,
    calls: outcome === 'blocked' ? k.calls : k.calls + 1,
    fails: outcome === 'fail' ? k.fails + 1 : k.fails,
    blocked: outcome === 'blocked' ? k.blocked + 1 : k.blocked,
  }))
  const entries = [...counted.entries, { ...entry, task: task.id }].slice(-MAX_ENTRIES)
  return { ...counted, entries, streaks, saved }
}

export const sessionUsd = (book: Book): number => book.tasks.reduce((sum, k) => sum + k.usd, 0)

export const summary = (book: Book, startedAt: number): SessionSummary => ({
  startedAt,
  usd: sessionUsd(book),
  tokens: book.tokens,
  tasks: book.tasks.map(k => ({ name: k.name, status: k.status, usd: k.usd, calls: k.calls })),
})

// ---- words and numbers -----------------------------------------------------

export const duration = (ms: number): string => {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const m = Math.floor(ms / 60_000)
  return m < 60 ? `${m}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

export const span = (minutes: number): string => {
  if (!Number.isFinite(minutes)) return 'never'
  const m = Math.max(0, Math.round(minutes))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d${h % 24}h`
}

export const compactTokens = (n: number): string => {
  if (n < 1_000) return String(Math.round(n))
  if (n < 100_000) return `${(n / 1_000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`
  if (n < 100_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  return `${Math.round(n / 1_000_000)}M`
}

const stamp = (ms: number) => {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 8)
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
const budgetText = (k: Task) => (k.budgetUsd > 0 ? money(k.budgetUsd) : 'none')
const taskName = (book: Book, id: string) => book.tasks.find(k => k.id === id)?.name ?? id
const agentName = (book: Book, id: string | undefined) => book.agents.find(a => a.id === (id ?? MAIN))?.name ?? 'main'
const pct = (x: number) => `${Math.round(x * 100)}%`

const taskTable = (book: Book): string[] => [
  '| Task | Status | Spent | Tokens | Budget | Calls | Fails | Blocked |',
  '|---|---|--:|--:|--:|--:|--:|--:|',
  ...book.tasks.map(k => `| ${cell(k.name)} | ${k.status} | ${money(k.usd)} | ${compactTokens(k.tokens)} | ${budgetText(k)} | ${k.calls} | ${k.fails} | ${k.blocked} |`),
]

const agentTable = (book: Book): string[] => [
  '| Agent | Model | Steps | Calls | Tokens | Cost (est.) | Cache hit |',
  '|---|---|--:|--:|--:|--:|--:|',
  ...book.agents.map(a => `| ${cell(a.name)} | ${a.model ?? ''} | ${a.steps} | ${a.calls} | ${compactTokens(a.tokens)} | ${money(a.usd)} | ${pct(cacheHit(a.mix))} |`),
]

const windowName = (kind: string) =>
  kind === 'five_hour' ? '5 hour window' : kind === 'seven_day' ? 'Weekly window' : kind === 'spend_limit' ? 'Spend limit' : kind

const limitLines = (book: Book, now: number): string[] =>
  book.rateLimits.map(w => {
    const r = runway(book, w.kind, now)
    const pace = r.state === 'runs-out' ? `, runs out in ${span(r.minutes)} at this pace` : r.state === 'lasts' ? ', lasts to its reset at this pace' : ''
    return `| ${windowName(w.kind)} | ${Math.max(0, 100 - w.percentUsed).toFixed(0)}% left${w.resetsAt ? `, resets ${stamp(Date.parse(w.resetsAt))}` : ''}${pace} |`
  })

const tripTable = (book: Book): string[] =>
  book.trips.length === 0
    ? ['No circuit trips.']
    : [
        '| Time | Circuit | Task | Action | What happened | Resolved |',
        '|---|---|---|---|---|---|',
        ...[...book.trips].reverse().map(t => `| ${clock(t.at)} | ${t.kind} | ${cell(t.task)} | ${cell(`${t.tool}: ${t.summary}`)} | ${cell(t.reason)} | ${cell(t.resolved ?? '')} |`),
      ]

// The short report /munim statement prints.
export const statement = (book: Book, limits: Limits, past: readonly SessionSummary[], file?: string): string => {
  const lines = ['## TokenMunim statement', '']
  if (book.tasks.length === 0) {
    lines.push('Nothing booked yet in this session.')
  } else {
    lines.push(
      `**Spent** ${money(sessionUsd(book))} of ${money(limits.sessionBudgetUsd)}  ·  **Tokens** ${compactTokens(book.tokens)} (cache hit ${pct(cacheHit(book.mix))})  ·  **Saved (est.)** ${money(book.saved)}  ·  **Circuit trips** ${book.trips.length}`,
      '',
      ...taskTable(book),
    )
    if (book.agents.length > 1) lines.push('', '### Agents', '', ...agentTable(book))
    if (book.trips.length > 0) lines.push('', '### Circuit trips', '', ...tripTable(book).slice(0, 12))
  }
  if (past.length > 0) {
    lines.push('', '### Earlier sessions', '', '| Started | Spent | Tasks |', '|---|--:|--:|')
    for (const s of past.slice(-5)) lines.push(`| ${stamp(s.startedAt)} | ${money(s.usd)} | ${s.tasks.length} |`)
  }
  if (file) lines.push('', `Full ledger: \`${file}\``)
  return lines.join('\n')
}

// The ledger file: the whole session's ledger, every entry, newest first.
export const ledgerMarkdown = (
  book: Book,
  meta: { startedAt: number; now: number; cwd?: string; limits: Limits },
): string => {
  const m = book.mix
  const lines = [
    '# TokenMunim ledger',
    '',
    `Session started ${stamp(meta.startedAt)}  ·  updated ${stamp(meta.now)}${meta.cwd ? `  ·  ${meta.cwd}` : ''}`,
    '',
    '## Summary',
    '',
    '| | |',
    '|---|--:|',
    `| Spent | ${money(sessionUsd(book))} of ${money(meta.limits.sessionBudgetUsd)} |`,
    `| Tokens | ${compactTokens(book.tokens)} |`,
    `| Token mix | input ${compactTokens(m.input)}, cache read ${compactTokens(m.cacheRead)}, cache write ${compactTokens(m.cacheWrite)}, output ${compactTokens(m.output)} |`,
    `| Cache hit | ${pct(cacheHit(m))} |`,
    ...limitLines(book, meta.now),
    `| Saved by the circuit breaker (est.) | ${money(book.saved)} |`,
    `| Tasks | ${book.tasks.length} |`,
    `| Agents | ${book.agents.length} |`,
    `| Tool calls | ${book.entries.filter(e => e.outcome !== 'blocked').length} |`,
    `| Circuit trips | ${book.trips.length} |`,
    '',
    '## Tasks',
    '',
    ...taskTable(book),
    '',
    '## Agents',
    '',
    ...(book.agents.length > 0 ? agentTable(book) : ['No replies booked yet.']),
    '',
    '## Circuit trips',
    '',
    ...tripTable(book),
    '',
    '## Activity',
    '',
    '| Time | Task | Agent | Tool | Action | Result | Took |',
    '|---|---|---|---|---|---|--:|',
    ...[...book.entries].reverse().map(e =>
      `| ${clock(e.at)} | ${cell(taskName(book, e.task))} | ${cell(agentName(book, e.agent))} | ${e.tool} | ${cell(e.summary)} | ${e.outcome === 'blocked' ? `blocked (${e.note ?? 'circuit'})` : e.outcome} | ${e.outcome === 'blocked' ? '' : duration(e.ms)} |`,
    ),
    '',
  ]
  return lines.join('\n')
}

// A task marker: any agent or script can open or close a task through a
// shell line, `munim:task <name> [budget]` or `munim:end`, even where the
// start_task tool is not listed. TokenMunim answers it; the shell never runs it.
export type Marker = { verb: 'task'; name: string; budgetUsd?: number } | { verb: 'end' }

export const parseMarker = (command: string): Marker | null => {
  const line = command.trim().replace(/^echo\s+/, '').replace(/^['"]|['"]$/g, '').trim()
  if (/^munim:end$/.test(line)) return { verb: 'end' }
  const m = /^munim:task\s+(.+?)(?:\s+\$?(\d+(?:\.\d+)?))?$/.exec(line)
  if (!m || !m[1]) return null
  const budget = m[2] === undefined ? undefined : Number(m[2])
  return budget === undefined ? { verb: 'task', name: m[1] } : { verb: 'task', name: m[1], budgetUsd: budget }
}
