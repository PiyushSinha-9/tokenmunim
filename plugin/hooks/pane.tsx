// The pane: pure drawing from a book and a view. Every handler it wires comes
// in through `act`, so this file never touches the engine itself. Every row is
// laid out for the width it actually has: columns drop out in a fixed order as
// the pane narrows, and nothing is ever padded past its frame.

import type { AgentLedger, Book, Entry, Khata, Tab, Trip, View } from '../types'
import { chartRows } from './chart'
import type { Tone } from './chart'
import {
  burnRate,
  burnSeries,
  cacheHit,
  compactTokens,
  duration,
  GENERAL,
  MAIN,
  mixTotal,
  money,
  runway,
  sessionUsd,
  span,
  tokenRate,
} from './ledger'
import type { Limits } from './ledger'

// The element constructors of the surface being drawn on.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Kit = { Box: any; Text: any; Button: any }

export type PaneActions = {
  setTab: (tab: Tab) => void
  // `isFolded` is how the section is drawn now, which may be the pane's own doing.
  toggle: (section: string, isFolded: boolean) => void
  drill: (khataId: string | null) => void
  expand: (index: number | null) => void
  openBahi: () => void
  raise: (khataId: string, by: number) => void
  allow: () => void
  skip: (khataId: string) => void
}

export type PaneData = {
  book: Book
  view: View
  now: number
  limits: Limits
  width: number
  rows: number
  hasFile: boolean
}

export const DEFAULT_VIEW: View = { tab: 'overview', folded: ['tape'], opened: [], khata: null, entry: null }

// The palette: a ledger's gold on a quiet ground, color only where it means something.
const GOLD = '#E8B04B'
const GOLD_BG = '#3A2F1A'
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
const BLUE = '#60A5FA'
const TEAL = '#34D399'
const VIOLET = '#A78BFA'

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

const WINDOW_LABEL: Record<string, string> = { five_hour: '5h', seven_day: 'week', spend_limit: 'spend' }

// `cut` shortens text to fit; `pad` also fills a table column to its width.
const cut = (text: string, width: number) =>
  width <= 0 ? '' : text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text
const pad = (text: string, width: number) => cut(text, width).padEnd(Math.max(0, width))
const lpad = (text: string, width: number) => cut(text, width).padStart(Math.max(0, width))
const clockTime = (ms: number, short = false) => new Date(ms).toTimeString().slice(0, short ? 5 : 8)
const dollars = (n: number) => (Number.isInteger(n) ? `$${n}` : money(n))
const pct = (x: number) => `${Math.round(x * 100)}%`
const hit = (x: number) => (x >= 0.995 && x < 1 ? `${(x * 100).toFixed(1)}%` : pct(x))
const countdown = (ms: number) => (ms > 0 ? span(ms / 60_000) : 'now')
const fill = (ratio: number, width: number) => Math.max(0, Math.min(width, Math.round(Math.max(0, Math.min(1, ratio)) * width)))

// A step to raise a halted khata by: half its budget, at least five cents.
export const raiseStep = (k: Khata) => Math.max(0.05, Math.round(k.budgetUsd * 50) / 100)

const isActionable = (trip: Trip | undefined): trip is Trip => trip !== undefined && trip.resolved === undefined

