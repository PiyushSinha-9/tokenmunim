// The munim's arithmetic: pure functions over a Book, so every rule is testable
// without a session. register.tsx wires them to events and draws them.

import type { Book, Entry, Khata, Outcome, RateWindow, Sample, SessionSummary, TokenSample, Trip, TripKind } from '../types'

export type Limits = {
  khataBudgetUsd: number
  sessionBudgetUsd: number
  loopLimit: number
  burnLimitUsdPerMin: number
}

export type Verdict = { kind: TripKind; reason: string; short: string }

export const GENERAL = 'general'
export const MAX_ENTRIES = 2000
export const MAX_TRIPS = 100
export const SAMPLE_KEEP_MS = 30 * 60_000
export const BURN_WINDOW_MS = 120_000
export const BURN_PAUSE_MS = 120_000

export const emptyBook = (): Book => ({
  v: 3,
  khatas: [],
  entries: [],
  trips: [],
  active: null,
  lastUsd: null,
  samples: [],
  tokens: 0,
  tokenSamples: [],
  rateLimits: [],
  streaks: {},
  burnPausedUntil: 0,
  saved: 0,
})

type OlderBook = Partial<Omit<Book, 'v' | 'khatas'>> & { v?: number; khatas?: (Omit<Khata, 'tokens'> & { tokens?: number })[] }

// Brings a book written by an older version up to this one. Version 2 took the
// budget off the general khata (lifting a budget halt on it); version 3 counts tokens.
export const normalize = (book: OlderBook | Book | undefined | null): Book => {
  if (book && book.v === 3) return book as Book
  const src: OlderBook = book ?? {}
  const base = { ...emptyBook(), ...src, v: 3 as const }
  return {
    ...base,
    trips: src.trips ?? [],
    tokens: src.tokens ?? 0,
    tokenSamples: src.tokenSamples ?? [],
    rateLimits: src.rateLimits ?? [],
    khatas: (src.khatas ?? []).map(k => {
      const counted: Khata = { ...k, tokens: k.tokens ?? 0 }
      return k.id === GENERAL && (src.v ?? 1) < 2
        ? { ...counted, budgetUsd: 0, status: src.active === GENERAL ? 'open' : 'closed', haltReason: undefined }
        : counted
    }),
  }
}

export const limitsFrom = (options: Readonly<Record<string, unknown>>): Limits => {
  const num = (key: string, fallback: number) => {
    const value = Number(options[key])
    return Number.isFinite(value) && value > 0 ? value : fallback
  }
  return {
    khataBudgetUsd: num('khataBudgetUsd', 1),
    sessionBudgetUsd: num('sessionBudgetUsd', 20),
    loopLimit: Math.max(2, Math.round(num('loopLimit', 3))),
    burnLimitUsdPerMin: num('burnLimitUsdPerMin', 2),
  }
}

const money = (n: number) => `$${n.toFixed(2)}`

