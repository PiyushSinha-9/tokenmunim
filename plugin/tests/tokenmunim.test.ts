import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionUsage } from 'claude-code'

import { chartRows } from '../hooks/chart'
import {
  allowOnce,
  bookCost,
  bookTokens,
  burnRate,
  cacheHit,
  check,
  compactTokens,
  emptyBook,
  fingerprint,
  haltIfOver,
  limitsFrom,
  nameAgents,
  normalize,
  startTask,
  parseMarker,
  raiseBudget,
  record,
  runway,
  setLimits,
  skipTask,
  statement,
  summarize,
  tokenRate,
} from '../hooks/ledger'
import type { Usage } from '../hooks/ledger'
import { migrateView } from '../hooks/pane'

const limits = limitsFrom({})
const usage = (input: number, cacheRead: number, cacheWrite: number, output: number): Usage => ({
  input_tokens: input,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  output_tokens: output,
  model: 'claude-test',
})

// The world beneath the plugin: a clock, a store, a cost ledger moved by
// hand, and tools that fail while `failing` is set.
function world(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const state = { usd: 0, failing: false }
  on('session.usage', async () => ({ value: { startedAt: 0, rateLimits: [], cost: { usd: state.usd } } as unknown as SessionUsage }))
  on('tool.call', async () => (state.failing ? { isError: true as const, result: 'boom', text: 'boom' } : { result: 'ok' }))
  return { clock, state }
}

const denied = (r: unknown) => JSON.stringify(r).includes('TokenMunim circuit breaker')
const PANE = {
  plugin: 'tokenmunim',
  component: 'Pane' as const,
  requestId: 'tokenmunim',
  props: { title: 'TokenMunim', isFocused: false, bodyColumns: 66, placement: 'dock', scroll: { offset: 0, bodyRows: 60 } } as never,
  viewport: { columns: 155, rows: 66 },
}

// ---- the circuit breaker, end to end ----------------------------------------

test('blocks the same failing action after the loop limit, lets a new one through', async ($, on) => {
  const { clock, state } = world(on)
  state.failing = true
  for (let i = 0; i < 3; i++) {
    expect(denied(await $.tool.call({ tool: 'Bash', command: 'python fetch.py --since 20240101' }))).toBe(false)
    await clock.advance(1_000)
  }
  const fourth = await $.tool.call({ tool: 'Bash', command: 'python fetch.py --since 20240102' })
  expect(denied(fourth)).toBe(true)
  expect(JSON.stringify(fourth)).toContain('loop')

  state.failing = false
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'python fix_symbols.py' }))).toBe(false)
})

test('halts a task over its budget and lets the next task run', async ($, on) => {
  const { clock, state } = world(on)
  await $.tool.call({ tool: 'mcp__tokenmunim__start_task', name: 'strategy 6', budget_usd: 0.5 })
  await $.tool.call({ tool: 'Read', file_path: 'a.csv' })
  state.usd = 0.6
  await clock.advance(600_000)
  const over = await $.tool.call({ tool: 'Read', file_path: 'b.csv' })
  expect(denied(over)).toBe(true)
  expect(JSON.stringify(over)).toContain('budget')

  await $.tool.call({ tool: 'mcp__tokenmunim__start_task', name: 'strategy 7', budget_usd: 0.5 })
  expect(denied(await $.tool.call({ tool: 'Read', file_path: 'c.csv' }))).toBe(false)
})

test('never blocks the tool loader, so a halted agent can reach start_task', async ($, on) => {
  const { clock, state } = world(on)
  await $.tool.call({ tool: 'mcp__tokenmunim__start_task', name: 'tiny', budget_usd: 0.1 })
  await $.tool.call({ tool: 'Read', file_path: 'a.csv' })
  state.usd = 0.5
  await clock.advance(600_000)
  expect(denied(await $.tool.call({ tool: 'Read', file_path: 'b.csv' }))).toBe(true)
  expect(denied(await $.tool.call({ tool: 'ToolSearch', query: 'select:mcp__tokenmunim__start_task' }))).toBe(false)
})

