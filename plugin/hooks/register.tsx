import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SessionSummary, Tab, View } from '../types'
import {
  addTrip,
  allowOnce,
  bahiMarkdown,
  bookCost,
  bookTokens,
  check,
  closeKhata,
  emptyBook,
  fingerprint,
  haltIfOver,
  haltedNamed,
  limitsFrom,
  MAIN,
  money,
  nameAgents,
  noteAgentCall,
  normalize,
  openKhata,
  parseMarker,
  raiseBudget,
  record,
  setLimits,
  skipKhata,
  statement,
  summarize,
  summary,
  toolLabel,
} from './ledger'
import type { Limits, Usage } from './ledger'
import { DEFAULT_VIEW, drawPane } from './pane'

const PANE = 'tokenmunim'
const OWN = 'mcp__tokenmunim__'
// Tools the agent needs to get itself out of a halt are never blocked.
const EXEMPT = new Set(['ToolSearch'])
const BAHI_KEY = 'bahi'
const TABS: readonly Tab[] = ['overview', 'khatas', 'tape', 'trips', 'agents']
const book = atom({ plugin: 'tokenmunim', key: 'book' } as const, emptyBook())
const view = atom({ plugin: 'tokenmunim', key: 'view' } as const, DEFAULT_VIEW)

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
let agentsCheckedAt = 0

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

// Names and states for subagents, from the engine's list, a few seconds apart.
async function refreshAgents($: EngineInterface, now: number) {
  if (now - agentsCheckedAt < 5_000) return
  agentsCheckedAt = now
  try {
    const b = normalize(await read($, book))
    if (!b.agents.some(a => a.id !== MAIN)) return
    const infos = await $.agent.list()
    await update($, book, cur =>
      nameAgents(normalize(cur), infos.map(i => ({ id: i.id, description: i.description, type: i.type, status: i.status }))),
    )
  } catch {
    // Names are a nicety; the numbers stand without them.
  }
}