const newKhata = (id: string, name: string, budgetUsd: number, now: number): Khata => ({
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

const withKhata = (book: Book, id: string, fn: (k: Khata) => Khata): Book => ({
  ...book,
  khatas: book.khatas.map(k => (k.id === id ? fn(k) : k)),
})

// The khata new work is booked to: the open one, else the general khata,
// which has no budget of its own and only answers to the session budget.
export const activeKhata = (book: Book, now: number): [Book, Khata] => {
  const open = book.khatas.find(k => k.id === book.active)
  if (open) return [book, open]
  const general = book.khatas.find(k => k.id === GENERAL)
  if (general) return [{ ...book, active: GENERAL }, general]
  const made = newKhata(GENERAL, 'general', 0, now)
  return [{ ...book, active: GENERAL, khatas: [...book.khatas, made] }, made]
}

export const haltedNamed = (book: Book, name: string): Khata | undefined =>
  book.khatas.find(k => k.status === 'halted' && k.name.toLowerCase() === name.toLowerCase())

export const openKhata = (book: Book, name: string, budgetUsd: number, now: number): [Book, Khata] => {
  // Opening the khata that is already open carries on with it.
  const current = book.khatas.find(k => k.id === book.active)
  if (current && current.status === 'open' && current.name === name) return [book, current]
  const closed = closeKhata(book)
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'khata'
  const id = `${slug}-${closed.khatas.length + 1}`
  const made = newKhata(id, name, budgetUsd, now)
  return [{ ...closed, active: id, khatas: [...closed.khatas, made] }, made]
}

export const closeKhata = (book: Book): Book => {
  if (book.active === null) return book
  const shut = withKhata(book, book.active, k => (k.status === 'open' ? { ...k, status: 'closed' } : k))
  return { ...shut, active: null }
}

// Books what the session spent since the last reading to the active khata.
export const bookCost = (book: Book, usd: number | undefined, now: number): Book => {
  if (usd === undefined) return book
  const samples = [...book.samples, { at: now, usd }].filter(s => now - s.at <= SAMPLE_KEEP_MS).slice(-800)
  if (book.lastUsd === null) return { ...book, lastUsd: usd, samples }
  const delta = Math.max(0, usd - book.lastUsd)
  const [withActive, khata] = activeKhata(book, now)
  const charged = withKhata(withActive, khata.id, k => ({ ...k, usd: k.usd + delta }))
  return { ...charged, lastUsd: usd, samples }
}

// What was spent between t0 and t1. A cost reading only arrives with the next
// tool call, so each delta is spread over the time it was really spent in;
// a long think followed by one call is not a spike.
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

// Books the tokens one model request used to the active khata and the session.
export const bookTokens = (book: Book, tokens: number, now: number): Book => {
  if (!(tokens > 0)) return book
  const [b, khata] = activeKhata(book, now)
  const total = b.tokens + tokens
  const first: TokenSample[] = b.tokenSamples.length === 0 ? [{ at: now - 1, n: b.tokens }] : []
  const tokenSamples = [...b.tokenSamples, ...first, { at: now, n: total }].filter(s => now - s.at <= SAMPLE_KEEP_MS).slice(-800)
  return { ...withKhata(b, khata.id, k => ({ ...k, tokens: k.tokens + tokens })), tokens: total, tokenSamples }
}

export const tokenRate = (book: Book, now: number): number => {
  const asSamples: Sample[] = book.tokenSamples.map(s => ({ at: s.at, usd: s.n }))
  return (spendBetween(asSamples, now - BURN_WINDOW_MS, now) / BURN_WINDOW_MS) * 60_000
}

export const setLimits = (book: Book, windows: readonly RateWindow[] | undefined): Book =>
  windows === undefined || windows.length === 0
    ? book
    : { ...book, rateLimits: windows.map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt })) }