test('the general task has no budget of its own', async ($, on) => {
  const { clock, state } = world(on)
  await $.tool.call({ tool: 'Read', file_path: 'a.csv' })
  state.usd = 3
  await clock.advance(600_000)
  expect(denied(await $.tool.call({ tool: 'Read', file_path: 'b.csv' }))).toBe(false)
})

test('pauses once on a burn spike, then lets work continue', async ($, on) => {
  const { clock, state } = world(on)
  await $.tool.call({ tool: 'mcp__tokenmunim__start_task', name: 'research', budget_usd: 50 })
  await $.tool.call({ tool: 'Read', file_path: 'small.txt' })
  await clock.advance(30_000)
  state.usd = 2.5
  await $.tool.call({ tool: 'Read', file_path: 'huge.json' })
  await clock.advance(30_000)
  state.usd = 5
  const spike = await $.tool.call({ tool: 'Read', file_path: 'huge.json' })
  expect(denied(spike)).toBe(true)
  expect(JSON.stringify(spike)).toContain('burn')

  await clock.advance(1_000)
  expect(denied(await $.tool.call({ tool: 'Read', file_path: 'sample.json' }))).toBe(false)
})

test('a halted task cannot be reopened under its own name', async ($, on) => {
  const { clock, state } = world(on)
  await $.tool.call({ tool: 'mcp__tokenmunim__start_task', name: 'ratio spread', budget_usd: 0.3 })
  await $.tool.call({ tool: 'Read', file_path: 'a.py' })
  state.usd = 0.4
  await clock.advance(600_000)
  expect(denied(await $.tool.call({ tool: 'Edit', file_path: 'a.py' }))).toBe(true)
  const again = await $.tool.call({ tool: 'mcp__tokenmunim__start_task', name: 'Ratio Spread', budget_usd: 0.3 })
  expect(JSON.stringify(again)).toContain('stays halted')
  expect(denied(await $.tool.call({ tool: 'Edit', file_path: 'a.py' }))).toBe(true)
})

test('a marker opens a task without running the shell', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('session.usage', async () => ({ value: { startedAt: 0, rateLimits: [], cost: { usd: 0 } } as unknown as SessionUsage }))
  let ran = 0
  on('tool.call', async () => {
    ran += 1
    return { result: 'ok' }
  })
  const r = await $.tool.call({ tool: 'Bash', command: 'munim:task bull put spread 0.3' })
  expect(JSON.stringify(r)).toContain('bull put spread')
  expect(ran).toBe(0)
})

// ---- the rules, one by one ----------------------------------------------------

test('spreads a cost reading over the time it was spent in', () => {
  let b = bookCost(emptyBook(), 0, 0)
  b = bookCost(b, 3, 600_000)
  // $3 over ten minutes is $0.30/min, not a $3 spike in the last bucket.
  expect(Math.abs(burnRate(b, 600_000) - 0.3)).toBeLessThan(0.001)
})

test('a reply that carries a task past its budget halts it before the next call', () => {
  let b = startTask(bookCost(emptyBook(), 0, 0), 'strategy 6', 0.1, 0)[0]
  b = haltIfOver(bookCost(b, 0.14, 60_000), 60_000)
  expect(b.tasks[0]?.status).toBe('halted')
  expect(b.trips[b.trips.length - 1]?.kind).toBe('budget')
  expect(check(b, 'Write:REPORT.md', limits, 61_000)[1]?.kind).toBe('halted')
})

test('raising the budget lifts a budget halt and marks the trip resolved', () => {
  let b = startTask(bookCost(emptyBook(), 0, 0), 'strategy 6', 0.1, 0)[0]
  b = haltIfOver(bookCost(b, 0.14, 60_000), 60_000)
  const id = b.tasks[0]?.id ?? ''
  b = raiseBudget(b, id, 0.1)
  expect(b.tasks[0]?.status).toBe('open')
  expect(b.tasks[0]?.budgetUsd).toBe(0.2)
  expect(b.trips[b.trips.length - 1]?.resolved).toContain('raised')
  expect(check(b, 'Write:REPORT.md', limits, 61_000)[1]).toBe(null)
})

