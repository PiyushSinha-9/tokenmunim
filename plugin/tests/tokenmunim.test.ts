import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionUsage } from 'claude-code'

import { chartRows } from '../hooks/chart'
import {
  bookCost,
  bookTokens,
  burnRate,
  compactTokens,
  check,
  emptyBook,
  fingerprint,
  haltIfOver,
  limitsFrom,
  normalize,
  openKhata,
  parseMarker,
  record,
  setLimits,
  statement,
  summarize,
  tokenRate,
} from '../hooks/ledger'

const limits = limitsFrom({})

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

test('blocks the same failing action after the loop limit, lets a new one through', async ($, on) => {
  const { clock, state } = world(on)
  state.failing = true
  for (let i = 0; i < 3; i++) {
    const r = await $.tool.call({ tool: 'Bash', command: 'python fetch.py --since 20240101' })
    expect(denied(r)).toBe(false)
    await clock.advance(1_000)
  }
  const fourth = await $.tool.call({ tool: 'Bash', command: 'python fetch.py --since 20240102' })
  expect(denied(fourth)).toBe(true)
  expect(JSON.stringify(fourth)).toContain('loop')

  state.failing = false
  const other = await $.tool.call({ tool: 'Bash', command: 'python fix_symbols.py' })
  expect(denied(other)).toBe(false)
})

test('halts a khata over its budget and lets the next khata run', async ($, on) => {
  const { clock, state } = world(on)
  await $.tool.call({ tool: 'mcp__tokenmunim__open_khata', name: 'strategy 6', budget_usd: 0.5 })
  await $.tool.call({ tool: 'Read', file_path: 'a.csv' })
  state.usd = 0.6
  await clock.advance(600_000)
  const over = await $.tool.call({ tool: 'Read', file_path: 'b.csv' })
  expect(denied(over)).toBe(true)
  expect(JSON.stringify(over)).toContain('budget')

  await $.tool.call({ tool: 'mcp__tokenmunim__open_khata', name: 'strategy 7', budget_usd: 0.5 })
  const next = await $.tool.call({ tool: 'Read', file_path: 'c.csv' })
  expect(denied(next)).toBe(false)
})

test('never blocks the tool loader, so a halted agent can reach open_khata', async ($, on) => {
  const { clock, state } = world(on)
  await $.tool.call({ tool: 'mcp__tokenmunim__open_khata', name: 'tiny', budget_usd: 0.1 })
  await $.tool.call({ tool: 'Read', file_path: 'a.csv' })
  state.usd = 0.5
  await clock.advance(600_000)
  expect(denied(await $.tool.call({ tool: 'Read', file_path: 'b.csv' }))).toBe(true)
  expect(denied(await $.tool.call({ tool: 'ToolSearch', query: 'select:mcp__tokenmunim__open_khata' }))).toBe(false)
})

test('the general khata has no budget of its own', async ($, on) => {
  const { clock, state } = world(on)
  await $.tool.call({ tool: 'Read', file_path: 'a.csv' })
  state.usd = 3
  await clock.advance(600_000)
  expect(denied(await $.tool.call({ tool: 'Read', file_path: 'b.csv' }))).toBe(false)
})

test('pauses once on a burn spike, then lets work continue', async ($, on) => {
  const { clock, state } = world(on)
  await $.tool.call({ tool: 'mcp__tokenmunim__open_khata', name: 'research', budget_usd: 50 })
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
  const after = await $.tool.call({ tool: 'Read', file_path: 'sample.json' })
  expect(denied(after)).toBe(false)
})

test('spreads a cost reading over the time it was spent in', () => {
  let b = bookCost(emptyBook(), 0, 0)
  b = bookCost(b, 3, 600_000)
  // $3 over ten minutes is $0.30/min, not a $3 spike in the last bucket.
  expect(Math.abs(burnRate(b, 600_000) - 0.3)).toBeLessThan(0.001)
})

test('fingerprints fold timestamps so a retried loop is still one action', () => {
  expect(fingerprint('Bash', { command: 'curl api?ts=1712345678' })).toBe(fingerprint('Bash', { command: 'curl  api?ts=1712349999' }))
  expect(fingerprint('Bash', { command: 'ls a' })).not.toBe(fingerprint('Bash', { command: 'ls b' }))
})

test('the tape reads what a call was for, not its raw arguments', () => {
  expect(summarize('Bash', { command: 'S=/tmp/x; python3 run.py', description: 'Run the backtest' })).toBe('Run the backtest')
  expect(summarize('Read', { file_path: '/work/lab/data/nifty.csv' }, '/work/lab')).toBe('data/nifty.csv')
  expect(summarize('Read', { file_path: '/Users/me/a/b/c/d.ts' }, '/work', '/Users/me')).toBe('…/c/d.ts')
})

test('books cost to the open khata and writes a statement', () => {
  let b = openKhata(bookCost(emptyBook(), 0, 0), 'migrate billing', 2, 0)[0]
  b = bookCost(b, 0.75, 10_000)
  b = record(b, { at: 10_000, tool: 'Bash', summary: 'npm test', ms: 900, outcome: 'ok' }, 'Bash:npm test')
  const [, verdict] = check(b, 'Bash:npm test', limits, 300_000)
  expect(verdict).toBe(null)
  const text = statement(b, limits, [])
  expect(text).toContain('migrate billing')
  expect(text).toContain('$0.75')
})

test('an older book is brought up to date and its general khata un-halted', () => {
  const old = { khatas: [{ id: 'general', name: 'general', status: 'halted', usd: 1.2, budgetUsd: 1, calls: 4, fails: 0, blocked: 1, openedAt: 0 }], entries: [], active: 'general', lastUsd: 1.2, samples: [], streaks: {}, burnPausedUntil: 0, saved: 0 }
  const b = normalize(old as never)
  expect(b.v).toBe(3)
  expect(b.trips).toEqual([])
  expect(b.tokens).toBe(0)
  expect(b.khatas[0]?.tokens).toBe(0)
  expect(b.khatas[0]?.status).toBe('open')
  expect(b.khatas[0]?.budgetUsd).toBe(0)
})