export const compactTokens = (n: number): string => {
  if (n < 1_000) return String(Math.round(n))
  if (n < 100_000) return `${(n / 1_000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`
  if (n < 100_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  return `${Math.round(n / 1_000_000)}M`
}

// The burn chart's columns, oldest first, each the spend rate in USD per minute.
export const burnSeries = (book: Book, now: number, columns: number, bucketMs: number): number[] =>
  Array.from({ length: columns }, (_, i) => {
    const t1 = now - (columns - 1 - i) * bucketMs
    return (spendBetween(book.samples, t1 - bucketMs, t1) / bucketMs) * 60_000
  })

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

// The tape's words for a call: what it was for, not its raw arguments.
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

// The circuit breaker. Returns the book (a khata may be halted, a burn pause
// started) and a verdict when the call must not run.
export const check = (book: Book, fp: string, limits: Limits, now: number): [Book, Verdict | null] => {
  const [b, khata] = activeKhata(book, now)
  const reopen = 'Leave this task: do not reopen it under another khata. Tell the user it hit its budget, then open a khata for the next task with the open_khata tool (load it with ToolSearch if it is not listed), or stop.'

  const spent = sessionUsd(b)
  if (spent >= limits.sessionBudgetUsd) {
    return [b, {
      kind: 'session',
      short: `Session budget of ${money(limits.sessionBudgetUsd)} is spent. Agent stopped.`,
      reason: `The session budget of ${money(limits.sessionBudgetUsd)} is spent (${money(spent)}). Stop and report to the user.`,
    }]
  }
  if (khata.status === 'halted') {
    return [b, {
      kind: 'halted',
      short: `Khata "${khata.name}" is halted. Waiting for the next khata.`,
      reason: `Khata "${khata.name}" is halted: ${khata.haltReason ?? 'over budget'}. ${reopen}`,
    }]
  }
  if (khata.budgetUsd > 0 && khata.usd >= khata.budgetUsd) {
    const why = `${money(khata.usd)} of its ${money(khata.budgetUsd)} budget`
    const halted = withKhata(b, khata.id, k => ({ ...k, status: 'halted', haltReason: `spent ${why}` }))
    return [halted, {
      kind: 'budget',
      short: `"${khata.name}" spent ${why}. Halted.`,
      reason: `Khata "${khata.name}" spent ${why} and is now halted. ${reopen}`,
    }]
  }
  const streak = b.streaks[khata.id]
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

// A reply can carry a khata past its budget between two tool calls. Halt it
// then, so the very next call is stopped and the overspend shows as a trip.
export const haltIfOver = (book: Book, now: number): Book => {
  const khata = book.khatas.find(k => k.id === book.active)
  if (!khata || khata.status !== 'open' || !(khata.budgetUsd > 0) || khata.usd < khata.budgetUsd) return book
  const why = `${money(khata.usd)} of its ${money(khata.budgetUsd)} budget`
  const halted = withKhata(book, khata.id, k => ({ ...k, status: 'halted', haltReason: `spent ${why}` }))
  return addTrip(halted, { at: now, kind: 'budget', khata: khata.name, tool: 'reply', summary: 'the reply that crossed the budget', reason: `"${khata.name}" spent ${why}. Halted.` })
}

// Writes one entry into the bahi and keeps the khata's counters and loop streak.
export const record = (book: Book, entry: Omit<Entry, 'khata'>, fp: string): Book => {
  const [b, khata] = activeKhata(book, entry.at)
  const outcome: Outcome = entry.outcome
  const prior = b.streaks[khata.id]
  const streak =
    outcome === 'ok' ? undefined
    : outcome === 'fail' ? (prior && prior.fp === fp ? { fp, n: prior.n + 1 } : { fp, n: 1 })
    : prior
  const streaks = { ...b.streaks }
  if (streak) streaks[khata.id] = streak
  else delete streaks[khata.id]

  // A blocked repeat is worth roughly one average call of this khata.
  const perCall = khata.calls > 0 ? khata.usd / khata.calls : 0
  const saved = outcome === 'blocked' ? b.saved + perCall : b.saved

  const counted = withKhata(b, khata.id, k => ({
    ...k,
    calls: outcome === 'blocked' ? k.calls : k.calls + 1,
    fails: outcome === 'fail' ? k.fails + 1 : k.fails,
    blocked: outcome === 'blocked' ? k.blocked + 1 : k.blocked,
  }))
  const entries = [...counted.entries, { ...entry, khata: khata.id }].slice(-MAX_ENTRIES)
  return { ...counted, entries, streaks, saved }
}

export const sessionUsd = (book: Book): number => book.khatas.reduce((sum, k) => sum + k.usd, 0)

export const summary = (book: Book, startedAt: number): SessionSummary => ({
  startedAt,
  usd: sessionUsd(book),
  tokens: book.tokens,
  khatas: book.khatas.map(k => ({ name: k.name, status: k.status, usd: k.usd, calls: k.calls })),
})

export const duration = (ms: number): string => {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const m = Math.floor(ms / 60_000)
  return m < 60 ? `${m}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

const stamp = (ms: number) => {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 8)
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
const budgetText = (k: Khata) => (k.budgetUsd > 0 ? money(k.budgetUsd) : 'none')
const khataName = (book: Book, id: string) => book.khatas.find(k => k.id === id)?.name ?? id

const khataTable = (book: Book): string[] => [
  '| Khata | Status | Spent | Tokens | Budget | Calls | Fails | Blocked |',
  '|---|---|--:|--:|--:|--:|--:|--:|',
  ...book.khatas.map(k => `| ${cell(k.name)} | ${k.status} | ${money(k.usd)} | ${compactTokens(k.tokens)} | ${budgetText(k)} | ${k.calls} | ${k.fails} | ${k.blocked} |`),
]

const windowName = (kind: string) =>
  kind === 'five_hour' ? '5 hour window' : kind === 'seven_day' ? 'Weekly window' : kind === 'spend_limit' ? 'Spend limit' : kind

const limitLines = (book: Book): string[] =>
  book.rateLimits.map(w => `| ${windowName(w.kind)} | ${Math.max(0, 100 - w.percentUsed).toFixed(0)}% left${w.resetsAt ? `, resets ${stamp(Date.parse(w.resetsAt))}` : ''} |`)

const tripTable = (book: Book): string[] =>
  book.trips.length === 0
    ? ['No circuit trips.']
    : [
        '| Time | Circuit | Khata | Action | What happened |',
        '|---|---|---|---|---|',
        ...[...book.trips].reverse().map(t => `| ${clock(t.at)} | ${t.kind} | ${cell(t.khata)} | ${cell(`${t.tool}: ${t.summary}`)} | ${cell(t.reason)} |`),
      ]

// The short report /munim statement prints.
export const statement = (book: Book, limits: Limits, past: readonly SessionSummary[], file?: string): string => {
  const lines = ['## TokenMunim statement', '']
  if (book.khatas.length === 0) {
    lines.push('Nothing booked yet in this session.')
  } else {
    lines.push(
      `**Spent** ${money(sessionUsd(book))} of ${money(limits.sessionBudgetUsd)}  ·  **Tokens** ${compactTokens(book.tokens)}  ·  **Saved by the circuit breaker (est.)** ${money(book.saved)}  ·  **Circuit trips** ${book.trips.length}`,
      '',
      ...khataTable(book),
    )
    if (book.trips.length > 0) lines.push('', '### Circuit trips', '', ...tripTable(book).slice(0, 12))
  }
  if (past.length > 0) {
    lines.push('', '### Earlier sessions', '', '| Started | Spent | Khatas |', '|---|--:|--:|')
    for (const s of past.slice(-5)) lines.push(`| ${stamp(s.startedAt)} | ${money(s.usd)} | ${s.khatas.length} |`)
  }
  if (file) lines.push('', `Full bahi: \`${file}\``)
  return lines.join('\n')
}

// The bahi file: the whole session's ledger, every entry, newest first.
export const bahiMarkdown = (
  book: Book,
  meta: { startedAt: number; now: number; cwd?: string; limits: Limits },
): string => {
  const lines = [
    '# TokenMunim bahi',
    '',
    `Session started ${stamp(meta.startedAt)}  ·  updated ${stamp(meta.now)}${meta.cwd ? `  ·  ${meta.cwd}` : ''}`,
    '',
    '## Summary',
    '',
    '| | |',
    '|---|--:|',
    `| Spent | ${money(sessionUsd(book))} of ${money(meta.limits.sessionBudgetUsd)} |`,
    `| Tokens | ${compactTokens(book.tokens)} |`,
    ...limitLines(book),
    `| Saved by the circuit breaker (est.) | ${money(book.saved)} |`,
    `| Khatas | ${book.khatas.length} |`,
    `| Tool calls | ${book.entries.filter(e => e.outcome !== 'blocked').length} |`,
    `| Circuit trips | ${book.trips.length} |`,
    '',
    '## Khatas',
    '',
    ...khataTable(book),
    '',
    '## Circuit trips',
    '',
    ...tripTable(book),
    '',
    '## Tape',
    '',
    '| Time | Khata | Tool | Action | Result | Took |',
    '|---|---|---|---|---|--:|',
    ...[...book.entries].reverse().map(e =>
      `| ${clock(e.at)} | ${cell(khataName(book, e.khata))} | ${e.tool} | ${cell(e.summary)} | ${e.outcome === 'blocked' ? `blocked (${e.note ?? 'circuit'})` : e.outcome} | ${e.outcome === 'blocked' ? '' : duration(e.ms)} |`,
    ),
    '',
  ]
  return lines.join('\n')
}

// A khata marker: any agent or script can open or close a khata through a
// shell line, `munim:khata <name> [budget]` or `munim:close`, even where the
// open_khata tool is not listed. TokenMunim answers it; the shell never runs it.
export type Marker = { verb: 'khata'; name: string; budgetUsd?: number } | { verb: 'close' }

export const parseMarker = (command: string): Marker | null => {
  const line = command.trim().replace(/^echo\s+/, '').replace(/^['"]|['"]$/g, '').trim()
  if (/^munim:close$/.test(line)) return { verb: 'close' }
  const m = /^munim:khata\s+(.+?)(?:\s+\$?(\d+(?:\.\d+)?))?$/.exec(line)
  if (!m || !m[1]) return null
  const budget = m[2] === undefined ? undefined : Number(m[2])
  return budget === undefined ? { verb: 'khata', name: m[1] } : { verb: 'khata', name: m[1], budgetUsd: budget }
}