test('allow once lets exactly one call through a tripped circuit', () => {
  let b = startTask(bookCost(emptyBook(), 0, 0), 'fetch', 5, 0)[0]
  for (let i = 0; i < 3; i++) b = record(b, { at: i, tool: 'Bash', summary: 'fetch', ms: 1, outcome: 'fail' }, 'Bash:fetch')
  expect(check(b, 'Bash:fetch', limits, 10)[1]?.kind).toBe('loop')
  b = allowOnce(b)
  const [after, verdict] = check(b, 'Bash:fetch', limits, 10)
  expect(verdict).toBe(null)
  expect(after.passes).toBe(0)
})

test('skipping a task halts its task so the agent moves on', () => {
  let b = startTask(emptyBook(), 'strategy 4', 1, 0)[0]
  const id = b.tasks[0]?.id ?? ''
  b = skipTask(b, id)
  expect(b.tasks[0]?.status).toBe('halted')
  expect(check(b, 'Bash:x', limits, 10)[1]?.reason).toContain('skipped by you')
})

test('books tokens per request to the open task and its loop', () => {
  let b = startTask(emptyBook(), 'strategy 1', 1, 0)[0]
  b = bookTokens(b, usage(1_000, 25_000, 2_000, 2_000), 30_000)
  b = bookTokens(b, usage(1_000, 25_000, 2_000, 2_000), 60_000, 'agent-7')
  expect(b.tokens).toBe(60_000)
  expect(b.tasks[0]?.tokens).toBe(60_000)
  expect(b.agents.map(a => a.id)).toEqual(['main', 'agent-7'])
  expect(b.agents[1]?.tokens).toBe(30_000)
  // 60k tokens in the last two minutes is 30k a minute.
  expect(Math.round(tokenRate(b, 60_000))).toBe(30_000)
  // 50k of 56k input tokens came from the cache.
  expect(Math.round(cacheHit(b.mix) * 100)).toBe(89)
})

test('books cost to the loop whose reply brought it, and names subagents', () => {
  let b = bookCost(emptyBook(), 0, 0)
  b = bookCost(b, 0.3, 10_000, 'agent-7')
  b = bookCost(b, 0.5, 20_000)
  b = nameAgents(b, [{ id: 'agent-7', description: 'Backtest strategy 3', type: 'general-purpose', status: 'completed' }])
  const sub = b.agents.find(a => a.id === 'agent-7')
  expect(Math.abs((sub?.usd ?? 0) - 0.3)).toBeLessThan(1e-9)
  expect(sub?.name).toBe('Backtest strategy 3')
  expect(Math.abs((b.agents.find(a => a.id === 'main')?.usd ?? 0) - 0.2)).toBeLessThan(1e-9)
})

test('the limit runway says whether this pace makes it to the reset', () => {
  const resetsAt = new Date(3 * 3_600_000).toISOString()
  let b = setLimits(emptyBook(), [{ kind: 'five_hour', percentUsed: 50, resetsAt }], 0)
  b = setLimits(b, [{ kind: 'five_hour', percentUsed: 60, resetsAt }], 600_000)
  // 10 points in 10 minutes: 40 points left last 40 minutes, before a reset 2h50m away.
  const r = runway(b, 'five_hour', 600_000)
  expect(r.state).toBe('runs-out')
  expect(r.state === 'runs-out' ? Math.round(r.minutes) : 0).toBe(40)
  const calm = setLimits(setLimits(emptyBook(), [{ kind: 'seven_day', percentUsed: 10, resetsAt }], 0), [{ kind: 'seven_day', percentUsed: 10.5, resetsAt }], 600_000)
  expect(runway(calm, 'seven_day', 600_000).state).toBe('lasts')
  expect(runway(setLimits(emptyBook(), [{ kind: 'five_hour', percentUsed: 5 }], 0), 'five_hour', 0).state).toBe('measuring')
})

test('fingerprints fold timestamps so a retried loop is still one action', () => {
  expect(fingerprint('Bash', { command: 'curl api?ts=1712345678' })).toBe(fingerprint('Bash', { command: 'curl  api?ts=1712349999' }))
  expect(fingerprint('Bash', { command: 'ls a' })).not.toBe(fingerprint('Bash', { command: 'ls b' }))
})

