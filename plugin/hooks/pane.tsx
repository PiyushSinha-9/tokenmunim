// The pane: pure drawing from a book and a view. Every handler it wires comes
// in through `act`, so this file never touches the engine itself.
//
// The look: filled panels instead of borders, one gold accent, pills for state
// and actions, braille charts for density, and color only where it carries
// meaning. Every row is laid out for the width it actually has, and nothing is
// ever padded past its panel.

import type { AgentLedger, Book, Entry, Task, Tab, Trip, View } from '../types'
import { brailleArea, sparkline } from './chart'
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
  tokenSeries,
} from './ledger'
import type { Limits } from './ledger'

// The element constructors of the surface being drawn on.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Kit = { Box: any; Text: any; Button: any }

export type PaneActions = {
  setTab: (tab: Tab) => void
  // `isFolded` is how the section is drawn now, which may be the pane's own doing.
  toggle: (section: string, isFolded: boolean) => void
  drill: (taskId: string | null) => void
  expand: (index: number | null) => void
  openLedger: () => void
  raise: (taskId: string, by: number) => void
  allow: () => void
  skip: (taskId: string) => void
}

export type PaneData = {
  book: Book
  view: View
  now: number
  limits: Limits
  width: number
  rows: number
  hasFile: boolean
  startedAt?: number
}

export const DEFAULT_VIEW: View = { tab: 'overview', folded: ['activity', 'alerts'], opened: [], task: null, entry: null }

// ---- the palette -------------------------------------------------------------

const GOLD = '#E8B04B'
const GOLD_DEEP = '#5E4719'
const INK = '#17171B'
const MUTED = '#9C9CA8'
const FAINT = '#666672'
const LINE = '#3B3B45'
const PANEL = '#2D2D35'
const PANEL_HI = '#383843'
const CHIP = '#41414C'
const GREEN = '#4ADE80'
const GREEN_BG = '#1C3626'
const AMBER = '#FBBF24'
const RED = '#F87171'
const RED_DIM = '#A04C4C'
const RED_PANEL = '#3A2326'
const BLUE = '#60A5FA'
const TEAL = '#2DD4BF'
const VIOLET = '#A78BFA'

const STATUS: Record<Task['status'], { glyph: string; color: string }> = {
  open: { glyph: '●', color: GREEN },
  closed: { glyph: '○', color: FAINT },
  halted: { glyph: '■', color: RED },
}

const OUTCOME: Record<Entry['outcome'], { glyph: string; color: string }> = {
  ok: { glyph: '✓', color: GREEN },
  fail: { glyph: '✗', color: AMBER },
  blocked: { glyph: '⊘', color: RED },
}

const TOOL_COLOR: Record<string, string> = {
  Bash: TEAL,
  Read: BLUE,
  Grep: BLUE,
  Glob: BLUE,
  Fetch: BLUE,
  Web: BLUE,
  Write: VIOLET,
  Edit: VIOLET,
  Note: VIOLET,
  Agent: GOLD,
  Tools: FAINT,
  Todo: FAINT,
}

const WINDOW_LABEL: Record<string, string> = { five_hour: '5h', seven_day: 'week', spend_limit: 'spend' }

// ---- text helpers ------------------------------------------------------------

// `cut` shortens text to fit; `pad` also fills a column to its width.
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
// Budget use: a percentage up to the budget, then times over it.
const used = (ratio: number) => (ratio < 1 ? `${Math.round(ratio * 100)}%` : `${ratio < 10 ? ratio.toFixed(1) : Math.round(ratio)}×`)

// Words wrapped to `width`, at most `lines` lines; only the last line is cut.
const wrap = (text: string, width: number, lines: number): string[] => {
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    if (line === '') line = word
    else if (line.length + 1 + word.length <= width) line = `${line} ${word}`
    else {
      out.push(line)
      line = word
    }
  }
  if (line !== '') out.push(line)
  if (out.length <= lines) return out.map(l => cut(l, width))
  const kept = out.slice(0, lines)
  kept[lines - 1] = cut(`${kept[lines - 1]} ${out.slice(lines).join(' ')}`, width)
  return kept
}

// A step to raise a halted task by: half its budget, at least five cents.
export const raiseStep = (k: Task) => Math.max(0.05, Math.round(k.budgetUsd * 50) / 100)

const isActionable = (trip: Trip | undefined): trip is Trip => trip !== undefined && trip.resolved === undefined

// Folds or opens a section from how it is drawn now: a section the pane folded
// to fit opens on the first press, and stays open.
export const toggleSection = (view: View, id: string, isFolded: boolean): View => {
  const folded = view.folded.filter(x => x !== id)
  const opened = (view.opened ?? []).filter(x => x !== id)
  return isFolded ? { ...view, folded, opened: [...opened, id] } : { ...view, folded: [...folded, id], opened }
}