// One model request finished: book its tokens, its cost and the plan limits,
// and halt its khata if the reply carried it past its budget.
async function noteStep($: EngineInterface, usage: Usage, agentId: string | undefined) {
  try {
    const now = await $.clock.now()
    const s = await $.session.usage()
    await update($, book, b =>
      haltIfOver(setLimits(bookCost(bookTokens(normalize(b), usage, now, agentId), s.cost?.usd, now, agentId), s.rateLimits, now), now),
    )
    if (agentId !== undefined) await refreshAgents($, now)
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

// What the person did from the circuit card.
async function decide($: EngineInterface, kind: 'raise' | 'allow' | 'skip', khataId?: string, by?: number) {
  const b = normalize(await read($, book))
  const name = b.khatas.find(k => k.id === khataId)?.name ?? 'the khata'
  if (kind === 'raise' && khataId !== undefined && by !== undefined) {
    await update($, book, cur => raiseBudget(normalize(cur), khataId, by))
    $.ui.toast(`TokenMunim: ${name} gets ${money(by)} more budget`)
  } else if (kind === 'allow') {
    await update($, book, cur => allowOnce(normalize(cur)))
    $.ui.toast('TokenMunim: the next call goes through')
  } else if (kind === 'skip' && khataId !== undefined) {
    await update($, book, cur => skipKhata(normalize(cur), khataId))
    $.ui.toast(`TokenMunim: ${name} skipped; the agent moves on at its next call`)
  }
  alarm($, undefined)
  await writeBahi($)
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
          name: { type: 'string', description: 'Short name of the task, like "strategy 3" or "migrate billing service".' },
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
      description: 'TokenMunim: open the pane, or statement, bahi, tab <name>, khata <name>, close, reset',
      argumentHint: 'statement | bahi | tab <overview|khatas|tape|trips|agents> | khata <name> | close | reset',
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
    await update($, book, b => openKhata(bookCost(normalize(b), usd, now, e.agentId), name, budget, now)[0])
    alarm($, undefined)
    await writeBahi($)
    return { result: `Khata "${name}" is open with a budget of ${money(budget)}. Work for this task is now booked to it.` }
  })

  on('tool.call', { tool: 'mcp__tokenmunim__close_khata' }, async ($, e) => {
    const now = await $.clock.now()
    const usd = await costNow($)
    await update($, book, b => closeKhata(bookCost(normalize(b), usd, now, e.agentId)))
    await writeBahi($)
    return { result: 'Khata closed.' }
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (tool.startsWith(OWN) || EXEMPT.has(tool)) return next(e)

    const input = e as unknown as Readonly<Record<string, unknown>>
    const agentId = e.agentId
    const startedAtMs = await $.clock.now()
    const usage = await $.session.usage()
    const usd = usage.cost?.usd

    const marker = tool === 'Bash' && typeof input.command === 'string' ? parseMarker(input.command) : null
    if (marker !== null) {
      const said =
        marker.verb === 'close' ? 'Khata closed.' : `Khata "${marker.name}" is open with a budget of ${money(marker.budgetUsd ?? limits.khataBudgetUsd)}.`
      await update($, book, b => {
        const charged = bookCost(normalize(b), usd, startedAtMs, agentId)
        return marker.verb === 'close'
          ? closeKhata(charged)
          : openKhata(charged, marker.name, marker.budgetUsd ?? limits.khataBudgetUsd, startedAtMs)[0]
      })
      await writeBahi($)
      return { result: { stdout: said, stderr: '', interrupted: false }, text: said } as never
    }

    const fp = fingerprint(tool, input)
    const base = { at: startedAtMs, tool: toolLabel(tool), summary: summarize(tool, input, cwd, home), agent: agentId }

    let verdict: ReturnType<typeof check>[1] = null
    await update($, book, b => {
      const charged = noteAgentCall(setLimits(bookCost(normalize(b), usd, startedAtMs, agentId), usage.rateLimits, startedAtMs), agentId, startedAtMs)
      const [checked, v] = check(charged, fp, limits, startedAtMs)
      verdict = v
      return checked
    })

    const stop = verdict as ReturnType<typeof check>[1]
    if (stop !== null) {
      await update($, book, b => {
        const cur = normalize(b)
        const khata = cur.khatas.find(k => k.id === cur.active)
        const blocked = record(cur, { ...base, ms: 0, outcome: 'blocked', note: stop.kind }, fp)
        return addTrip(blocked, {
          at: startedAtMs,
          kind: stop.kind,
          khata: khata?.name ?? 'general',
          khataId: khata?.id,
          tool: base.tool,
          summary: base.summary,
          reason: stop.short,
        })
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
    if (result.usage) await noteStep($, result.usage, e.agentId)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    const usage = await $.session.usage()
    const b = await update($, book, cur => setLimits(bookCost(normalize(cur), usage.cost?.usd, now, e.agentId), usage.rateLimits, now))
    await refreshAgents($, now)
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
    if (verb === 'tab') {
      const tab = TABS.find(t => t === (rest[0] ?? '').toLowerCase())
      if (tab === undefined) return { text: `Tabs: ${TABS.join(', ')}.` }
      await update($, view, cur => ({ ...DEFAULT_VIEW, ...cur, tab, entry: null }))
      await $.ui.open({ id: PANE, title: 'TokenMunim' })
      return { text: `TokenMunim is showing ${tab}.` }
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
      await update($, view, () => DEFAULT_VIEW)
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
    return { text: `Unknown option "${verb}". Try: statement, bahi, tab <name>, khata <name>, close, reset.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const kit = $.ui.resolve(e)
    // A reload forgets where the bahi lives; find it again on the first draw.
    if (bahiFile === undefined) await locate($)
    const b = normalize(await read($, book))
    const v: View = { ...DEFAULT_VIEW, ...(await read($, view)) }
    const now = await $.clock.now()
    const rows = e.props.scroll?.bodyRows ?? (e.viewport?.rows ?? 50) - 6
    return drawPane(
      kit,
      { book: b, view: v, now, limits, width: e.props.bodyColumns, rows, hasFile: bahiFile !== undefined },
      {
        setTab: tab => void update($, view, cur => ({ ...DEFAULT_VIEW, ...cur, tab, entry: null })),
        toggle: id =>
          void update($, view, cur => {
            const base = { ...DEFAULT_VIEW, ...cur }
            return { ...base, folded: base.folded.includes(id) ? base.folded.filter(x => x !== id) : [...base.folded, id] }
          }),
        drill: khata => void update($, view, cur => ({ ...DEFAULT_VIEW, ...cur, khata, tab: khata === null ? cur.tab : 'tape', entry: null })),
        expand: entry => void update($, view, cur => ({ ...DEFAULT_VIEW, ...cur, entry })),
        openBahi: () => void openBahi($),
        raise: (khataId, by) => void decide($, 'raise', khataId, by),
        allow: () => void decide($, 'allow'),
        skip: khataId => void decide($, 'skip', khataId),
      },
    )
  })
}