test('the activity reads what a call was for, not its raw arguments', () => {
  expect(summarize('Bash', { command: 'S=/tmp/x; python3 run.py', description: 'Run the backtest' })).toBe('Run the backtest')
  expect(summarize('Read', { file_path: '/work/lab/data/nifty.csv' }, '/work/lab')).toBe('data/nifty.csv')
  expect(summarize('Read', { file_path: '/Users/me/a/b/c/d.ts' }, '/work', '/Users/me')).toBe('…/c/d.ts')
})

test('books cost to the open task and writes a statement', () => {
  let b = startTask(bookCost(emptyBook(), 0, 0), 'migrate billing', 2, 0)[0]
  b = bookCost(b, 0.75, 10_000)
  b = record(b, { at: 10_000, tool: 'Bash', summary: 'npm test', ms: 900, outcome: 'ok' }, 'Bash:npm test')
  expect(check(b, 'Bash:npm test', limits, 300_000)[1]).toBe(null)
  const text = statement(b, limits, [])
  expect(text).toContain('migrate billing')
  expect(text).toContain('$0.75')
})

test('an older book is brought up to date and its general task un-halted', () => {
  const v1 = { khatas: [{ id: 'general', name: 'general', status: 'halted', usd: 1.2, budgetUsd: 1, calls: 4, fails: 0, blocked: 1, openedAt: 0 }], entries: [], active: 'general', lastUsd: 1.2, samples: [], streaks: {}, burnPausedUntil: 0, saved: 0 }
  const b = normalize(v1 as never)
  expect(b.v).toBe(6)
  expect(b.trips).toEqual([])
  expect(b.agents).toEqual([])
  expect(b.mix.cacheRead).toBe(0)
  expect(b.tasks[0]?.status).toBe('open')
  expect(b.tasks[0]?.budgetUsd).toBe(0)
})

test('a book from before plain words keeps its tasks, activity and trips', () => {
  const v4 = {
    v: 4,
    khatas: [{ id: 'strategy-6-1', name: 'strategy 6', status: 'halted', usd: 0.14, tokens: 163_000, budgetUsd: 0.1, calls: 2, fails: 0, blocked: 1, openedAt: 0 }],
    entries: [{ at: 1, khata: 'strategy-6-1', tool: 'Write', summary: 'REPORT.md', ms: 0, outcome: 'blocked', note: 'budget' }],
    trips: [{ at: 1, kind: 'budget', khata: 'strategy 6', khataId: 'strategy-6-1', tool: 'Write', summary: 'REPORT.md', reason: 'over' }],
    active: 'strategy-6-1', lastUsd: 0.14, samples: [], tokens: 163_000, tokenSamples: [], rateLimits: [], streaks: {}, burnPausedUntil: 0, saved: 0,
  }
  const b = normalize(v4 as never)
  expect(b.v).toBe(6)
  expect(b.tasks[0]?.name).toBe('strategy 6')
  expect(b.entries[0]?.task).toBe('strategy-6-1')
  expect(b.trips[0]?.task).toBe('strategy 6')
  expect(b.trips[0]?.taskId).toBe('strategy-6-1')
  expect(JSON.stringify(b)).not.toContain('khata')
})

test('a saved view with the old tab and section names opens on the new ones', () => {
  const v = migrateView({ tab: 'khatas', folded: ['tape'], opened: ['khatas'], khata: 'strategy-6-1', entry: null })
  expect(v.tab).toBe('tasks')
  expect(v.folded).toEqual(['activity'])
  expect(v.opened).toEqual(['tasks'])
  expect(v.task).toBe('strategy-6-1')
  expect(migrateView({ tab: 'trips' }).tab).toBe('alerts')
  expect(migrateView(undefined).tab).toBe('overview')
})

test('the chart draws the limit as a line and colors bars over it', () => {
  const { rows, limitRow } = chartRows([0, 0.5, 3], 2, 4)
  const text = rows.map(r => r.map(run => run.text).join(''))
  expect(text[limitRow]).toContain('┈')
  expect(rows.flat().some(run => run.tone === 'hot')).toBe(true)
  expect(text.every(line => line.length === 3)).toBe(true)
})

test('writes token counts the way a person reads them', () => {
  expect(compactTokens(950)).toBe('950')
  expect(compactTokens(48_213)).toBe('48.2k')
  expect(compactTokens(482_000)).toBe('482k')
  expect(compactTokens(1_240_000)).toBe('1.24M')
})