test('the chart draws the limit as a line and colors bars over it', () => {
  const { rows, limitRow } = chartRows([0, 0.5, 3], 2, 4)
  const text = rows.map(r => r.map(run => run.text).join(''))
  expect(text[limitRow]).toContain('┈')
  expect(rows.flat().some(run => run.tone === 'hot')).toBe(true)
  expect(text.every(line => line.length === 3)).toBe(true)
})

test('the pane draws khatas, a halted khata, a circuit card and the tape on every surface', async ($, on) => {
  const { clock, state } = world(on)
  await $.tool.call({ tool: 'mcp__tokenmunim__open_khata', name: 'iron condor', budget_usd: 0.5 })
  await $.tool.call({ tool: 'Bash', command: 'python backtest.py', description: 'Backtest iron condor' })
  state.usd = 0.7
  await clock.advance(600_000)
  await $.tool.call({ tool: 'Bash', command: 'python backtest.py --adjust' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'tokenmunim',
      surface,
      component: 'Pane',
      requestId: 'tokenmunim',
      props: { title: 'TokenMunim', isFocused: false, bodyColumns: 66, placement: 'dock', scroll: { offset: 0, bodyRows: 44 } } as never,
      viewport: { columns: 155, rows: 46 },
    })
    expect(await ui.find({ type: 'Text', text: /T O K E N M U N I M/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /iron condor/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /halted/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /CIRCUIT TRIPPED/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Backtest iron condor/ })).toBeDefined()
    await ui.unmount()
  }
})

test('reads khata markers from a shell line', () => {
  expect(parseMarker('munim:khata iron condor 0.4')).toEqual({ verb: 'khata', name: 'iron condor', budgetUsd: 0.4 })
  expect(parseMarker("echo 'munim:khata short straddle'")).toEqual({ verb: 'khata', name: 'short straddle' })
  expect(parseMarker('munim:close')).toEqual({ verb: 'close' })
  expect(parseMarker('ls munim:khata')).toBe(null)
})

test('a marker opens a khata without running the shell', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('session.usage', async () => ({ value: { startedAt: 0, rateLimits: [], cost: { usd: 0 } } as unknown as SessionUsage }))
  let ran = 0
  on('tool.call', async () => {
    ran += 1
    return { result: 'ok' }
  })
  const r = await $.tool.call({ tool: 'Bash', command: 'munim:khata bull put spread 0.3' })
  expect(JSON.stringify(r)).toContain('bull put spread')
  expect(ran).toBe(0)
})

test('a halted task cannot be reopened under its own name', async ($, on) => {
  const { clock, state } = world(on)
  await $.tool.call({ tool: 'mcp__tokenmunim__open_khata', name: 'ratio spread', budget_usd: 0.3 })
  await $.tool.call({ tool: 'Read', file_path: 'a.py' })
  state.usd = 0.4
  await clock.advance(600_000)
  expect(denied(await $.tool.call({ tool: 'Edit', file_path: 'a.py' }))).toBe(true)
  const again = await $.tool.call({ tool: 'mcp__tokenmunim__open_khata', name: 'Ratio Spread', budget_usd: 0.3 })
  expect(JSON.stringify(again)).toContain('stays halted')
  expect(denied(await $.tool.call({ tool: 'Edit', file_path: 'a.py' }))).toBe(true)
})

test('opening the khata that is already open carries on with it', () => {
  const [b1, k1] = openKhata(emptyBook(), 'iron fly', 1, 0)
  const [b2, k2] = openKhata(b1, 'iron fly', 1, 10)
  expect(k2.id).toBe(k1.id)
  expect(b2.khatas.length).toBe(1)
})

test('books tokens per request to the open khata and measures tokens per minute', () => {
  let b = openKhata(emptyBook(), 'strategy 1', 1, 0)[0]
  b = bookTokens(b, 30_000, 30_000)
  b = bookTokens(b, 30_000, 60_000)
  expect(b.tokens).toBe(60_000)
  expect(b.khatas[0]?.tokens).toBe(60_000)
  // 60k tokens in the last two minutes is 30k a minute.
  expect(Math.round(tokenRate(b, 60_000))).toBe(30_000)
})

test('keeps the last plan limits the API reported', () => {
  const b = setLimits(emptyBook(), [{ kind: 'five_hour', percentUsed: 38, resetsAt: '2026-10-06T09:00:00Z' }, { kind: 'seven_day', percentUsed: 19 }])
  expect(b.rateLimits.map(w => w.kind)).toEqual(['five_hour', 'seven_day'])
  expect(setLimits(b, []).rateLimits.length).toBe(2)
})

test('writes token counts the way a person reads them', () => {
  expect(compactTokens(950)).toBe('950')
  expect(compactTokens(48_213)).toBe('48.2k')
  expect(compactTokens(482_000)).toBe('482k')
  expect(compactTokens(1_240_000)).toBe('1.24M')
})

test('a reply that carries a khata past its budget halts it before the next call', () => {
  let b = openKhata(bookCost(emptyBook(), 0, 0), 'strategy 6', 0.1, 0)[0]
  b = haltIfOver(bookCost(b, 0.14, 60_000), 60_000)
  expect(b.khatas[0]?.status).toBe('halted')
  expect(b.trips[b.trips.length - 1]?.kind).toBe('budget')
  expect(check(b, 'Write:REPORT.md', limits, 61_000)[1]?.kind).toBe('halted')
})
