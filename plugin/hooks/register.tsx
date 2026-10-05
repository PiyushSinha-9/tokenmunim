import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Book, Entry, Khata, SessionSummary } from '../types'
import { chartRows } from './chart'
import type { Tone } from './chart'
import {
  addTrip,
  bahiMarkdown,
  bookCost,
  bookTokens,
  burnRate,
  burnSeries,
  check,
  closeKhata,
  compactTokens,
  duration,
  emptyBook,
  fingerprint,
  haltIfOver,
  haltedNamed,
  limitsFrom,
  normalize,
  openKhata,
  parseMarker,
  record,
  sessionUsd,
  setLimits,
  statement,
  summarize,
  summary,
  tokenRate,
  toolLabel,
} from './ledger'
import type { Limits } from './ledger'

const PANE = 'tokenmunim'
const OWN = 'mcp__tokenmunim__'
// Tools the agent needs to get itself out of a halt are never blocked.
const EXEMPT = new Set(['ToolSearch'])
const BAHI_KEY = 'bahi'
const book = atom({ plugin: 'tokenmunim', key: 'book' } as const, emptyBook())

// The palette: a ledger's gold on a quiet ground, color only where it means something.
const GOLD = '#E8B04B'
const MUTED = '#9A9AA6'
const FAINT = '#62626E'
const BORDER = '#454552'
const TRACK = '#33333D'
const GREEN = '#4ADE80'
const AMBER = '#FBBF24'
const RED = '#F87171'
const RED_DIM = '#9E4B4B'
const RED_BG = '#3A1E22'
const GREEN_BG = '#1B3325'

const TONE: Record<Tone, string | undefined> = {
  calm: GOLD,
  warm: AMBER,
  hot: RED,
  axis: TRACK,
  limit: RED_DIM,
  blank: undefined,
}

const STATUS: Record<Khata['status'], { glyph: string; color: string }> = {
  open: { glyph: '●', color: GREEN },
  closed: { glyph: '○', color: FAINT },
  halted: { glyph: '■', color: RED },
}

const OUTCOME: Record<Entry['outcome'], { glyph: string; color: string }> = {
  ok: { glyph: '✓', color: GREEN },
  fail: { glyph: '✗', color: AMBER },
  blocked: { glyph: '⊘', color: RED },
}