test('reads task markers from a shell line', () => {
  expect(parseMarker('munim:task iron condor 0.4')).toEqual({ verb: 'task', name: 'iron condor', budgetUsd: 0.4 })
  expect(parseMarker("echo 'munim:task short straddle'")).toEqual({ verb: 'task', name: 'short straddle' })
  expect(parseMarker('munim:end')).toEqual({ verb: 'end' })
  expect(parseMarker('ls munim:task')).toBe(null)
})

// ---- the pane -----------------------------------------------------------------

async function busySession($: Parameters<Parameters<typeof test>[1]>[0], on: On) {
  const { clock, state } = world(on)
  await $.tool.call({ tool: 'mcp__tokenmunim__start_task', name: 'iron condor', budget_usd: 0.5 })
  await $.tool.call({ tool: 'Bash', command: 'python backtest.py', description: 'Backtest iron condor' })
  state.usd = 0.7
  await clock.advance(600_000)
  await $.tool.call({ tool: 'Bash', command: 'python backtest.py --adjust' })
  return { clock, state }
}

test('the overview draws the tasks, a halted task and the circuit card on every surface', async ($, on) => {
  await busySession($ as never, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^Munim$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /iron condor/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /halted/ })).toBeDefined()
    expect(await ui.find({ key: 'fold-mix' })).toBeDefined()
    // The alert waits, folded, behind its notification pill.
    expect(await ui.find({ type: 'Text', text: /1 new/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /CIRCUIT TRIPPED/ })).toBeUndefined()
    await ui.press({ key: 'fold-alerts' })
    expect(await ui.find({ type: 'Text', text: /CIRCUIT TRIPPED/ })).toBeDefined()
    await ui.press({ key: 'fold-alerts' })
    await ui.unmount()
  }
})

test('tabs switch the view, and a task opens its own activity', async ($, on) => {
  await busySession($ as never, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-btn-activity' })
    expect(await ui.find({ type: 'Text', text: /Backtest iron condor/ })).toBeDefined()
    await ui.press({ key: 'tab-btn-tasks' })
    expect(await ui.find({ type: 'Text', text: /^total$/ })).toBeDefined()
    await ui.press({ key: 'drill-iron-condor-1' })
    expect(await ui.find({ type: 'Text', text: /ACTIVITY/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /task/ })).toBeDefined()
    await ui.press({ key: 'clear-filter' })
    await ui.press({ key: 'tab-btn-overview' })
    await ui.unmount()
  }
})

test('the circuit card raises a budget, and the halted task carries on', async ($, on) => {
  await busySession($ as never, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'fold-alerts' })
  await ui.press({ key: 'trip-latest-raise-btn' })
  expect(await ui.find({ type: 'Text', text: /budget raised to/ })).toBeDefined()
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'python backtest.py --again' }))).toBe(false)
  await ui.unmount()
})

test('the circuit card lets one call through a loop', async ($, on) => {
  const { clock, state } = world(on)
  state.failing = true
  for (let i = 0; i < 3; i++) {
    await $.tool.call({ tool: 'Bash', command: 'python fetch.py' })
    await clock.advance(1_000)
  }
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'python fetch.py' }))).toBe(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'fold-alerts' })
  await ui.press({ key: 'trip-latest-allow-btn' })
  expect(await ui.find({ type: 'Text', text: /one call allowed/ })).toBeDefined()
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'python fetch.py' }))).toBe(false)
  await ui.unmount()
})

test('every tab draws at narrow, medium and wide widths on every surface', async ($, on) => {
  await busySession($ as never, on)
  for (const width of [40, 52, 66, 96]) {
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface, props: { ...(PANE.props as object), bodyColumns: width, scroll: { offset: 0, bodyRows: 40 } } as never })
      for (const tab of ['tasks', 'activity', 'alerts', 'agents', 'overview']) {
        await ui.press({ key: `tab-btn-${tab}` })
        expect(await ui.find({ type: 'Text', text: /^Munim$/ })).toBeDefined()
      }
      await ui.unmount()
    }
  }
})

// ---- clicking through the pane, the way a person does ---------------------------