export function drawPane(kit: Kit, d: PaneData, act: PaneActions) {
  const { Box, Text, Button } = kit
  const { book: b, view, now, limits } = d
  const W = Math.max(30, d.width)
  const inner = W - 2
  // Inside a card: its border and its padding take two cells a side.
  const C = inner - 4
  const wide = C >= 56
  const narrow = C < 44
  const R = Math.max(24, d.rows)

  const trip = b.trips[b.trips.length - 1]
  const active = b.khatas.find(k => k.id === b.active)
  const lastEntry = b.entries[b.entries.length - 1]
  const isLive = lastEntry !== undefined && now - lastEntry.at < 90_000

  // ---- shared pieces -------------------------------------------------------

  const link = (key: string, label: string, onPress: () => void, dim = false) => (
    <Box key={`${key}-box`}>
      <Button key={key} plain dimColor={dim} label={label} hover={{ color: GOLD, underline: true }} onPress={onPress} />
    </Box>
  )

  const badge = (text: string, color: string, bg?: string) => (
    <Text bold color={color} backgroundColor={bg}>{` ${text} `}</Text>
  )

  const card = (key: string, children: unknown, border: string = BORDER, marginTop = 0) => (
    <Box key={key} flexDirection="column" marginTop={marginTop} borderStyle="round" borderColor={border} paddingX={1}>
      {children}
    </Box>
  )

  const section = (
    id: string,
    title: string,
    right: string,
    isFolded: boolean,
    body: unknown,
    marginTop: number,
    rightColor: string = MUTED,
  ) =>
    card(
      `sec-${id}`,
      [
        <Box key={`sec-${id}-head`} justifyContent="space-between">
          <Box key={`fold-${id}-box`}>
            <Button key={`fold-${id}`} plain label={`${isFolded ? '▸' : '▾'} ${title}`} hover={{ color: GOLD, underline: true }} onPress={() => act.toggle(id, isFolded)} />
          </Box>
          <Text color={rightColor}>{cut(right, Math.max(0, C - title.length - 3))}</Text>
        </Box>,
        isFolded ? null : body,
      ],
      BORDER,
      marginTop,
    )

  // ---- header and tabs -----------------------------------------------------

  const header = (
    <Box key="header" flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold color={GOLD}>{inner >= 34 ? '◆ T O K E N M U N I M' : '◆ TOKENMUNIM'}</Text>
        {d.hasFile && link('open-bahi', 'bahi.md ↗', act.openBahi)}
      </Box>
      <Box justifyContent="space-between">
        <Text color={FAINT}>{cut('  the munim for your AI agent', inner - 10)}</Text>
        {isLive ? badge('● LIVE', GREEN, GREEN_BG) : <Text bold color={FAINT}> ○ IDLE </Text>}
      </Box>
    </Box>
  )

  const agentCount = Math.max(1, b.agents.length)
  const tabDefs: { id: Tab; long: string; short: string; n?: number }[] = [
    { id: 'overview', long: 'Overview', short: 'Home' },
    { id: 'khatas', long: 'Khatas', short: 'Khatas', n: b.khatas.length },
    { id: 'tape', long: 'Tape', short: 'Tape', n: b.entries.length },
    { id: 'trips', long: 'Trips', short: 'Trips', n: b.trips.length },
    { id: 'agents', long: 'Agents', short: 'Agents', n: agentCount },
  ]
  // The richest tab labels that fit on one line.
  const variants: { counts: boolean; short: boolean; gap: number }[] = [
    { counts: true, short: false, gap: 3 },
    { counts: true, short: false, gap: 2 },
    { counts: false, short: false, gap: 2 },
    { counts: false, short: true, gap: 2 },
    { counts: false, short: true, gap: 1 },
  ]
  const labelOf = (t: (typeof tabDefs)[number], v: (typeof variants)[number]) =>
    `${v.short ? t.short : t.long}${v.counts && t.n !== undefined ? ` ${t.n}` : ''}`
  const chosen =
    variants.find(v => tabDefs.reduce((w, t) => w + labelOf(t, v).length, 0) + v.gap * (tabDefs.length - 1) <= inner) ??
    variants[variants.length - 1]!
  let x = 0
  let start = 0
  let length = 0
  for (const t of tabDefs) {
    const label = labelOf(t, chosen)
    if (t.id === view.tab) {
      start = x
      length = label.length
    }
    x += label.length + chosen.gap
  }
  const tabBar = (
    <Box key="tabs" flexDirection="column" marginTop={1}>
      <Box>
        {tabDefs.map((t, i) => (
          <Box key={`tab-${t.id}`} marginRight={i < tabDefs.length - 1 ? chosen.gap : 0}>
            <Button key={`tab-btn-${t.id}`} plain dimColor={view.tab !== t.id} label={labelOf(t, chosen)} hover={{ color: GOLD }} onPress={() => act.setTab(t.id)} />
          </Box>
        ))}
      </Box>
      <Box>
        <Text color={TRACK}>{'─'.repeat(Math.min(start, inner))}</Text>
        <Text color={GOLD}>{'━'.repeat(Math.min(length, Math.max(0, inner - start)))}</Text>
        <Text color={TRACK}>{'─'.repeat(Math.max(0, inner - start - length))}</Text>
      </Box>
    </Box>
  )

  const footerLeft = inner >= 52 ? '/munim statement · /munim bahi' : '/munim'
  const footer = (gap: number) => (
    <Box key="footer" marginTop={gap} justifyContent="space-between">
      <Text color={FAINT}>{footerLeft}</Text>
      {active !== undefined && <Text color={MUTED}>{cut(`▸ ${active.name}`, Math.max(0, inner - footerLeft.length - 2))}</Text>}
    </Box>
  )

  // ---- the plan limits -----------------------------------------------------

  const plan = b.rateLimits.filter(w => w.kind === 'five_hour' || w.kind === 'seven_day')
  const windows = plan.length > 0 ? plan : b.rateLimits.filter(w => w.kind === 'spend_limit').slice(0, 1)
  const showPace = inner >= 43
  const limitBarW = Math.max(4, inner - (showPace ? 39 : 26))
  const limitsBlock = (marginTop: number) => (
    <Box key="limits" flexDirection="column" marginTop={marginTop}>
      {windows.length === 0 && (
        <Box>
          <Text color={MUTED}>{'LIMITS  '}</Text>
          <Text color={FAINT}>{cut('plan limits show after the next reply', inner - 8)}</Text>
        </Box>
      )}
      {windows.map(w => {
        const left = Math.max(0, Math.min(100, 100 - w.percentUsed))
        const color = left >= 50 ? GREEN : left >= 20 ? AMBER : RED
        const resetMs = w.resetsAt ? Date.parse(w.resetsAt) - now : NaN
        const r = runway(b, w.kind, now)
        const filled = fill(left / 100, limitBarW)
        const pace =
          r.state === 'runs-out' ? { text: `⚠ out in ${span(r.minutes)}`, color: r.minutes < 30 ? RED : AMBER }
          : r.state === 'lasts' ? { text: '✓ lasts', color: GREEN }
          : r.state === 'steady' ? { text: '✓ steady', color: GREEN }
          : { text: '· measuring', color: FAINT }
        return (
          <Box key={`limit-${w.kind}`}>
            <Text color={MUTED}>{pad(WINDOW_LABEL[w.kind] ?? w.kind, 6)}</Text>
            <Text color={color}>{'━'.repeat(filled)}</Text>
            <Text color={TRACK}>{'━'.repeat(limitBarW - filled)}</Text>
            <Text bold color={color}>{pad(` ${String(Math.round(left)).padStart(3)}% left`, 10)}</Text>
            <Text color={FAINT}>{pad(`  ↻ ${Number.isNaN(resetMs) ? '?' : countdown(resetMs)}`, 10)}</Text>
            {showPace && <Text color={pace.color}>{cut(pace.text, 13)}</Text>}
          </Box>
        )
      })}
    </Box>
  )

  // ---- the numbers ---------------------------------------------------------

  const spent = sessionUsd(b)
  const rate = burnRate(b, now)
  const tokensPerMin = tokenRate(b, now)
  const limit = limits.burnLimitUsdPerMin
  const rateColor = rate > limit ? RED : rate > limit * 0.6 ? AMBER : undefined
  const blockedCount = b.entries.filter(en => en.outcome === 'blocked').length
  const cards = [
    { key: 'spent', label: 'SPENT', value: money(spent), color: undefined, caption: `${Math.round((spent / limits.sessionBudgetUsd) * 100)}% of ${dollars(limits.sessionBudgetUsd)}`, border: BORDER },
    { key: 'cost', label: 'COST/MIN', value: money(rate), color: rateColor, caption: `limit ${money(limit)}`, border: rate > limit ? RED : BORDER },
    { key: 'tokens', label: 'TOKENS/MIN', value: compactTokens(tokensPerMin), color: undefined, caption: `${compactTokens(b.tokens)} total`, border: BORDER },
    { key: 'saved', label: 'SAVED · EST', value: money(b.saved), color: GREEN, caption: `${blockedCount} blocked`, border: BORDER },
  ]
  const perRow = inner >= 60 ? 4 : 2
  const cw = Math.floor((inner - (perRow - 1)) / perRow)
  const cardRows = [cards.slice(0, perRow), cards.slice(perRow)].filter(row => row.length > 0)
  const cardsBlock = (marginTop: number) => (
    <Box key="cards" flexDirection="column" marginTop={marginTop}>
      {cardRows.map((row, r) => (
        <Box key={`cards-${r}`} gap={1}>
          {row.map((c, i) => {
            const w = i === row.length - 1 ? inner - (perRow - 1) - cw * (perRow - 1) : cw
            return (
              <Box key={`card-${c.key}`} width={w} flexDirection="column" borderStyle="round" borderColor={c.border} paddingX={1}>
                <Text color={MUTED}>{cut(c.label, w - 4)}</Text>
                <Text bold color={c.color}>{cut(c.value, w - 4)}</Text>
                <Text color={FAINT}>{cut(c.caption, w - 4)}</Text>
              </Box>
            )
          })}
        </Box>
      ))}
    </Box>
  )

  // ---- the burn chart ------------------------------------------------------

  const chartH = 3
  const gutter = 7
  const cols = Math.max(10, C - gutter - 1)
  const bucketMs = 20_000
  const series = burnSeries(b, now, cols, bucketMs)
  const chart = chartRows(series, limit, chartH)
  const peak = Math.max(0, ...series)
  const overs = series.filter(v => v > limit).length
  const gutterLabel = (r: number) =>
    pad(r === chart.limitRow ? 'limit' : r === 0 ? money(chart.scale) : r === chartH - 1 ? '$0' : '', gutter)
  const burnBody = (
    <Box key="burn-body" flexDirection="column">
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
  )
  const burnRight = narrow ? `${money(rate)}/min` : `${money(rate)}/min · peak ${money(peak)}${overs > 0 ? ` · ${overs} over` : ''}`

  // ---- the token mix -------------------------------------------------------

  const m = b.mix
  const total = mixTotal(m)
  const parts = [
    { key: 'read', label: 'cache read', short: 'read', n: m.cacheRead, color: TEAL },
    { key: 'input', label: 'input', short: 'in', n: m.input, color: BLUE },
    { key: 'write', label: 'cache write', short: 'write', n: m.cacheWrite, color: AMBER },
    { key: 'output', label: 'output', short: 'out', n: m.output, color: VIOLET },
  ]
  let used = 0
  const widths = parts.map((p, i) => {
    const raw = i === parts.length - 1 ? C - used : Math.round((p.n / Math.max(1, total)) * C)
    const w = Math.max(0, Math.min(C - used, p.n > 0 ? Math.max(1, raw) : 0))
    used += w
    return w
  })
  const legendItem = (p: (typeof parts)[number], longLabel: boolean) => (
    <Box key={`legend-${p.key}`} marginRight={2}>
      <Text color={p.color}>{'■ '}</Text>
      <Text color={MUTED}>{`${longLabel ? p.label : p.short} ${compactTokens(p.n)}`}</Text>
    </Box>
  )
  const legendLong = parts.reduce((w, p) => w + p.label.length + compactTokens(p.n).length + 5, 0) <= C
  const subagents = b.agents.filter(a => a.id !== MAIN)
  const subShare = total > 0 ? subagents.reduce((s, a) => s + a.tokens, 0) / total : 0
  const mixBody = (
    <Box key="mix-body" flexDirection="column">
      {total === 0 ? (
        <Text color={FAINT}>No replies booked yet.</Text>
      ) : (
        <Box>
          {parts.map((p, i) => ((widths[i] ?? 0) > 0 ? <Text color={p.color}>{'█'.repeat(widths[i] ?? 0)}</Text> : null))}
        </Box>
      )}
      {total === 0 ? null : legendLong ? (
        <Box>{parts.map(p => legendItem(p, true))}</Box>
      ) : (
        <Box flexDirection="column">
          <Box>{parts.slice(0, 2).map(p => legendItem(p, !narrow))}</Box>
          <Box>{parts.slice(2).map(p => legendItem(p, !narrow))}</Box>
        </Box>
      )}
      {subagents.length > 0 && (
        <Text color={FAINT}>{cut(`main ${pct(1 - subShare)} · ${subagents.length} subagent${subagents.length === 1 ? '' : 's'} ${pct(subShare)}`, C)}</Text>
      )}
    </Box>
  )
  const mixRight = total > 0 ? `cache hit ${hit(cacheHit(m))} · ${compactTokens(total)}` : 'waiting for a reply'

  // ---- the circuit card ----------------------------------------------------

  const tripCard = (t: Trip, key: string, withActions: boolean, marginTop: number) => {
    const isFresh = now - t.at < 10 * 60_000
    const khata = b.khatas.find(k => k.id === t.khataId) ?? b.khatas.find(k => k.name === t.khata)
    const short = C < 50
    const buttons: unknown[] = []
    const stillMatters = isFresh || khata?.status === 'halted'
    if (withActions && isActionable(t) && stillMatters) {
      if ((t.kind === 'budget' || t.kind === 'halted') && khata && khata.budgetUsd > 0) {
        const by = raiseStep(khata)
        buttons.push(
          <Box key={`${key}-raise`} marginRight={2}>
            <Button key={`${key}-raise-btn`} variant="primary" label={short ? `+${money(by)}` : `+${money(by)} budget`} onPress={() => act.raise(khata.id, by)} />
          </Box>,
        )
      }
      buttons.push(
        <Box key={`${key}-allow`} marginRight={2}>
          <Button key={`${key}-allow-btn`} label="Allow once" onPress={() => act.allow()} />
        </Box>,
      )
      if ((t.kind === 'loop' || t.kind === 'burn') && khata && khata.id !== GENERAL && khata.status !== 'halted') {
        buttons.push(
          <Box key={`${key}-skip`}>
            <Button key={`${key}-skip-btn`} label={short ? 'Skip' : 'Skip task'} onPress={() => act.skip(khata.id)} />
          </Box>,
        )
      }
    }
    const isLatest = key.startsWith('trip-latest')
    const title = t.resolved || !isLatest ? '⊘ CIRCUIT TRIP ' : isFresh ? '⊘ CIRCUIT TRIPPED ' : '⊘ LAST TRIP '
    const when = `${!narrow && b.trips.length > 1 && isLatest ? `${b.trips.length} trips · ` : ''}${clockTime(t.at, narrow)}`
    return card(
      key,
      [
        <Box key={`${key}-head`} justifyContent="space-between">
          <Box>
            <Text bold color={RED}>{title}</Text>
            {badge(t.kind.toUpperCase(), RED, RED_BG)}
          </Box>
          <Text color={FAINT}>{cut(when, Math.max(0, C - title.length - t.kind.length - 3))}</Text>
        </Box>,
        <Text key={`${key}-reason`}>{cut(t.reason, C)}</Text>,
        <Text key={`${key}-where`} color={FAINT}>{cut(`${t.khata} · ${t.tool} · ${t.summary}`, C)}</Text>,
        t.resolved !== undefined ? <Text key={`${key}-done`} color={GREEN}>{cut(`✓ ${t.resolved}`, C)}</Text> : null,
        buttons.length > 0 ? <Box key={`${key}-actions`}>{buttons}</Box> : null,
      ],
      t.resolved ? BORDER : isFresh ? RED : BORDER,
      marginTop,
    )
  }

  // ---- khata rows ----------------------------------------------------------

  // Columns drop in this order as the pane narrows: tokens, then calls.
  const showTokens = C >= 56
  const showCalls = C >= 44
  const BAR = C >= 44 ? 10 : 6
  const N = Math.max(6, C - 2 - 8 - (showTokens ? 7 : 0) - 1 - BAR - 5 - (showCalls ? 6 : 0) - 2)
  const khataHead = (
    <Text key="khata-head" color={FAINT}>
      {`  ${pad('KHATA', N)}${lpad('SPENT', 8)}${showTokens ? lpad('TOKENS', 7) : ''} ${pad('BUDGET', BAR)}${lpad('USED', 5)}${showCalls ? lpad('CALLS', 6) : ''}`}
    </Text>
  )
  const khataRow = (k: Khata, drill: boolean) => {
    const s = STATUS[k.status]
    const hasBudget = k.budgetUsd > 0
    const ratio = hasBudget ? k.usd / k.budgetUsd : 0
    const filled = fill(ratio, BAR)
    const barColor = k.status === 'halted' || ratio >= 1 ? RED : ratio >= 0.75 ? AMBER : GOLD
    const nameColor = k.status === 'closed' ? MUTED : k.status === 'halted' ? RED : undefined
    return (
      <Box key={`k-${k.id}`} flexDirection="column">
        <Box>
          <Text color={s.color}>{`${s.glyph} `}</Text>
          <Text bold={k.id === b.active} color={nameColor}>{pad(k.name, N)}</Text>
          <Text color={k.status === 'halted' ? RED : undefined}>{lpad(money(k.usd), 8)}</Text>
          {showTokens && <Text color={MUTED}>{lpad(compactTokens(k.tokens), 7)}</Text>}
          <Text> </Text>
          {hasBudget && <Text color={barColor}>{'━'.repeat(filled)}</Text>}
          {hasBudget && <Text color={TRACK}>{'━'.repeat(BAR - filled)}</Text>}
          {hasBudget && <Text color={ratio >= 1 ? RED : MUTED}>{lpad(`${Math.min(999, Math.round(ratio * 100))}%`, 5)}</Text>}
          {!hasBudget && <Text color={FAINT}>{pad('no limit', BAR + 5)}</Text>}
          {showCalls && <Text color={MUTED}>{lpad(String(k.calls), 6)}</Text>}
          <Text> </Text>
          {drill ? link(`drill-${k.id}`, '›', () => act.drill(k.id)) : <Text> </Text>}
        </Box>
        {k.status === 'halted' && <Text color={RED}>{cut(`  └ halted · ${k.haltReason ?? 'over budget'}`, C)}</Text>}
      </Box>
    )
  }

  // ---- tape rows -----------------------------------------------------------

  // Narrow panes drop the duration so what a call was for keeps its room.
  const TIME = narrow ? 6 : 9
  const DUR = narrow ? 0 : 7
  const S = Math.max(6, C - TIME - 2 - 7 - DUR - 2)
  const agentName = (id: string | undefined) => b.agents.find(a => a.id === (id ?? MAIN))?.name ?? 'main'
  const entryDetails = (en: Entry) => {
    const khataName = b.khatas.find(k => k.id === en.khata)?.name ?? en.khata
    const result = en.outcome === 'blocked' ? `blocked by the ${en.note ?? ''} circuit` : en.outcome === 'fail' ? 'failed' : 'worked'
    const TEXT = Math.max(8, C - 13)
    const lines = en.summary.match(new RegExp(`.{1,${TEXT}}(\\s|$)`, 'g')) ?? [en.summary]
    const row = (label: string, value: string, color?: string) => (
      <Box key={`detail-${label}`}>
        <Text color={FAINT}>{pad(label, 7)}</Text>
        <Text color={color}>{cut(value, TEXT)}</Text>
      </Box>
    )
    return (
      <Box key="entry-details" flexDirection="column" marginLeft={2} borderStyle="round" borderColor={TRACK} paddingX={1}>
        {row('khata', khataName)}
        {row('agent', agentName(en.agent))}
        {row('result', en.outcome === 'blocked' ? result : `${result} · took ${duration(en.ms)}`, OUTCOME[en.outcome].color)}
        {lines.slice(0, 3).map((line, i) => (
          <Box key={`words-${i}`}>
            <Text color={FAINT}>{i === 0 ? 'action ' : '       '}</Text>
            <Text color={MUTED}>{cut(line.trimEnd(), TEXT)}</Text>
          </Box>
        ))}
      </Box>
    )
  }
  const tapeRow = (en: Entry, index: number, expandable: boolean) => {
    const o = OUTCOME[en.outcome]
    const isBlocked = en.outcome === 'blocked'
    const isOpen = view.entry === index
    return (
      <Box key={`t-${index}`} flexDirection="column">
        <Box>
          <Text color={FAINT}>{pad(clockTime(en.at, narrow), TIME)}</Text>
          <Text color={o.color}>{`${o.glyph} `}</Text>
          <Text bold color={isBlocked ? RED : undefined}>{pad(en.tool, 6)}</Text>
          <Text color={isBlocked ? RED : MUTED}>{` ${pad(isBlocked ? `circuit · ${en.note ?? ''} · ${en.summary}` : en.summary, S)}`}</Text>
          {DUR > 0 && <Text color={FAINT}>{lpad(isBlocked ? '' : duration(en.ms), DUR)}</Text>}
          <Text> </Text>
          {expandable ? link(`open-${index}`, isOpen ? '⌄' : '›', () => act.expand(isOpen ? null : index)) : <Text> </Text>}
        </Box>
        {isOpen && entryDetails(en)}
      </Box>
    )
  }

  // ---- the tabs ------------------------------------------------------------

  const folded = new Set(view.folded)

  const overview = () => {
    const tripRows = trip ? 5 + (trip.resolved ? 1 : isActionable(trip) && now - trip.at < 10 * 60_000 ? 1 : 0) : 0
    const limitRows = Math.max(1, windows.length)
    const cardsRows = 5 * cardRows.length
    const burnOpen = 3 + chartH + 1
    const mixOpen = 3 + 1 + (total === 0 ? 0 : legendLong ? 1 : 2) + (subagents.length > 0 ? 1 : 0)
    const haltedRows = (count: number) => b.khatas.slice(-count).filter(k => k.status === 'halted').length
    const khatasOpen = (count: number) => 4 + Math.max(1, count) + haltedRows(count) + (b.khatas.length > count ? 1 : 0)
    const tapeOpen = (count: number) => 3 + Math.max(1, count) + (b.entries.length > count ? 1 : 0)

    // Fit: shrink the lists, then fold what the person can unfold again, but
    // never a section the person opened: their choice wins, and the pane
    // scrolls if they open more than fits.
    const opened = new Set(view.opened ?? [])
    const shut = new Set([...folded].filter(id => !opened.has(id)))
    const autoFold = (id: string) => {
      if (!opened.has(id)) shut.add(id)
    }
    let khataCount = Math.min(b.khatas.length, 8)
    let tapeCount = 4
    const sections = () =>
      limitRows + cardsRows + (shut.has('burn') ? 3 : burnOpen) + (shut.has('mix') ? 3 : mixOpen) + tripRows +
      (shut.has('khatas') ? 3 : khatasOpen(khataCount)) + (shut.has('tape') ? 3 : tapeOpen(tapeCount))
    const fixed = 2 + 3 + 1 + 1 // header, tabs, footer, the first gap
    const fits = () => fixed + sections() <= R
    while (!fits() && khataCount > 5) khataCount -= 1
    while (!fits() && tapeCount > 2 && !shut.has('tape')) tapeCount -= 1
    for (const id of ['tape', 'mix']) if (!fits()) autoFold(id)
    while (!fits() && khataCount > 3) khataCount -= 1
    for (const id of ['burn', 'khatas']) if (!fits()) autoFold(id)
    const gapCount = 6 + (trip ? 1 : 0)
    const gap = R - fixed - sections() >= gapCount ? 1 : 0

    const shownKhatas = b.khatas.slice(-khataCount)
    const hidden = b.khatas.length - shownKhatas.length
    const overBudget = b.khatas.filter(k => k.budgetUsd > 0 && k.usd > k.budgetUsd).length
    const khataRight = `${b.khatas.length} · ${money(spent)}${overBudget > 0 && !narrow ? ` · ${overBudget} over budget` : ''}`
    const tapeRight = lastEntry ? `${b.entries.length} · last ${lastEntry.tool} ${OUTCOME[lastEntry.outcome].glyph}` : 'empty'
    const tape = b.entries.slice(-tapeCount).reverse()
    const newest = b.entries.length - 1

    return (
      <Box key="overview" flexDirection="column">
        {limitsBlock(1)}
        {cardsBlock(gap)}
        {section('burn', 'BURN RATE', burnRight, shut.has('burn'), burnBody, gap, overs > 0 ? RED : MUTED)}
        {section('mix', 'TOKEN MIX', mixRight, shut.has('mix'), mixBody, gap)}
        {trip !== undefined ? tripCard(trip, 'trip-latest', true, gap) : null}
        {section(
          'khatas',
          'KHATAS',
          khataRight,
          shut.has('khatas'),
          <Box key="khatas-body" flexDirection="column">
            {khataHead}
            {b.khatas.length === 0 && <Text color={FAINT}>{cut('  No khata yet. Work books to "general".', C)}</Text>}
            {hidden > 0 && <Text color={FAINT}>{cut(`  + ${hidden} earlier · Khatas tab`, C)}</Text>}
            {shownKhatas.map(k => khataRow(k, true))}
          </Box>,
          gap,
        )}
        {section(
          'tape',
          'TAPE',
          tapeRight,
          shut.has('tape'),
          <Box key="tape-body" flexDirection="column">
            {tape.length === 0 && <Text color={FAINT}>Waiting for the first step…</Text>}
            {tape.map((en, i) => tapeRow(en, newest - i, false))}
            {b.entries.length > tape.length && <Text color={FAINT}>{cut(`+ ${b.entries.length - tape.length} earlier · Tape tab`, C)}</Text>}
          </Box>,
          gap,
        )}
        {footer(gap)}
      </Box>
    )
  }

  const khatasTab = () => {
    const room = Math.max(3, R - 2 - 3 - 7)
    const shown = b.khatas.slice(-room)
    const open = b.khatas.filter(k => k.status === 'open').length
    const closed = b.khatas.filter(k => k.status === 'closed').length
    const halted = b.khatas.filter(k => k.status === 'halted').length
    return (
      <Box key="khatas-tab" flexDirection="column">
        {card(
          'khatas-card',
          [
            <Box key="khatas-tab-head" justifyContent="space-between">
              <Text bold color={GOLD}>KHATAS</Text>
              <Text color={MUTED}>{cut(`${open} open · ${closed} closed${halted > 0 ? ` · ${halted} halted` : ''}${wide ? ' · › its tape' : ''}`, C - 8)}</Text>
            </Box>,
            khataHead,
            b.khatas.length === 0 ? <Text key="none" color={FAINT}>  No khata yet.</Text> : null,
            b.khatas.length > shown.length ? <Text key="earlier" color={FAINT}>{cut(`  + ${b.khatas.length - shown.length} earlier in bahi.md`, C)}</Text> : null,
            ...shown.map(k => khataRow(k, true)),
            <Box key="khatas-total" marginTop={1} justifyContent="space-between">
              <Text color={FAINT}>total</Text>
              <Text color={MUTED}>{cut(`${money(spent)} · ${compactTokens(b.tokens)} tokens · ${b.khatas.reduce((s, k) => s + k.calls, 0)} calls`, C - 7)}</Text>
            </Box>,
          ],
          BORDER,
          1,
        )}
        {footer(1)}
      </Box>
    )
  }

  const tapeTab = () => {
    const filter = view.khata
    const indexed = b.entries.map((en, i) => ({ en, i })).filter(e => filter === null || e.en.khata === filter)
    const expandedRows = view.entry !== null ? 7 : 0
    const room = Math.max(3, R - 2 - 3 - 6 - (filter ? 1 : 0) - expandedRows)
    const shown = indexed.slice(-room).reverse()
    const filterName = filter ? b.khatas.find(k => k.id === filter)?.name ?? filter : null
    return (
      <Box key="tape-tab" flexDirection="column">
        {card(
          'tape-card',
          [
            <Box key="tape-tab-head" justifyContent="space-between">
              <Text bold color={GOLD}>TAPE</Text>
              <Text color={MUTED}>{cut(`${indexed.length} entries · newest first${wide ? ' · › details' : ''}`, C - 6)}</Text>
            </Box>,
            filterName !== null ? (
              <Box key="tape-filter">
                <Text color={MUTED}>{'khata  '}</Text>
                {badge(cut(filterName, Math.max(4, C - 22)), GOLD, GOLD_BG)}
                <Text>{'  '}</Text>
                {link('clear-filter', 'show all ✕', () => act.drill(null))}
              </Box>
            ) : null,
            shown.length === 0 ? <Text key="none" color={FAINT}>Nothing on the tape yet.</Text> : null,
            ...shown.map(e => tapeRow(e.en, e.i, true)),
            indexed.length > shown.length ? <Text key="earlier" color={FAINT}>{cut(`+ ${indexed.length - shown.length} earlier entries in bahi.md`, C)}</Text> : null,
          ],
          BORDER,
          1,
        )}
        {footer(1)}
      </Box>
    )
  }

  const tripsTab = () => {
    const newest = [...b.trips].reverse()
    const room = Math.max(1, Math.floor((R - 2 - 3 - 3) / 6))
    const shown = newest.slice(0, room)
    return (
      <Box key="trips-tab" flexDirection="column">
        {shown.length === 0
          ? card(
              'no-trips',
              [
                <Text key="no-trips-title" bold color={GOLD}>NO CIRCUIT TRIPS</Text>,
                <Text key="no-trips-text" color={FAINT}>{cut('Nothing has needed stopping yet.', C)}</Text>,
              ],
              BORDER,
              1,
            )
          : shown.map((t, i) => tripCard(t, i === 0 ? 'trip-latest-tab' : `trip-${i}`, i === 0, 1))}
        {newest.length > shown.length && <Text color={FAINT}>{cut(`+ ${newest.length - shown.length} earlier trips in bahi.md`, inner)}</Text>}
        {footer(1)}
      </Box>
    )
  }

  const agentsTab = () => {
    const list: AgentLedger[] = b.agents
    // dot 2, then steps and calls (6 each) on wide panes, then tokens 8, cost 8, cache 7.
    const NAME = Math.max(6, C - (wide ? 37 : 25))
    return (
      <Box key="agents-tab" flexDirection="column">
        {card(
          'agents-card',
          [
            <Box key="agents-head" justifyContent="space-between">
              <Text bold color={GOLD}>AGENTS</Text>
              <Text color={MUTED}>{cut('tokens exact · cost by reply', C - 8)}</Text>
            </Box>,
            <Text key="agents-cols" color={FAINT}>
              {`  ${pad('AGENT', NAME)}${wide ? `${lpad('STEPS', 6)}${lpad('CALLS', 6)}` : ''}${lpad('TOKENS', 8)}${lpad('COST', 8)}${lpad('CACHE', 7)}`}
            </Text>,
            list.length === 0 ? <Text key="none" color={FAINT}>  No replies booked yet.</Text> : null,
            ...list.map(a => {
              const isRunning = a.status === 'running' || a.status === 'pending' || a.status === 'waiting'
              const dot =
                a.id === MAIN ? { glyph: '◆', color: GOLD }
                : isRunning ? { glyph: '●', color: GREEN }
                : a.status === 'failed' || a.status === 'killed' ? { glyph: '■', color: RED }
                : { glyph: '○', color: FAINT }
              return (
                <Box key={`agent-${a.id}`} flexDirection="column">
                  <Box>
                    <Text color={dot.color}>{`${dot.glyph} `}</Text>
                    <Text bold={a.id === MAIN}>{pad(a.name, NAME)}</Text>
                    <Text color={MUTED}>
                      {`${wide ? `${lpad(String(a.steps), 6)}${lpad(String(a.calls), 6)}` : ''}${lpad(compactTokens(a.tokens), 8)}${lpad(money(a.usd), 8)}${lpad(hit(cacheHit(a.mix)), 7)}`}
                    </Text>
                  </Box>
                  {a.model !== undefined && (
                    <Text color={FAINT}>{cut(`    ${a.model}${a.type ? ` · ${a.type}` : ''}${a.status && a.id !== MAIN ? ` · ${a.status}` : ''}`, C)}</Text>
                  )}
                </Box>
              )
            }),
          ],
          BORDER,
          1,
        )}
        {footer(1)}
      </Box>
    )
  }

  const body =
    view.tab === 'khatas' ? khatasTab()
    : view.tab === 'tape' ? tapeTab()
    : view.tab === 'trips' ? tripsTab()
    : view.tab === 'agents' ? agentsTab()
    : overview()

  return (
    <Box flexDirection="column" paddingX={1}>
      {header}
      {tabBar}
      {body}
    </Box>
  )
}

// Folds or opens a section from how it is drawn now: a section the pane folded
// to fit opens on the first press, and stays open.
export const toggleSection = (view: View, id: string, isFolded: boolean): View => {
  const folded = view.folded.filter(x => x !== id)
  const opened = (view.opened ?? []).filter(x => x !== id)
  return isFolded ? { ...view, folded, opened: [...opened, id] } : { ...view, folded: [...folded, id], opened }
}