const money = (n: number) => `$${n.toFixed(2)}`
const dollars = (n: number) => (Number.isInteger(n) ? `$${n}` : money(n))
const countdown = (ms: number) => {
  if (!(ms > 0)) return 'now'
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d${h % 24}h`
}
const WINDOW_LABEL: Record<string, string> = { five_hour: '5h', seven_day: 'week', spend_limit: 'spend' }
const clockTime = (ms: number) => new Date(ms).toTimeString().slice(0, 8)
const fit = (text: string, width: number) =>
  text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width)
const fileStamp = (ms: number) => {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

// Where this session's bahi lives, worked out once per load.
let limits: Limits = limitsFrom({})
let cwd: string | undefined
let home: string | undefined
let startedAt = 0
let bahiFile: string | undefined
let isAlerting = false

async function costNow($: EngineInterface) {
  return (await $.session.usage()).cost?.usd
}

async function locate($: EngineInterface) {
  if (bahiFile !== undefined) return
  try {
    startedAt = (await $.session.usage()).startedAt
    cwd = (await $.fs.stat('.', { resolve: true })).realPath
    home = await $.env.get('HOME')
    if (cwd) bahiFile = `${cwd}/.tokenmunim/bahi-${fileStamp(startedAt)}.md`
  } catch {
    // No file system here (a test, a remote host): the pane still works.
  }
}

// The bahi file is best effort: a failed write never gets in the agent's way.
async function writeBahi($: EngineInterface): Promise<string | undefined> {
  try {
    await locate($)
    if (bahiFile === undefined || cwd === undefined) return undefined
    const b = normalize(await read($, book))
    const now = await $.clock.now()
    await $.fs.write(`${cwd}/.tokenmunim/.gitignore`, '*\n')
    await $.fs.write(bahiFile, bahiMarkdown(b, { startedAt, now, cwd, limits }))
    return bahiFile
  } catch {
    return undefined
  }
}

async function openBahi($: EngineInterface) {
  const file = await writeBahi($)
  if (file !== undefined) await $.process.run(['open', file])
}

// One model request finished: book its tokens, and refresh cost and plan limits.
async function noteStep($: EngineInterface, tokens: number) {
  try {
    const now = await $.clock.now()
    const usage = await $.session.usage()
    await update($, book, b => haltIfOver(setLimits(bookCost(bookTokens(normalize(b), tokens, now), usage.cost?.usd, now), usage.rateLimits), now))
  } catch {
    // Accounting never gets in the way of the model's answer.
  }
}

// The status line is an alarm, not a ticker: it shows while a circuit is tripped.
function alarm($: EngineInterface, text: string | undefined) {
  if (text === undefined && !isAlerting) return
  isAlerting = text !== undefined
  $.ui.status(text)
}

export const register: Register = (on, options) => {
  limits = limitsFrom(options)

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'open_khata',
      description:
        'Open a khata (a cost account) for the task you are starting, so its cost, steps and failures are tracked on their own, with an optional budget. Call it when you begin each distinct task of a batch. The previous khata is closed. If a khata is halted by TokenMunim, open the next one to continue.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short name of the task, like "iron condor" or "migrate billing service".' },
          budget_usd: { type: 'number', description: 'Optional budget in USD for this khata.' },
        },
        required: ['name'],
      },
    })
    await $.tool.register({
      name: 'close_khata',
      description: 'Close the current khata when its task is done.',
    })
    await $.command.register({
      name: 'munim',
      description: 'TokenMunim: open the pane, or statement, bahi, export, khata <name>, close, reset',
      argumentHint: 'statement | bahi | export | khata <name> | close | reset',
    })
    await locate($)
    // A status line left by an earlier load is stale; the alarm starts quiet.
    $.ui.status(undefined)
    void $.ui.open({ id: PANE, title: 'TokenMunim' })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__tokenmunim__open_khata' }, async ($, e) => {
    const name = typeof e.name === 'string' && e.name.trim() !== '' ? e.name.trim() : 'task'
    const budget = typeof e.budget_usd === 'number' && e.budget_usd > 0 ? e.budget_usd : limits.khataBudgetUsd
    const now = await $.clock.now()
    const usd = await costNow($)
    const halted = haltedNamed(normalize(await read($, book)), name)
    if (halted !== undefined) {
      return { result: `Khata "${halted.name}" was halted (${halted.haltReason ?? 'over budget'}) and stays halted. Tell the user, and open a khata for a different task, or stop.` }
    }
    await update($, book, b => openKhata(bookCost(normalize(b), usd, now), name, budget, now)[0])
    alarm($, undefined)
    await writeBahi($)
    return { result: `Khata "${name}" is open with a budget of ${money(budget)}. Work for this task is now booked to it.` }
  })

  on('tool.call', { tool: 'mcp__tokenmunim__close_khata' }, async ($, e) => {
    const now = await $.clock.now()
    const usd = await costNow($)
    await update($, book, b => closeKhata(bookCost(normalize(b), usd, now)))
    await writeBahi($)
    return { result: 'Khata closed.' }
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (tool.startsWith(OWN) || EXEMPT.has(tool)) return next(e)

    const input = e as unknown as Readonly<Record<string, unknown>>
    const startedAtMs = await $.clock.now()
    const usage = await $.session.usage()
    const usd = usage.cost?.usd

    const marker = tool === 'Bash' && typeof input.command === 'string' ? parseMarker(input.command) : null
    if (marker !== null) {
      const said =
        marker.verb === 'close' ? 'Khata closed.' : `Khata "${marker.name}" is open with a budget of ${money(marker.budgetUsd ?? limits.khataBudgetUsd)}.`
      await update($, book, b => {
        const charged = bookCost(normalize(b), usd, startedAtMs)
        return marker.verb === 'close'
          ? closeKhata(charged)
          : openKhata(charged, marker.name, marker.budgetUsd ?? limits.khataBudgetUsd, startedAtMs)[0]
      })
      await writeBahi($)
      return { result: { stdout: said, stderr: '', interrupted: false }, text: said } as never
    }

    const fp = fingerprint(tool, input)
    const base = { at: startedAtMs, tool: toolLabel(tool), summary: summarize(tool, input, cwd, home) }

    let verdict: ReturnType<typeof check>[1] = null
    await update($, book, b => {
      const [checked, v] = check(setLimits(bookCost(normalize(b), usd, startedAtMs), usage.rateLimits), fp, limits, startedAtMs)
      verdict = v
      return checked
    })

    const stop = verdict as ReturnType<typeof check>[1]
    if (stop !== null) {
      await update($, book, b => {
        const cur = normalize(b)
        const khata = cur.khatas.find(k => k.id === cur.active)?.name ?? 'general'
        const blocked = record(cur, { ...base, ms: 0, outcome: 'blocked', note: stop.kind }, fp)
        return addTrip(blocked, { at: startedAtMs, kind: stop.kind, khata, tool: base.tool, summary: base.summary, reason: stop.short })
      })
      $.ui.toast(`⊘ TokenMunim: ${stop.short}`)
      alarm($, `circuit tripped · ${stop.kind} · ${stop.short}`)
      await writeBahi($)
      return { deny: `TokenMunim circuit breaker (${stop.kind}): ${stop.reason}` }
    }

    const ran = await next(e)
    const ms = (await $.clock.now()) - startedAtMs
    const outcome = ran.deny !== undefined || ran.isError === true ? 'fail' : 'ok'
    await update($, book, b => record(normalize(b), { ...base, ms, outcome }, fp))
    if (outcome === 'ok') alarm($, undefined)
    return ran
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const u = result.usage
    if (u) await noteStep($, u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    const usage = await $.session.usage()
    const b = await update($, book, cur => bookCost(normalize(cur), usage.cost?.usd, now))
    const saved = (await $.store.get(BAHI_KEY)) as SessionSummary[] | undefined
    const others = (saved ?? []).filter(s => s.startedAt !== usage.startedAt)
    await $.store.set(BAHI_KEY, [...others, summary(normalize(b), usage.startedAt)].slice(-50))
    await writeBahi($)
    return next(e)
  })

  on('command.run', { command: 'munim' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const now = await $.clock.now()

    if (verb === '' || verb === 'pane') {
      await $.ui.open({ id: PANE, title: 'TokenMunim' })
      return { text: 'TokenMunim pane is open.' }
    }
    if (verb === 'khata') {
      const name = rest.join(' ').trim() || 'task'
      const usd = await costNow($)
      await update($, book, b => openKhata(bookCost(normalize(b), usd, now), name, limits.khataBudgetUsd, now)[0])
      alarm($, undefined)
      await writeBahi($)
      return { text: `Khata "${name}" is open with a budget of ${money(limits.khataBudgetUsd)}.` }
    }
    if (verb === 'close') {
      await update($, book, b => closeKhata(normalize(b)))
      await writeBahi($)
      return { text: 'Khata closed.' }
    }
    if (verb === 'reset') {
      await update($, book, () => emptyBook())
      alarm($, undefined)
      return { text: 'TokenMunim book reset for this session.' }
    }
    if (verb === 'bahi' || verb === 'export' || verb === 'open') {
      const file = await writeBahi($)
      if (file === undefined) return { text: 'The bahi file could not be written here.' }
      if (verb !== 'export') await $.process.run(['open', file])
      return { text: `Bahi written to ${file}` }
    }

    const usage = await $.session.usage()
    const b = normalize(await update($, book, cur => bookCost(normalize(cur), usage.cost?.usd, now)))
    const saved = ((await $.store.get(BAHI_KEY)) as SessionSummary[] | undefined) ?? []
    const file = await writeBahi($)
    if (verb === 'statement') return { text: statement(b, limits, saved.filter(s => s.startedAt !== usage.startedAt), file) }
    return { text: `Unknown option "${verb}". Try: statement, bahi, export, khata <name>, close, reset.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    // A reload forgets where the bahi lives; find it again on the first draw.
    if (bahiFile === undefined) await locate($)
    const b = normalize(await read($, book))
    const now = await $.clock.now()

    const W = Math.max(48, e.props.bodyColumns)
    const inner = W - 2
    const C = inner - 4
    // The pane's own visible height, not the terminal's.
    const R = Math.max(26, e.props.scroll?.bodyRows ?? (e.viewport?.rows ?? 50) - 6)

    const spent = sessionUsd(b)
    const rate = burnRate(b, now)
    const tokensPerMin = tokenRate(b, now)
    const limit = limits.burnLimitUsdPerMin
    const rateColor = rate > limit ? RED : rate > limit * 0.6 ? AMBER : undefined
    const spentPct = Math.round((spent / limits.sessionBudgetUsd) * 100)
    const lastEntry = b.entries[b.entries.length - 1]
    const isLive = lastEntry !== undefined && now - lastEntry.at < 90_000
    const active = b.khatas.find(k => k.id === b.active)
    const blockedCount = b.entries.filter(en => en.outcome === 'blocked').length
    const hasFile = bahiFile !== undefined

    // Plan limits: the 5 hour and weekly windows, as much as is left of each.
    const plan = b.rateLimits.filter(w => w.kind === 'five_hour' || w.kind === 'seven_day')
    const windows = plan.length > 0 ? plan : b.rateLimits.filter(w => w.kind === 'spend_limit').slice(0, 1)

    // The KPI cards, four across where there is room.
    const cards = [
      { key: 'spent', label: 'SPENT', value: money(spent), color: undefined, caption: `${spentPct}% of ${dollars(limits.sessionBudgetUsd)}`, border: BORDER },
      { key: 'cost', label: 'COST/MIN', value: money(rate), color: rateColor, caption: `limit ${money(limit)}`, border: rate > limit ? RED : BORDER },
      { key: 'tokens', label: 'TOKENS/MIN', value: compactTokens(tokensPerMin), color: undefined, caption: `${compactTokens(b.tokens)} total`, border: BORDER },
      { key: 'saved', label: 'SAVED · EST', value: money(b.saved), color: GREEN, caption: `${blockedCount} blocked`, border: BORDER },
    ]
    const perRow = inner >= 60 ? 4 : 2
    const cw = Math.floor((inner - (perRow - 1)) / perRow)
    const cardRows = [cards.slice(0, perRow), cards.slice(perRow)].filter(row => row.length > 0)

    // The burn chart.
    const chartH = R >= 48 ? 4 : 3
    const gutter = 7
    const cols = Math.max(12, C - gutter - 1)
    const bucketMs = 20_000
    const chart = chartRows(burnSeries(b, now, cols, bucketMs), limit, chartH)
    const gutterLabel = (r: number) =>
      (r === chart.limitRow ? 'limit' : r === 0 ? money(chart.scale) : r === chartH - 1 ? '$0' : '').padEnd(gutter)

    // The last circuit trip.
    const trip = b.trips[b.trips.length - 1]
    const isFresh = trip !== undefined && now - trip.at < 10 * 60_000

    // Height. Minimums first (a 4 row tape, 3 khatas), then air at the top,
    // then up to 8 khatas, then air between sections, the rest to the tape.
    // Nothing grows past its frame, so a long session never floods the pane.
    const prevTrip = b.trips.length > 1 ? b.trips[b.trips.length - 2] : undefined
    const tripRows = trip ? (prevTrip ? 6 : 5) : 0
    const maxKhatas = Math.min(b.khatas.length, 8)
    const haltedRows = b.khatas.slice(-maxKhatas).filter(k => k.status === 'halted').length
    const base = 2 + 1 + 5 * cardRows.length + (chartH + 4) + tripRows + 4 + 1 + haltedRows + 4 + 1
    let room = R - base
    let khataShow = Math.min(maxKhatas, 3)
    room -= 4 + Math.max(1, khataShow)
    const topGap = room >= 2 ? 1 : 0
    room -= topGap * 2
    while (khataShow < maxKhatas && room > 0) {
      khataShow += 1
      room -= 1
    }
    const midGaps = trip ? 5 : 4
    const gap = room >= midGaps + 2 ? 1 : 0
    room -= gap * midGaps
    const tapeRows = Math.min(10, 4 + Math.max(0, room))

    const shownKhatas = b.khatas.slice(-Math.max(1, khataShow))
    const earlierKhatas = b.khatas.length - shownKhatas.length
    const BAR = 10
    const N = Math.max(8, C - 29 - BAR)
    const openCount = b.khatas.filter(k => k.status === 'open').length
    const closedCount = b.khatas.filter(k => k.status === 'closed').length
    const haltedCount = b.khatas.filter(k => k.status === 'halted').length

    const tape = b.entries.slice(-tapeRows).reverse()
    const earlierEntries = b.entries.length - tape.length
    const S = Math.max(8, C - 25)

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold color={GOLD}>◆ T O K E N M U N I M</Text>
          {hasFile && (
            <Box key="bahi-link">
              <Button key="open-bahi" plain label="bahi.md ↗" hover={{ color: GOLD, underline: true }} onPress={() => void openBahi($)} />
            </Box>
          )}
        </Box>
        <Box justifyContent="space-between">
          <Text color={FAINT}>  the munim for your AI agent</Text>
          <Text bold color={isLive ? GREEN : FAINT} backgroundColor={isLive ? GREEN_BG : undefined}>
            {isLive ? ' ● LIVE ' : ' ○ IDLE '}
          </Text>
        </Box>

        <Box marginTop={topGap}>
          <Text color={MUTED}>{'LIMITS LEFT  '}</Text>
          {windows.length === 0 && <Text color={FAINT}>show after the next reply</Text>}
          {windows.map((w, i) => {
            const left = Math.max(0, Math.min(100, 100 - w.percentUsed))
            const filled = Math.round((left / 100) * 8)
            const color = left >= 50 ? GREEN : left >= 20 ? AMBER : RED
            const resets = w.resetsAt ? countdown(Date.parse(w.resetsAt) - now) : ''
            return (
              <Box key={`limit-${w.kind}`} marginRight={i < windows.length - 1 ? 3 : 0}>
                <Text color={MUTED}>{`${WINDOW_LABEL[w.kind] ?? w.kind} `}</Text>
                <Text color={color}>{'━'.repeat(filled)}</Text>
                <Text color={TRACK}>{'━'.repeat(8 - filled)}</Text>
                <Text bold color={color}>{` ${Math.round(left)}%`}</Text>
                <Text color={FAINT}>{resets ? ` ↻${resets}` : ''}</Text>
              </Box>
            )
          })}
        </Box>

        <Box marginTop={topGap} flexDirection="column">
          {cardRows.map((row, r) => (
            <Box key={`cards-${r}`} gap={1}>
              {row.map((c, i) => {
                const w = i === row.length - 1 ? inner - (perRow - 1) - cw * (perRow - 1) : cw
                return (
                  <Box key={`card-${c.key}`} width={w} flexDirection="column" borderStyle="round" borderColor={c.border} paddingX={1}>
                    <Text color={MUTED}>{fit(c.label, w - 4)}</Text>
                    <Text bold color={c.color}>{c.value}</Text>
                    <Text color={FAINT}>{fit(c.caption, w - 4)}</Text>
                  </Box>
                )
              })}
            </Box>
          ))}
        </Box>

        <Box marginTop={gap} flexDirection="column" borderStyle="round" borderColor={BORDER} paddingX={1}>
          <Box justifyContent="space-between">
            <Text bold color={GOLD}>BURN RATE</Text>
            <Text color={MUTED}>{`${money(rate)}/min · ${compactTokens(tokensPerMin)} tokens/min`}</Text>
          </Box>
          {chart.rows.map((runs, r) => (
            <Box key={`chart-${r}`}>
              {runs.map(run => (
                <Text color={TONE[run.tone]}>{run.text}</Text>
              ))}
              <Text color={r === chart.limitRow ? RED_DIM : FAINT}>{` ${gutterLabel(r)}`}</Text>
            </Box>
          ))}
          <Box width={cols} justifyContent="space-between">
            <Text color={FAINT}>{`${Math.round((cols * bucketMs) / 60_000)}m ago`}</Text>
            <Text color={FAINT}>now</Text>
          </Box>
        </Box>

        {trip !== undefined && (
          <Box marginTop={gap} flexDirection="column" borderStyle="round" borderColor={isFresh ? RED : BORDER} paddingX={1}>
            <Box justifyContent="space-between">
              <Box>
                <Text bold color={RED}>{isFresh ? '⊘ CIRCUIT TRIPPED ' : '⊘ LAST CIRCUIT TRIP '}</Text>
                <Text bold color={RED} backgroundColor={RED_BG}>{` ${trip.kind.toUpperCase()} `}</Text>
              </Box>
              <Text color={FAINT}>{`${b.trips.length > 1 ? `${b.trips.length} trips · ` : ''}${clockTime(trip.at)}`}</Text>
            </Box>
            <Text>{fit(trip.reason, C)}</Text>
            <Text color={FAINT}>{fit(`${trip.khata} · ${trip.tool} · ${trip.summary}`, C)}</Text>
            {prevTrip !== undefined && (
              <Box>
                <Text color={FAINT}>{'before  '}</Text>
                <Text color={RED_DIM}>{`⊘ ${prevTrip.kind.toUpperCase()} `}</Text>
                <Text color={FAINT}>{fit(`${clockTime(prevTrip.at)} · ${prevTrip.khata} · ${prevTrip.reason}`, Math.max(8, C - 12 - prevTrip.kind.length))}</Text>
              </Box>
            )}
          </Box>
        )}

        <Box marginTop={gap} flexDirection="column" borderStyle="round" borderColor={BORDER} paddingX={1}>
          <Box justifyContent="space-between">
            <Text bold color={GOLD}>KHATAS</Text>
            <Text color={MUTED}>
              {`${openCount} open · ${closedCount} closed${haltedCount > 0 ? ` · ${haltedCount} halted` : ''}`}
            </Text>
          </Box>
          <Text color={FAINT}>
            {`  ${'KHATA'.padEnd(N)} ${'SPENT'.padStart(7)} ${'TOKENS'.padStart(6)} ${'BUDGET'.padEnd(BAR)} ${'USED'.padStart(4)} ${'CALLS'.padStart(5)}`}
          </Text>
          {b.khatas.length === 0 && <Text color={FAINT}>  No khata yet. Work books to "general" until one opens.</Text>}
          {earlierKhatas > 0 && <Text color={FAINT}>{`  + ${earlierKhatas} earlier in bahi.md`}</Text>}
          {shownKhatas.map(k => {
            const s = STATUS[k.status]
            const hasBudget = k.budgetUsd > 0
            const ratio = hasBudget ? k.usd / k.budgetUsd : 0
            const filled = Math.min(BAR, Math.round(Math.min(1, ratio) * BAR))
            const barColor = k.status === 'halted' || ratio >= 1 ? RED : ratio >= 0.75 ? AMBER : GOLD
            const nameColor = k.status === 'closed' ? MUTED : k.status === 'halted' ? RED : undefined
            return (
              <Box key={`k-${k.id}`} flexDirection="column">
                <Box>
                  <Text color={s.color}>{`${s.glyph} `}</Text>
                  <Text bold={k.id === b.active} color={nameColor}>{fit(k.name, N)}</Text>
                  <Text color={k.status === 'halted' ? RED : undefined}>{` ${money(k.usd).padStart(7)}`}</Text>
                  <Text color={MUTED}>{` ${compactTokens(k.tokens).padStart(6)} `}</Text>
                  {hasBudget && <Text color={barColor}>{'━'.repeat(filled)}</Text>}
                  {hasBudget && <Text color={TRACK}>{'━'.repeat(BAR - filled)}</Text>}
                  {hasBudget && <Text color={ratio >= 1 ? RED : MUTED}>{` ${String(Math.round(ratio * 100)).padStart(3)}%`}</Text>}
                  {!hasBudget && <Text color={FAINT}>{`${'no limit'.padEnd(BAR)}     `}</Text>}
                  <Text color={MUTED}>{` ${String(k.calls).padStart(5)}`}</Text>
                </Box>
                {k.status === 'halted' && <Text color={RED}>{fit(`  └ halted · ${k.haltReason ?? 'over budget'}`, C)}</Text>}
              </Box>
            )
          })}
        </Box>

        <Box marginTop={gap} flexDirection="column" borderStyle="round" borderColor={BORDER} paddingX={1}>
          <Box justifyContent="space-between">
            <Text bold color={GOLD}>TAPE</Text>
            <Text color={MUTED}>{`${b.entries.length} entries · newest first`}</Text>
          </Box>
          {tape.length === 0 && <Text color={FAINT}>Waiting for the first step…</Text>}
          {tape.map((en, i) => {
            const o = OUTCOME[en.outcome]
            const isBlocked = en.outcome === 'blocked'
            return (
              <Box key={`t-${en.at}-${i}`}>
                <Text color={FAINT}>{`${clockTime(en.at)} `}</Text>
                <Text color={o.color}>{`${o.glyph} `}</Text>
                <Text bold color={isBlocked ? RED : undefined}>{fit(en.tool, 6)}</Text>
                <Text color={isBlocked ? RED : MUTED}>{` ${fit(isBlocked ? `circuit · ${en.note ?? ''} · ${en.summary}` : en.summary, S)}`}</Text>
                <Text color={FAINT}>{` ${(isBlocked ? '' : duration(en.ms)).padStart(6)}`}</Text>
              </Box>
            )
          })}
          {earlierEntries > 0 && <Text color={FAINT}>{`+ ${earlierEntries} earlier entries in bahi.md`}</Text>}
        </Box>

        <Box marginTop={gap} justifyContent="space-between">
          <Text color={FAINT}>/munim statement · /munim bahi</Text>
          {active !== undefined && <Text color={MUTED}>{`▸ ${active.name.slice(0, Math.max(8, inner - 34))}`}</Text>}
        </Box>
      </Box>
    )
  })
}