// Eight tasks, a budget trip on the last one, and a activity long enough to trim.
async function crowdedSession($: Parameters<Parameters<typeof test>[1]>[0], on: On) {
  const { clock, state } = world(on)
  for (let i = 1; i <= 7; i++) {
    await $.tool.call({ tool: 'mcp__tokenmunim__start_task', name: `strategy ${i}`, budget_usd: 5 })
    await $.tool.call({ tool: 'Bash', command: `python run.py ${i}`, description: `Backtest strategy ${i}` })
    state.usd += 0.02
    await clock.advance(5_000)
  }
  await $.tool.call({ tool: 'mcp__tokenmunim__start_task', name: 'strategy 8', budget_usd: 0.05 })
  await $.tool.call({ tool: 'Bash', command: 'python run.py 8', description: 'Backtest strategy 8' })
  state.usd += 0.2
  await clock.advance(5_000)
  const blocked = await $.tool.call({ tool: 'Bash', command: 'python run.py 8 --adjust', description: 'Adjust strategy 8' })
  expect(denied(blocked)).toBe(true)
  return { clock, state }
}

const at = (surface: 'terminal' | 'desktop', columns: number, rows: number) => ({
  ...PANE,
  surface,
  props: { ...(PANE.props as object), bodyColumns: columns, scroll: { offset: 0, bodyRows: rows } } as never,
})

// What each section shows only while it is open.
const BODY: Record<string, RegExp> = { burn: /m ago$/, mix: /No replies booked yet|cache read/, tasks: /USED/, activity: /Backtest strategy 8/, alerts: /CIRCUIT TRIP/ }

test('every section opens and folds on the first press, even one the pane folded to fit', async ($, on) => {
  await crowdedSession($ as never, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const [columns, rows] of [[66, 30], [66, 38], [66, 60], [46, 34]] as const) {
      const ui = await $.ui.mount(at(surface, columns, rows))
      for (const id of ['burn', 'mix', 'tasks', 'activity', 'alerts']) {
        for (let press = 0; press < 2; press++) {
          const label = String((await ui.find({ key: `fold-${id}` }))?.props.label ?? '')
          const wasFolded = label.startsWith('▸')
          expect((await ui.find({ type: 'Text', text: BODY[id] })) !== undefined).toBe(!wasFolded)
          await ui.press({ key: `fold-${id}` })
          const now = String((await ui.find({ key: `fold-${id}` }))?.props.label ?? '')
          expect(now.startsWith(wasFolded ? '▾' : '▸')).toBe(true)
          expect((await ui.find({ type: 'Text', text: BODY[id] })) !== undefined).toBe(wasFolded)
        }
      }
      await ui.unmount()
    }
  }
})

test('a section the person opened stays open when the pane is short of room', async ($, on) => {
  await crowdedSession($ as never, on)
  const ui = await $.ui.mount(at('terminal', 66, 30))
  const activityLabel = String((await ui.find({ key: 'fold-activity' }))?.props.label ?? '')
  expect(activityLabel.startsWith('▸')).toBe(true)
  await ui.press({ key: 'fold-activity' })
  expect(await ui.find({ type: 'Text', text: BODY.activity })).toBeDefined()
  await ui.unmount()
  // Drawn again, as after the next tool call: still open.
  const again = await $.ui.mount(at('terminal', 66, 30))
  expect(await again.find({ type: 'Text', text: BODY.activity })).toBeDefined()
  await again.unmount()
})

test('each tab shows its own content on every surface', async ($, on) => {
  await crowdedSession($ as never, on)
  const only: Record<string, RegExp> = { tasks: /^total$/, activity: /newest first/, agents: /tokens exact/, overview: /COST\/MIN/ }
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(at(surface, 66, 44))
    for (const tab of ['tasks', 'activity', 'alerts', 'agents', 'overview']) {
      await ui.press({ key: `tab-btn-${tab}` })
      expect(await ui.find({ key: `tab-btn-${tab}` })).toBeUndefined()
      for (const [other, mark] of Object.entries(only)) {
        expect((await ui.find({ type: 'Text', text: mark })) !== undefined).toBe(other === tab)
      }
      if (tab === 'alerts') expect(await ui.find({ type: 'Text', text: /CIRCUIT/ })).toBeDefined()
    }
    await ui.unmount()
  }
})