export function drawPane(kit: Kit, d: PaneData, act: PaneActions) {
  const { Box, Text, Button } = kit
  const { book: b, view, now, limits } = d
  const W = Math.max(30, d.width)
  const inner = W - 2
  // Inside a panel: one cell of padding a side.
  const C = inner - 2
  const wide = C >= 58
  const narrow = C < 46
  const R = Math.max(24, d.rows)

  const trip = b.trips[b.trips.length - 1]
  const active = b.tasks.find(k => k.id === b.active)
  const lastEntry = b.entries[b.entries.length - 1]
  const isLive = lastEntry !== undefined && now - lastEntry.at < 90_000

  // ---- building blocks -----------------------------------------------------

  const pill = (text: string, color: string, bg?: string) => (
    <Text bold color={color} backgroundColor={bg}>{` ${text} `}</Text>
  )

  const link = (key: string, label: string, onPress: () => void, dim = false) => (
    <Box key={`${key}-box`}>
      <Button key={key} plain dimColor={dim} label={label} hover={{ color: GOLD, underline: true }} onPress={onPress} />
    </Box>
  )

  const action = (key: string, label: string, onPress: () => void, primary: boolean) => (
    <Box key={`${key}-box`} backgroundColor={primary ? GOLD_DEEP : CHIP} marginRight={1}>
      <Button key={key} plain label={` ${label} `} hover={{ backgroundColor: primary ? GOLD : MUTED, color: INK }} onPress={onPress} />
    </Box>
  )

  const panel = (key: string, children: unknown, marginTop: number, bg: string = PANEL) => (
    <Box key={key} flexDirection="column" marginTop={marginTop} backgroundColor={bg} paddingX={1}>
      {children}
    </Box>
  )

  const section = (id: string, title: string, right: unknown, isFolded: boolean, body: unknown, marginTop: number) =>
    panel(
      `sec-${id}`,
      [
        <Box key={`sec-${id}-head`} justifyContent="space-between">
          <Box key={`fold-${id}-box`}>
            <Button key={`fold-${id}`} plain label={`${isFolded ? '▸' : '▾'} ${title}`} hover={{ color: GOLD, underline: true }} onPress={() => act.toggle(id, isFolded)} />
          </Box>
          {right}
        </Box>,
        isFolded ? null : body,
      ],
      marginTop,
    )

  const muted = (text: string, room: number, color: string = MUTED) => <Text color={color}>{cut(text, Math.max(0, room))}</Text>

  // ---- header and tabs -----------------------------------------------------

  // The header is one row, like an app's title bar: a gold logo tile, the
  // wordmark in two tones, the tagline when there is room, status on the right.
  const elapsed = d.startedAt && d.startedAt > 0 ? `session ${span((now - d.startedAt) / 60_000)}` : ''
  const TAGLINE = '  cost control for AI agents'
  const statusWidth = 8 + (d.hasFile ? 1 + 8 : 0)
  const showTagline = 3 + 11 + TAGLINE.length + 1 + statusWidth <= inner
  const header = (
    <Box key="header" justifyContent="space-between">
      <Box>
        <Text bold color={INK} backgroundColor={GOLD}>{' ◆ '}</Text>
        <Text bold>{' Token'}</Text>
        <Text bold color={GOLD}>Munim</Text>
        {showTagline ? <Text color={FAINT}>{TAGLINE}</Text> : null}
      </Box>
      <Box>
        {isLive ? pill('● LIVE', GREEN, GREEN_BG) : pill('○ IDLE', FAINT)}
        {d.hasFile ? <Text> </Text> : null}
        {d.hasFile ? link('open-ledger', 'ledger ↗', act.openLedger) : null}
      </Box>
    </Box>
  )

  const agentCount = Math.max(1, b.agents.length)
  const tabDefs: { id: Tab; long: string; short: string; n?: number }[] = [
    { id: 'overview', long: 'Overview', short: 'Home' },
    { id: 'tasks', long: 'Tasks', short: 'Tasks', n: b.tasks.length },
    { id: 'activity', long: 'Activity', short: 'Activity', n: b.entries.length },
    { id: 'alerts', long: 'Alerts', short: 'Alerts', n: b.trips.length },
    { id: 'agents', long: 'Agents', short: 'Agents', n: agentCount },
  ]
  // The richest tab labels that fit on one line; each label carries a space a side.
  const variants = [
    { counts: true, short: false, gap: 1 },
    { counts: false, short: false, gap: 1 },
    { counts: false, short: true, gap: 0 },
  ]
  const labelOf = (t: (typeof tabDefs)[number], v: (typeof variants)[number]) =>
    `${v.short ? t.short : t.long}${v.counts && t.n !== undefined ? ` ${t.n}` : ''}`
  const chosen =
    variants.find(v => tabDefs.reduce((w, t) => w + labelOf(t, v).length + 2, 0) + v.gap * (tabDefs.length - 1) <= inner) ??
    variants[variants.length - 1]!
  const tabBar = (
    <Box key="tabs" flexDirection="column" marginTop={1}>
      <Box>
        {tabDefs.map((t, i) => (
          <Box key={`tab-${t.id}`} marginRight={i < tabDefs.length - 1 ? chosen.gap : 0}>
            {t.id === view.tab ? (
              <Text bold color={INK} backgroundColor={GOLD}>{` ${labelOf(t, chosen)} `}</Text>
            ) : (
              <Button key={`tab-btn-${t.id}`} plain dimColor label={` ${labelOf(t, chosen)} `} hover={{ color: GOLD }} onPress={() => act.setTab(t.id)} />
            )}
          </Box>
        ))}
      </Box>
      <Text color={LINE}>{'─'.repeat(inner)}</Text>
    </Box>
  )

  const footerLeft = `${elapsed !== '' ? `${elapsed} · ` : ''}/munim for commands`
  const footer = (gap: number) => (
    <Box key="footer" marginTop={gap} justifyContent="space-between">
      <Text color={FAINT}>{footerLeft}</Text>
      {active !== undefined ? <Text color={MUTED}>{cut(`▸ ${active.name}`, Math.max(0, inner - footerLeft.length - 2))}</Text> : null}
    </Box>
  )

  // ---- plan limits ---------------------------------------------------------

  const plan = b.rateLimits.filter(w => w.kind === 'five_hour' || w.kind === 'seven_day')
  const windows = plan.length > 0 ? plan : b.rateLimits.filter(w => w.kind === 'spend_limit').slice(0, 1)
  const showPace = inner >= 50
  const limitBarW = Math.max(6, inner - 6 - 10 - 10 - (showPace ? 13 : 0))
  const limitsBlock = (marginTop: number) => (
    <Box key="limits" flexDirection="column" marginTop={marginTop}>
      {windows.length === 0 ? (
        <Box>
          <Text color={MUTED}>{'limits  '}</Text>
          <Text color={FAINT}>{cut('plan limits show after the next reply', inner - 8)}</Text>
        </Box>
      ) : null}
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
            <Text color={LINE}>{'━'.repeat(limitBarW - filled)}</Text>
            <Text bold color={color}>{pad(` ${String(Math.round(left)).padStart(3)}% left`, 10)}</Text>
            <Text color={FAINT}>{pad(`  ↻ ${Number.isNaN(resetMs) ? '?' : countdown(resetMs)}`, 10)}</Text>
            {showPace ? <Text color={pace.color}>{cut(pace.text, 13)}</Text> : null}
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
  const rateColor = rate > limit ? RED : rate > limit * 0.75 ? AMBER : undefined
  const blockedCount = b.entries.filter(en => en.outcome === 'blocked').length
  const perRow = inner >= 60 ? 4 : 2
  const cw = Math.floor((inner - (perRow - 1)) / perRow)
  const liveSpark = (series: number[]) => (series.some(v => v > 0) ? sparkline(series) : undefined)
  const tiles = [
    { key: 'spent', label: 'SPENT', value: money(spent), color: undefined as string | undefined, caption: `${Math.round((spent / limits.sessionBudgetUsd) * 100)}% of ${dollars(limits.sessionBudgetUsd)}`, spark: undefined as string | undefined, sparkColor: GOLD },
    { key: 'cost', label: 'COST/MIN', value: money(rate), color: rateColor, caption: `limit ${money(limit)}`, spark: liveSpark(burnSeries(b, now, 16, 45_000)), sparkColor: rate > limit ? RED : GOLD },
    { key: 'tokens', label: 'TOKENS/MIN', value: compactTokens(tokensPerMin), color: undefined, caption: `${compactTokens(b.tokens)} total`, spark: liveSpark(tokenSeries(b, now, 16, 45_000)), sparkColor: TEAL },
    { key: 'stopped', label: 'STOPPED', value: String(blockedCount), color: (blockedCount > 0 ? RED : undefined) as string | undefined, caption: 'calls blocked', spark: undefined as string | undefined, sparkColor: GREEN },
  ]
  const tileRows = [tiles.slice(0, perRow), tiles.slice(perRow)].filter(row => row.length > 0)
  const tilesBlock = (marginTop: number) => (
    <Box key="tiles" flexDirection="column" marginTop={marginTop}>
      {tileRows.map((row, r) => (
        <Box key={`tiles-${r}`} gap={1} marginTop={r > 0 ? 1 : 0}>
          {row.map((t, i) => {
            const w = i === row.length - 1 ? inner - (perRow - 1) - cw * (perRow - 1) : cw
            const room = w - 2
            const sparkRoom = t.spark ? Math.max(0, Math.min(8, room - t.value.length - 1)) : 0
            return (
              <Box key={`tile-${t.key}`} width={w} flexDirection="column" backgroundColor={PANEL} paddingX={1}>
                <Text color={MUTED}>{cut(t.label, room)}</Text>
                <Box justifyContent="space-between">
                  <Text bold color={t.color}>{cut(t.value, room)}</Text>
                  {sparkRoom >= 3 && t.spark ? <Text color={t.sparkColor}>{t.spark.slice(-sparkRoom)}</Text> : null}
                </Box>
                <Text color={FAINT}>{cut(t.caption, room)}</Text>
              </Box>
            )
          })}
        </Box>
      ))}
    </Box>
  )

  // ---- the burn chart ------------------------------------------------------

  const chartH = 4
  const gutter = 6
  const cols = Math.max(10, C - gutter - 1)
  const bucketMs = 12_000
  const series = burnSeries(b, now, cols * 2, bucketMs)
  const peak = Math.max(0, ...series)
  const scale = Math.max(peak * 1.15, limit * 1.25, 0.01)
  const cells = brailleArea(series, chartH, scale)
  const limitLevel = Math.min(chartH * 4, Math.max(1, Math.round((limit / scale) * chartH * 4)))
  const limitRow = chartH - 1 - Math.floor((limitLevel - 1) / 4)
  const overs = series.filter(v => v > limit).length
  const toneOf = (v: number) => (v > limit ? RED : v > limit * 0.75 ? AMBER : v > limit * 0.4 ? GOLD : TEAL)
  const chartLine = (row: (typeof cells)[number], r: number) => {
    const runs: { text: string; color: string | undefined }[] = []
    for (const cell of row) {
      const [ch, color] =
        cell.char !== null ? [cell.char, toneOf(cell.value)]
        : r === limitRow ? ['┈', RED_DIM]
        : r === chartH - 1 ? ['⣀', LINE]
        : [' ', undefined]
      const last = runs[runs.length - 1]
      if (last && last.color === color) last.text += ch
      else runs.push({ text: ch, color })
    }
    return runs
  }
  const gutterLabel = (r: number) => pad(r === limitRow ? 'limit' : r === 0 ? money(scale) : r === chartH - 1 ? '$0' : '', gutter)
  const burnBody = (
    <Box key="burn-body" flexDirection="column">
      {cells.map((row, r) => (
        <Box key={`chart-${r}`}>
          {chartLine(row, r).map(run => (
            <Text color={run.color}>{run.text}</Text>
          ))}
          <Text color={r === limitRow ? RED_DIM : FAINT}>{` ${gutterLabel(r)}`}</Text>
        </Box>
      ))}
      <Box width={cols} justifyContent="space-between">
        <Text color={FAINT}>{`${Math.round((cols * 2 * bucketMs) / 60_000)}m ago`}</Text>
        <Text color={FAINT}>now</Text>
      </Box>
    </Box>
  )
  const burnRight = (
    <Box key="burn-right">
      <Text color={rateColor ?? MUTED}>{`${money(rate)}/min`}</Text>
      {!narrow ? <Text color={FAINT}>{` · peak ${money(peak)}`}</Text> : null}
      {!narrow && overs > 0 ? <Text color={RED}>{' · over limit'}</Text> : null}
    </Box>
  )

  // ---- the token mix -------------------------------------------------------

  const m = b.mix
  const total = mixTotal(m)
  const parts = [
    { key: 'read', label: 'cache read', short: 'read', n: m.cacheRead, color: TEAL },
    { key: 'input', label: 'input', short: 'in', n: m.input, color: BLUE },
    { key: 'write', label: 'cache write', short: 'write', n: m.cacheWrite, color: AMBER },
    { key: 'output', label: 'output', short: 'out', n: m.output, color: VIOLET },
  ]
  let usedW = 0
  const widths = parts.map((p, i) => {
    const raw = i === parts.length - 1 ? C - usedW : Math.round((p.n / Math.max(1, total)) * C)
    const w = Math.max(0, Math.min(C - usedW, p.n > 0 ? Math.max(1, raw) : 0))
    usedW += w
    return w
  })
  const legendLong = parts.reduce((w, p) => w + p.label.length + compactTokens(p.n).length + 5, 0) <= C
  const legendItem = (p: (typeof parts)[number], longLabel: boolean) => (
    <Box key={`legend-${p.key}`} marginRight={2}>
      <Text color={p.color}>{'● '}</Text>
      <Text color={MUTED}>{`${longLabel ? p.label : p.short} `}</Text>
      <Text>{compactTokens(p.n)}</Text>
    </Box>
  )
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
      {subagents.length > 0 ? (
        <Text color={FAINT}>{cut(`main ${pct(1 - subShare)} · ${subagents.length} subagent${subagents.length === 1 ? '' : 's'} ${pct(subShare)}`, C)}</Text>
      ) : null}
    </Box>
  )
  const mixRight =
    total > 0 ? (
      <Box key="mix-right">
        {pill(`${hit(cacheHit(m))} cache hit`, GREEN, GREEN_BG)}
        {!narrow ? <Text color={FAINT}>{` ${compactTokens(total)}`}</Text> : null}
      </Box>
    ) : (
      muted('waiting for a reply', C - 14)
    )

  // ---- the circuit callout -------------------------------------------------

  const actionable = (t: Trip) => {
    const task = b.tasks.find(k => k.id === t.taskId) ?? b.tasks.find(k => k.name === t.task)
    return isActionable(t) && (now - t.at < 10 * 60_000 || task?.status === 'halted')
  }
  const reasonLines = (t: Trip) => wrap(t.reason, C - 2, 2)
  const tripRowsOf = (t: Trip, withActions: boolean) =>
    1 + reasonLines(t).length + 1 + (t.resolved !== undefined ? 1 : withActions && actionable(t) ? 2 : 0)
  const tripCard = (t: Trip, key: string, withActions: boolean, marginTop: number, inline = false) => {
    const isFresh = now - t.at < 10 * 60_000
    const isLatest = key.startsWith('trip-latest')
    const task = b.tasks.find(k => k.id === t.taskId) ?? b.tasks.find(k => k.name === t.task)
    const live = withActions && actionable(t)
    const bar = <Text color={t.resolved ? FAINT : RED}>{'▎'}</Text>
    const buttons: unknown[] = []
    if (live) {
      if ((t.kind === 'budget' || t.kind === 'halted') && task && task.budgetUsd > 0) {
        const by = raiseStep(task)
        buttons.push(action(`${key}-raise-btn`, `+${money(by)} budget`, () => act.raise(task.id, by), true))
      }
      buttons.push(action(`${key}-allow-btn`, 'Allow once', () => act.allow(), false))
      if ((t.kind === 'loop' || t.kind === 'burn') && task && task.id !== GENERAL && task.status !== 'halted') {
        buttons.push(action(`${key}-skip-btn`, narrow ? 'Skip' : 'Skip task', () => act.skip(task.id), false))
      }
    }
    const title = t.resolved || !isLatest ? 'CIRCUIT TRIP' : isFresh ? 'CIRCUIT TRIPPED' : 'LAST CIRCUIT TRIP'
    const when = `${!narrow && !inline && b.trips.length > 1 && isLatest ? `${b.trips.length} alerts · ` : ''}${clockTime(t.at, narrow)}`
    const lines = [
        <Box key={`${key}-head`} justifyContent="space-between">
          <Box>
            {bar}
            <Text bold color={t.resolved ? MUTED : RED}>{`⊘ ${title} `}</Text>
            {pill(t.kind.toUpperCase(), INK, t.resolved ? FAINT : RED)}
          </Box>
          <Text color={FAINT}>{cut(when, Math.max(0, C - title.length - t.kind.length - 8))}</Text>
        </Box>,
        ...reasonLines(t).map((line, i) => (
          <Box key={`${key}-reason-${i}`}>
            {bar}
            <Text>{` ${line}`}</Text>
          </Box>
        )),
        <Box key={`${key}-where`}>
          {bar}
          <Text color={FAINT}>{` ${cut(`${t.task} · ${t.tool} · ${t.summary}`, C - 2)}`}</Text>
        </Box>,
        t.resolved !== undefined ? (
          <Box key={`${key}-done`}>
            {bar}
            <Text color={GREEN}>{` ✓ ${cut(t.resolved, C - 4)}`}</Text>
          </Box>
        ) : null,
        buttons.length > 0 ? (
          <Box key={`${key}-actions`} marginTop={1}>
            <Text> </Text>
            {buttons}
          </Box>
        ) : null,
      ]
    if (inline) {
      return (
        <Box key={key} flexDirection="column" backgroundColor={t.resolved ? undefined : RED_PANEL}>
          {lines}
        </Box>
      )
    }
    return panel(key, lines, marginTop, t.resolved ? PANEL : RED_PANEL)
  }

  // ---- task rows ----------------------------------------------------------

  // Columns drop in this order as the pane narrows: tokens, then calls.
  const showTokens = C >= 58
  const showCalls = C >= 46
  const BAR = C >= 46 ? 10 : 6
  const N = Math.max(6, C - 2 - 8 - (showTokens ? 7 : 0) - 1 - BAR - 6 - (showCalls ? 6 : 0) - 2)
  const taskHead = (
    <Text key="task-head" color={FAINT}>
      {`  ${pad('TASK', N)}${lpad('SPENT', 8)}${showTokens ? lpad('TOKENS', 7) : ''} ${pad('BUDGET', BAR)}${lpad('USED', 6)}${showCalls ? lpad('CALLS', 6) : ''}`}
    </Text>
  )
  const taskRow = (k: Task, drill: boolean) => {
    const s = STATUS[k.status]
    const hasBudget = k.budgetUsd > 0
    const ratio = hasBudget ? k.usd / k.budgetUsd : 0
    const over = ratio >= 1
    const filled = fill(ratio, BAR)
    const barColor = k.status === 'halted' || over ? RED : ratio >= 0.75 ? AMBER : GOLD
    const nameColor = k.status === 'closed' ? MUTED : k.status === 'halted' ? RED : undefined
    const isActive = k.id === b.active
    return (
      <Box key={`k-${k.id}`} flexDirection="column">
        <Box backgroundColor={isActive ? PANEL_HI : undefined}>
          <Text color={s.color}>{`${s.glyph} `}</Text>
          <Text bold={isActive} color={nameColor}>{pad(k.name, N)}</Text>
          <Text bold={over} color={over ? RED : undefined}>{lpad(money(k.usd), 8)}</Text>
          {showTokens ? <Text color={MUTED}>{lpad(compactTokens(k.tokens), 7)}</Text> : null}
          <Text> </Text>
          {hasBudget ? <Text color={barColor}>{'━'.repeat(filled)}</Text> : null}
          {hasBudget ? <Text color={LINE}>{'━'.repeat(BAR - filled)}</Text> : null}
          {hasBudget ? <Text bold={over} color={over ? RED : MUTED}>{lpad(used(ratio), 6)}</Text> : null}
          {!hasBudget ? <Text color={FAINT}>{pad('no limit', BAR + 6)}</Text> : null}
          {showCalls ? <Text color={MUTED}>{lpad(String(k.calls), 6)}</Text> : null}
          <Text> </Text>
          {drill ? link(`drill-${k.id}`, '›', () => act.drill(k.id)) : <Text> </Text>}
        </Box>
        {k.status === 'halted' ? <Text color={RED_DIM}>{cut(`  └ halted · ${k.haltReason ?? 'over budget'}`, C)}</Text> : null}
      </Box>
    )
  }

  // ---- activity rows -----------------------------------------------------------

  // Narrow panes drop the duration so what a call was for keeps its room.
  const TIME = narrow ? 6 : 9
  const DUR = narrow ? 0 : 7
  const S = Math.max(6, C - TIME - 2 - 7 - DUR - 2)
  const agentName = (id: string | undefined) => b.agents.find(a => a.id === (id ?? MAIN))?.name ?? 'main'
  const entryDetails = (en: Entry) => {
    const taskName = b.tasks.find(k => k.id === en.task)?.name ?? en.task
    const result = en.outcome === 'blocked' ? `blocked by the ${en.note ?? ''} circuit` : en.outcome === 'fail' ? 'failed' : 'worked'
    const TEXT = Math.max(8, C - 12)
    const row = (label: string, value: string, color?: string) => (
      <Box key={`detail-${label}`}>
        <Text color={FAINT}>{pad(label, 8)}</Text>
        <Text color={color}>{cut(value, TEXT)}</Text>
      </Box>
    )
    return (
      <Box key="entry-details" flexDirection="column" marginLeft={2} backgroundColor={PANEL_HI} paddingX={1}>
        {row('task', taskName)}
        {row('agent', agentName(en.agent))}
        {row('result', en.outcome === 'blocked' ? result : `${result} · took ${duration(en.ms)}`, OUTCOME[en.outcome].color)}
        {wrap(en.summary, TEXT, 3).map((line, i) => (
          <Box key={`words-${i}`}>
            <Text color={FAINT}>{i === 0 ? 'action  ' : '        '}</Text>
            <Text color={MUTED}>{line}</Text>
          </Box>
        ))}
      </Box>
    )
  }
  const activityRow = (en: Entry, index: number, expandable: boolean) => {
    const o = OUTCOME[en.outcome]
    const isBlocked = en.outcome === 'blocked'
    const isOpen = view.entry === index
    return (
      <Box key={`t-${index}`} flexDirection="column">
        <Box backgroundColor={isOpen ? PANEL_HI : undefined}>
          <Text color={FAINT}>{pad(clockTime(en.at, narrow), TIME)}</Text>
          <Text color={o.color}>{`${o.glyph} `}</Text>
          <Text bold color={isBlocked ? RED : TOOL_COLOR[en.tool] ?? MUTED}>{pad(en.tool, 6)}</Text>
          <Text color={isBlocked ? RED : undefined}>{` ${pad(isBlocked ? `circuit · ${en.note ?? ''} · ${en.summary}` : en.summary, S)}`}</Text>
          {DUR > 0 ? <Text color={FAINT}>{lpad(isBlocked ? '' : duration(en.ms), DUR)}</Text> : null}
          <Text> </Text>
          {expandable ? link(`open-${index}`, isOpen ? '⌄' : '›', () => act.expand(isOpen ? null : index)) : <Text> </Text>}
        </Box>
        {isOpen ? entryDetails(en) : null}
      </Box>
    )
  }

  // ---- the tabs ------------------------------------------------------------

  const overview = () => {
    const alertRows = trip ? tripRowsOf(trip, true) : 1
    // What needs the person: each halted task once, plus each recent loop or burn.
    const fresh = new Set(
      b.trips
        .map((t, i) => ({ t, i }))
        .filter(({ t }) => actionable(t))
        .map(({ t, i }) => (t.kind === 'budget' || t.kind === 'halted' ? `task:${t.taskId ?? t.task}` : `alert:${i}`)),
    ).size
    const limitRows = Math.max(1, windows.length)
    const tilesRows = 3 * tileRows.length + (tileRows.length - 1)
    const burnOpen = 1 + chartH + 1
    const mixOpen = 1 + 1 + (total === 0 ? 0 : legendLong ? 1 : 2) + (subagents.length > 0 ? 1 : 0)
    const haltedRows = (count: number) => b.tasks.slice(-count).filter(k => k.status === 'halted').length
    const tasksOpen = (count: number) => 2 + Math.max(1, count) + haltedRows(count)
    const activityOpen = (count: number) => 1 + Math.max(1, count)

    // Fit: shrink the lists, then fold what the person can unfold again, but
    // never a section the person opened: their choice wins, and the pane
    // scrolls if they open more than fits.
    const opened = new Set(view.opened ?? [])
    const shut = new Set(view.folded.filter(id => !opened.has(id)))
    // Alerts stay folded behind their notification pill until opened.
    if (!opened.has('alerts')) shut.add('alerts')
    const autoFold = (id: string) => {
      if (!opened.has(id)) shut.add(id)
    }
    let taskCount = Math.min(b.tasks.length, 8)
    let activityCount = 5
    const panels = () =>
      limitRows + tilesRows + (shut.has('burn') ? 1 : burnOpen) + (shut.has('mix') ? 1 : mixOpen) + (shut.has('alerts') ? 1 : 1 + alertRows) +
      (shut.has('tasks') ? 1 : tasksOpen(taskCount)) + (shut.has('activity') ? 1 : activityOpen(activityCount))
    const chrome = 1 + 3 + 1 // header, tabs, footer
    const gaps = 8
    const fits = () => chrome + panels() + gaps <= R
    while (!fits() && taskCount > 5) taskCount -= 1
    while (!fits() && activityCount > 2 && !shut.has('activity')) activityCount -= 1
    for (const id of ['activity', 'mix']) if (!fits()) autoFold(id)
    while (!fits() && taskCount > 3) taskCount -= 1
    for (const id of ['burn', 'tasks']) if (!fits()) autoFold(id)

    const shownTasks = b.tasks.slice(-taskCount)
    const overBudget = b.tasks.filter(k => k.budgetUsd > 0 && k.usd > k.budgetUsd).length
    const taskRight = (
      <Box key="tasks-right">
        <Text color={MUTED}>{`${b.tasks.length} · ${money(spent)}`}</Text>
        {overBudget > 0 && !narrow ? <Text color={RED}>{` · ${overBudget} over`}</Text> : null}
        {b.tasks.length > shownTasks.length && !narrow ? <Text color={FAINT}>{` · latest ${shownTasks.length}`}</Text> : null}
      </Box>
    )
    const activityRight = lastEntry ? (
      <Box key="activity-right">
        <Text color={MUTED}>{`${b.entries.length} · last `}</Text>
        <Text color={TOOL_COLOR[lastEntry.tool] ?? MUTED}>{lastEntry.tool}</Text>
        <Text color={OUTCOME[lastEntry.outcome].color}>{` ${OUTCOME[lastEntry.outcome].glyph}`}</Text>
      </Box>
    ) : (
      muted('empty', 8)
    )
    const activity = b.entries.slice(-activityCount).reverse()
    const newest = b.entries.length - 1

    return (
      <Box key="overview" flexDirection="column">
        {limitsBlock(1)}
        {tilesBlock(1)}
        {section('burn', 'BURN RATE', burnRight, shut.has('burn'), burnBody, 1)}
        {section('mix', 'TOKEN MIX', mixRight, shut.has('mix'), mixBody, 1)}
        {section(
          'tasks',
          'TASKS',
          taskRight,
          shut.has('tasks'),
          <Box key="tasks-body" flexDirection="column">
            {taskHead}
            {b.tasks.length === 0 ? <Text color={FAINT}>{cut('  No task yet. Work counts toward "general".', C)}</Text> : null}
            {shownTasks.map(k => taskRow(k, true))}
          </Box>,
          1,
        )}
        {section(
          'activity',
          'ACTIVITY',
          activityRight,
          shut.has('activity'),
          <Box key="activity-body" flexDirection="column">
            {activity.length === 0 ? <Text color={FAINT}>Waiting for the first step…</Text> : null}
            {activity.map((en, i) => activityRow(en, newest - i, false))}
          </Box>,
          1,
        )}
        {section(
          'alerts',
          'ALERTS',
          <Box key="alerts-right">
            {fresh > 0 ? pill(`● ${fresh} new`, INK, RED) : null}
            <Text color={fresh > 0 ? FAINT : MUTED}>
              {b.trips.length === 0 ? 'none' : `${fresh > 0 ? ' ' : ''}${b.trips.length} total${trip && fresh === 0 ? ` · last ${clockTime(trip.at, true)}` : ''}`}
            </Text>
          </Box>,
          shut.has('alerts'),
          trip !== undefined ? (
            tripCard(trip, 'trip-latest', true, 0, true)
          ) : (
            <Text key="no-alerts" color={FAINT}>{cut('The circuit breaker has not stopped anything yet.', C)}</Text>
          ),
          1,
        )}
        {footer(1)}
      </Box>
    )
  }

  const listHead = (title: string, right: unknown) => (
    <Box key={`${title}-head`} justifyContent="space-between">
      <Text bold>{title}</Text>
      {right}
    </Box>
  )

  const tasksTab = () => {
    const room = Math.max(3, R - 2 - 3 - 6)
    const shown = b.tasks.slice(-room)
    const open = b.tasks.filter(k => k.status === 'open').length
    const closed = b.tasks.filter(k => k.status === 'closed').length
    const halted = b.tasks.filter(k => k.status === 'halted').length
    return (
      <Box key="tasks-tab" flexDirection="column">
        {panel(
          'tasks-card',
          [
            listHead(
              'TASKS',
              <Box key="tasks-tab-right">
                <Text color={MUTED}>{`${open} open · ${closed} closed`}</Text>
                {halted > 0 ? <Text color={RED}>{` · ${halted} halted`}</Text> : null}
                {wide ? <Text color={FAINT}>{' · › its calls'}</Text> : null}
              </Box>,
            ),
            taskHead,
            b.tasks.length === 0 ? <Text key="none" color={FAINT}>  No task yet.</Text> : null,
            b.tasks.length > shown.length ? <Text key="earlier" color={FAINT}>{cut(`  + ${b.tasks.length - shown.length} earlier in ledger.md`, C)}</Text> : null,
            ...shown.map(k => taskRow(k, true)),
            <Box key="tasks-total" marginTop={1} justifyContent="space-between">
              <Text color={FAINT}>total</Text>
              <Text color={MUTED}>{cut(`${money(spent)} · ${compactTokens(b.tokens)} tokens · ${b.tasks.reduce((s, k) => s + k.calls, 0)} calls`, C - 7)}</Text>
            </Box>,
          ],
          1,
        )}
        {footer(1)}
      </Box>
    )
  }

  const activityTab = () => {
    const filter = view.task
    const indexed = b.entries.map((en, i) => ({ en, i })).filter(e => filter === null || e.en.task === filter)
    const expandedRows = view.entry !== null ? 7 : 0
    const room = Math.max(3, R - 2 - 3 - 5 - (filter ? 1 : 0) - expandedRows)
    const shown = indexed.slice(-room).reverse()
    const filterName = filter ? b.tasks.find(k => k.id === filter)?.name ?? filter : null
    return (
      <Box key="activity-tab" flexDirection="column">
        {panel(
          'activity-card',
          [
            listHead('ACTIVITY', muted(`${indexed.length} entries · newest first${wide ? ' · › details' : ''}`, C - 6)),
            filterName !== null ? (
              <Box key="activity-filter">
                <Text color={MUTED}>{'task '}</Text>
                {pill(cut(filterName, Math.max(4, C - 22)), INK, GOLD)}
                <Text>{'  '}</Text>
                {link('clear-filter', 'show all ✕', () => act.drill(null))}
              </Box>
            ) : null,
            shown.length === 0 ? <Text key="none" color={FAINT}>No activity yet.</Text> : null,
            ...shown.map(e => activityRow(e.en, e.i, true)),
            indexed.length > shown.length ? <Text key="earlier" color={FAINT}>{cut(`+ ${indexed.length - shown.length} earlier entries in ledger.md`, C)}</Text> : null,
          ],
          1,
        )}
        {footer(1)}
      </Box>
    )
  }

  const alertsTab = () => {
    const newest = [...b.trips].reverse()
    const shown: Trip[] = []
    let rows = 2 + 3 + 2
    for (const t of newest) {
      const need = tripRowsOf(t, shown.length === 0) + 1
      if (shown.length > 0 && rows + need > R) break
      shown.push(t)
      rows += need
    }
    return (
      <Box key="trips-tab" flexDirection="column">
        {shown.length === 0
          ? panel(
              'no-trips',
              [
                <Text key="no-trips-title" bold color={GREEN}>✓ NO ALERTS</Text>,
                <Text key="no-trips-text" color={FAINT}>{cut('The circuit breaker has not stopped anything yet.', C)}</Text>,
              ],
              1,
            )
          : shown.map((t, i) => tripCard(t, i === 0 ? 'trip-latest-tab' : `trip-${i}`, i === 0, 1))}
        {newest.length > shown.length ? <Text color={FAINT}>{cut(`+ ${newest.length - shown.length} earlier alerts in ledger.md`, inner)}</Text> : null}
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
        {panel(
          'agents-card',
          [
            listHead('AGENTS', muted('tokens exact · cost by reply', C - 8)),
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
                      {`${wide ? `${lpad(String(a.steps), 6)}${lpad(String(a.calls), 6)}` : ''}${lpad(compactTokens(a.tokens), 8)}${lpad(money(a.usd), 8)}`}
                    </Text>
                    <Text color={GREEN}>{lpad(hit(cacheHit(a.mix)), 7)}</Text>
                  </Box>
                  {a.model !== undefined ? (
                    <Text color={FAINT}>{cut(`    ${a.model}${a.type ? ` · ${a.type}` : ''}${a.status && a.id !== MAIN ? ` · ${a.status}` : ''}`, C)}</Text>
                  ) : null}
                </Box>
              )
            }),
          ],
          1,
        )}
        {footer(1)}
      </Box>
    )
  }

  const body =
    view.tab === 'tasks' ? tasksTab()
    : view.tab === 'activity' ? activityTab()
    : view.tab === 'alerts' ? alertsTab()
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

// A view as older versions saved it, with the old names for its tabs and sections.
const RENAMED: Record<string, string> = { khatas: 'tasks', tape: 'activity', trips: 'alerts' }
const TAB_IDS: readonly Tab[] = ['overview', 'tasks', 'activity', 'alerts', 'agents']

export const migrateView = (saved: unknown): View => {
  const v = (saved ?? {}) as Partial<View> & { khata?: string | null; tab?: string }
  const rename = (id: string) => RENAMED[id] ?? id
  const tab = rename(v.tab ?? 'overview') as Tab
  return {
    tab: TAB_IDS.includes(tab) ? tab : 'overview',
    folded: (v.folded ?? DEFAULT_VIEW.folded).map(rename),
    opened: (v.opened ?? []).map(rename),
    task: v.task ?? v.khata ?? null,
    entry: v.entry ?? null,
  }
}