test('a task opens its own activity, and show all brings the rest back', async ($, on) => {
  await crowdedSession($ as never, on)
  const ui = await $.ui.mount(at('terminal', 66, 44))
  await ui.press({ key: 'tab-btn-tasks' })
  await ui.press({ key: 'drill-strategy-3-3' })
  expect(await ui.find({ type: 'Text', text: /newest first/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Backtest strategy 3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Backtest strategy 4/ })).toBeUndefined()
  await ui.press({ key: 'clear-filter' })
  expect(await ui.find({ type: 'Text', text: /Backtest strategy 4/ })).toBeDefined()
  await ui.unmount()
})

test('a call on the activity opens its details and closes again', async ($, on) => {
  await crowdedSession($ as never, on)
  const ui = await $.ui.mount(at('terminal', 66, 44))
  await ui.press({ key: 'tab-btn-activity' })
  expect(await ui.find({ type: 'Text', text: /blocked by the budget circuit/ })).toBeUndefined()
  await ui.press({ key: 'open-8' })
  expect(await ui.find({ type: 'Text', text: /blocked by the budget circuit/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /strategy 8/ })).toBeDefined()
  await ui.press({ key: 'open-8' })
  expect(await ui.find({ type: 'Text', text: /blocked by the budget circuit/ })).toBeUndefined()
  await ui.unmount()
})

test('skip task on a loop halts the task and the agent is told to move on', async ($, on) => {
  const { clock, state } = world(on)
  await $.tool.call({ tool: 'mcp__tokenmunim__start_task', name: 'chain data', budget_usd: 5 })
  state.failing = true
  for (let i = 0; i < 3; i++) {
    await $.tool.call({ tool: 'Bash', command: 'python fetch.py' })
    await clock.advance(1_000)
  }
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'python fetch.py' }))).toBe(true)
  const ui = await $.ui.mount(at('terminal', 66, 44))
  await ui.press({ key: 'fold-alerts' })
  await ui.press({ key: 'trip-latest-skip-btn' })
  expect(await ui.find({ type: 'Text', text: /task skipped by you/ })).toBeDefined()
  state.failing = false
  const next = await $.tool.call({ tool: 'Bash', command: 'python other.py' })
  expect(JSON.stringify(next)).toContain('skipped by you')
  await ui.unmount()
})

test('an old alert is reworded in plain words when its ledger loads', () => {
  const v5 = { v: 5, tasks: [], entries: [], trips: [{ at: 1, kind: 'halted', task: 'x', taskId: 'x-1', tool: 'Bash', summary: 's', reason: 'Khata "x" is halted. Waiting for the next khata.' }], agents: [], active: null, lastUsd: null, samples: [], tokens: 0, tokenSamples: [], mix: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, rateLimits: [], limitSamples: {}, streaks: {}, burnPausedUntil: 0, passes: 0, saved: 0 }
  expect(normalize(v5 as never).trips[0]?.reason).toBe('Task "x" is halted. Waiting for the next task.')
})

test('a halted task counts once in the alerts badge, however many alerts it raised', async ($, on) => {
  const { clock, state } = world(on)
  await $.tool.call({ tool: 'mcp__tokenmunim__start_task', name: 'tiny', budget_usd: 0.05 })
  await $.tool.call({ tool: 'Read', file_path: 'a.csv' })
  state.usd = 0.2
  await clock.advance(5_000)
  expect(denied(await $.tool.call({ tool: 'Read', file_path: 'b.csv' }))).toBe(true)
  await clock.advance(5_000)
  expect(denied(await $.tool.call({ tool: 'Read', file_path: 'c.csv' }))).toBe(true)
  const ui = await $.ui.mount(at('terminal', 66, 44))
  expect(await ui.find({ type: 'Text', text: /1 new/ })).toBeDefined()
  await ui.unmount()
})

test('every number on screen is a fact: calls stopped, not money saved', async ($, on) => {
  await crowdedSession($ as never, on)
  const ui = await $.ui.mount(at('terminal', 66, 44))
  expect(await ui.find({ type: 'Text', text: /^STOPPED$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /calls blocked/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /SAVED/ })).toBeUndefined()
  await ui.unmount()
})
