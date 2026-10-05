import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SessionSummary, Tab, View } from '../types'
import {
  addTrip,
  allowOnce,
  ledgerMarkdown,
  bookCost,
  bookTokens,
  check,
  endTask,
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
  startTask,
  parseMarker,
  raiseBudget,
  record,
  setLimits,
  skipTask,
  statement,
  summarize,
  summary,
  toolLabel,
} from './ledger'
import type { Limits, Usage } from './ledger'
import { DEFAULT_VIEW, drawBar, drawPane, migrateView, toggleSection } from './pane'

const PANE = 'tokenmunim'
const OWN = 'mcp__tokenmunim__'
// Tools the agent needs to get itself out of a halt are never blocked.
const EXEMPT = new Set(['ToolSearch'])
const HISTORY_KEY = 'history'
const TABS: readonly Tab[] = ['overview', 'tasks', 'activity', 'alerts', 'agents']
const SECTIONS: readonly string[] = ['burn', 'mix', 'tasks', 'activity', 'alerts']
const book = atom({ plugin: 'tokenmunim', key: 'book' } as const, emptyBook())
const view = atom({ plugin: 'tokenmunim', key: 'view' } as const, DEFAULT_VIEW)
const bar = atom({ plugin: 'tokenmunim', key: 'bar' } as const, { shown: false, open: false })

const fileStamp = (ms: number) => {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

// Where this session's ledger lives, worked out once per load.
let limits: Limits = limitsFrom({})
let cwd: string | undefined
let home: string | undefined
let startedAt = 0
let ledgerFile: string | undefined
let isAlerting = false
let agentsCheckedAt = 0

async function costNow($: EngineInterface) {
  return (await $.session.usage()).cost?.usd
}

async function locate($: EngineInterface) {
  if (ledgerFile !== undefined) return
  try {
    startedAt = (await $.session.usage()).startedAt
    cwd = (await $.fs.stat('.', { resolve: true })).realPath
    home = await $.env.get('HOME')
    if (cwd) ledgerFile = `${cwd}/.tokenmunim/ledger-${fileStamp(startedAt)}.md`
  } catch {
    // No file system here (a test, a remote host): the pane still works.
  }
}

// The ledger file is best effort: a failed write never gets in the agent's way.
async function writeLedger($: EngineInterface): Promise<string | undefined> {
  try {
    await locate($)
    if (ledgerFile === undefined || cwd === undefined) return undefined
    const b = normalize(await read($, book))
    const now = await $.clock.now()
    await $.fs.write(`${cwd}/.tokenmunim/.gitignore`, '*\n')
    await $.fs.write(ledgerFile, ledgerMarkdown(b, { startedAt, now, cwd, limits }))
    return ledgerFile
  } catch {
    return undefined
  }
}

async function openLedger($: EngineInterface) {
  const file = await writeLedger($)
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
// and halt its task if the reply carried it past its budget.
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

// Opens or closes the dashboard. The bar shows whenever the dashboard has been
// asked for, and its button follows the pane, however the pane was closed.
async function setPane($: EngineInterface, open: boolean) {
  try {
    if (open) await $.ui.open({ id: PANE, title: 'TokenMunim' })
    else await $.ui.close({ id: PANE })
  } catch {
    // A surface with no panes: the bar and the ledger still work.
  }
  await update($, bar, () => ({ shown: true, open }))
}

async function togglePane($: EngineInterface) {
  let isOpen = (await read($, bar)).open
  try {
    isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  } catch {
    // Fall back to what the bar last knew.
  }
  await setPane($, !isOpen)
}

// The status line is an alarm, not a ticker: it shows while a circuit is tripped.
function alarm($: EngineInterface, text: string | undefined) {
  if (text === undefined && !isAlerting) return
  isAlerting = text !== undefined
  $.ui.status(text)
}

// What the person did from the circuit card.
async function decide($: EngineInterface, kind: 'raise' | 'allow' | 'skip', taskId?: string, by?: number) {
  const b = normalize(await read($, book))
  const name = b.tasks.find(k => k.id === taskId)?.name ?? 'the task'
  if (kind === 'raise' && taskId !== undefined && by !== undefined) {
    await update($, book, cur => raiseBudget(normalize(cur), taskId, by))
    $.ui.toast(`TokenMunim: ${name} gets ${money(by)} more budget`)
  } else if (kind === 'allow') {
    await update($, book, cur => allowOnce(normalize(cur)))
    $.ui.toast('TokenMunim: the next call goes through')
  } else if (kind === 'skip' && taskId !== undefined) {
    await update($, book, cur => skipTask(normalize(cur), taskId))
    $.ui.toast(`TokenMunim: ${name} skipped; the agent moves on at its next call`)
  }
  alarm($, undefined)
  await writeLedger($)
}

export const register: Register = (on, options) => {
  limits = limitsFrom(options)
  const openOnStart = options.openOnStart === true

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'start_task',
      description:
        'Start a task: TokenMunim tracks its cost, tokens, calls and failures separately from everything else, with an optional budget. Call it when you begin each distinct piece of work in a batch; it ends the task before it. If TokenMunim halts a task, start the next one to continue.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short name of the task, like "strategy 3" or "migrate billing service".' },
          budget_usd: { type: 'number', description: 'Optional budget in USD for this task.' },
        },
        required: ['name'],
      },
    })
    await $.tool.register({
      name: 'end_task',
      description: 'End the current task when its work is done.',
    })
    await $.command.register({
      name: 'munim',
      description: 'TokenMunim: show its button for this session, or open, close, off, statement, ledger, tab, fold, unfold, task, end, reset',
      argumentHint: 'open | close | off | statement | ledger | tab <name> | fold <section> | unfold <section> | task <name> | end | reset',
    })
    await locate($)
    // A status line left by an earlier load is stale; the alarm starts quiet.
    $.ui.status(undefined)
    // Nothing shows until the person asks for it, unless they set it to open.
    if (openOnStart) await setPane($, true)
    return next(e)
  })

  on('tool.call', { tool: 'mcp__tokenmunim__start_task' }, async ($, e) => {
    const name = typeof e.name === 'string' && e.name.trim() !== '' ? e.name.trim() : 'task'
    const budget = typeof e.budget_usd === 'number' && e.budget_usd > 0 ? e.budget_usd : limits.taskBudgetUsd
    const now = await $.clock.now()
    const usd = await costNow($)
    const halted = haltedNamed(normalize(await read($, book)), name)
    if (halted !== undefined) {
      return { result: `Task "${halted.name}" was halted (${halted.haltReason ?? 'over budget'}) and stays halted. Tell the user, then start a different task or stop.` }
    }
    await update($, book, b => startTask(bookCost(normalize(b), usd, now, e.agentId), name, budget, now)[0])
    alarm($, undefined)
    await writeLedger($)
    return { result: `Task "${name}" started with a budget of ${money(budget)}. Its cost, tokens and calls are now tracked on their own.` }
  })

  on('tool.call', { tool: 'mcp__tokenmunim__end_task' }, async ($, e) => {
    const now = await $.clock.now()
    const usd = await costNow($)
    await update($, book, b => endTask(bookCost(normalize(b), usd, now, e.agentId)))
    await writeLedger($)
    return { result: 'Task ended.' }
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
        marker.verb === 'end' ? 'Task ended.' : `Task "${marker.name}" started with a budget of ${money(marker.budgetUsd ?? limits.taskBudgetUsd)}.`
      await update($, book, b => {
        const charged = bookCost(normalize(b), usd, startedAtMs, agentId)
        return marker.verb === 'end'
          ? endTask(charged)
          : startTask(charged, marker.name, marker.budgetUsd ?? limits.taskBudgetUsd, startedAtMs)[0]
      })
      await writeLedger($)
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
        const task = cur.tasks.find(k => k.id === cur.active)
        const blocked = record(cur, { ...base, ms: 0, outcome: 'blocked', note: stop.kind }, fp)
        // A task that stays halted is one trip, not one per call that bumps into it.
        const last = cur.trips[cur.trips.length - 1]
        if (stop.kind === 'halted' && last !== undefined && last.taskId === task?.id && last.resolved === undefined) return blocked
        return addTrip(blocked, {
          at: startedAtMs,
          kind: stop.kind,
          task: task?.name ?? 'general',
          taskId: task?.id,
          tool: base.tool,
          summary: base.summary,
          reason: stop.short,
        })
      })
      $.ui.toast(`⊘ TokenMunim: ${stop.short}`)
      alarm($, `circuit tripped · ${stop.kind} · ${stop.short}`)
      await writeLedger($)
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
    const saved = (await $.store.get(HISTORY_KEY)) as SessionSummary[] | undefined
    const others = (saved ?? []).filter(s => s.startedAt !== usage.startedAt)
    await $.store.set(HISTORY_KEY, [...others, summary(normalize(b), usage.startedAt)].slice(-50))
    await writeLedger($)
    return next(e)
  })

  on('command.run', { command: 'munim' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const now = await $.clock.now()

    if (verb === '' || verb === 'bar') {
      await update($, bar, cur => ({ ...cur, shown: true }))
      return { text: 'TokenMunim is on for this session. Click the TokenMunim button above the prompt to open the dashboard, and click it again to close it.' }
    }
    if (verb === 'open' || verb === 'pane') {
      await setPane($, true)
      return { text: 'TokenMunim dashboard is open.' }
    }
    if (verb === 'close') {
      await setPane($, false)
      return { text: 'TokenMunim dashboard is closed. Click the TokenMunim button above the prompt to bring it back.' }
    }
    if (verb === 'off') {
      await setPane($, false)
      await update($, bar, () => ({ shown: false, open: false }))
      return { text: 'TokenMunim is out of sight for this session, and still protecting it. Run /munim to bring the button back.' }
    }
    if (verb === 'tab') {
      const tab = TABS.find(t => t === (rest[0] ?? '').toLowerCase())
      if (tab === undefined) return { text: `Tabs: ${TABS.join(', ')}.` }
      await update($, view, cur => ({ ...migrateView(cur), tab, entry: null }))
      await setPane($, true)
      return { text: `TokenMunim is showing ${tab}.` }
    }
    if (verb === 'fold' || verb === 'unfold') {
      const id = (rest[0] ?? '').toLowerCase()
      if (!SECTIONS.includes(id)) return { text: `Sections: ${SECTIONS.join(', ')}.` }
      await update($, view, cur => toggleSection({ ...migrateView(cur) }, id, verb === 'unfold'))
      await setPane($, true)
      return { text: `${verb === 'fold' ? 'Folded' : 'Opened'} ${id}.` }
    }
    if (verb === 'task') {
      const name = rest.join(' ').trim() || 'task'
      const usd = await costNow($)
      await update($, book, b => startTask(bookCost(normalize(b), usd, now), name, limits.taskBudgetUsd, now)[0])
      alarm($, undefined)
      await writeLedger($)
      return { text: `Task "${name}" started with a budget of ${money(limits.taskBudgetUsd)}.` }
    }
    if (verb === 'end') {
      await update($, book, b => endTask(normalize(b)))
      await writeLedger($)
      return { text: 'Task ended.' }
    }
    if (verb === 'reset') {
      await update($, book, () => emptyBook())
      await update($, view, () => DEFAULT_VIEW)
      alarm($, undefined)
      return { text: 'TokenMunim book reset for this session.' }
    }
    if (verb === 'ledger' || verb === 'export') {
      const file = await writeLedger($)
      if (file === undefined) return { text: 'The ledger file could not be written here.' }
      if (verb !== 'export') await $.process.run(['open', file])
      return { text: `Ledger written to ${file}` }
    }

    const usage = await $.session.usage()
    const b = normalize(await update($, book, cur => bookCost(normalize(cur), usage.cost?.usd, now)))
    const saved = ((await $.store.get(HISTORY_KEY)) as SessionSummary[] | undefined) ?? []
    const file = await writeLedger($)
    if (verb === 'statement') return { text: statement(b, limits, saved.filter(s => s.startedAt !== usage.startedAt), file) }
    return { text: `Unknown option "${verb}". Try: open, close, off, statement, ledger, tab <name>, fold <section>, unfold <section>, task <name>, end, reset.` }
  })

  on('ui.close', async ($, e, next) => {
    const done = await next(e)
    if (e.id === PANE) await update($, bar, cur => ({ ...cur, open: false }))
    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, bar)
    if (!shown.shown || e.props.hasSurvey) return next(e)
    return drawBar($.ui.resolve(e), shown.open, () => void togglePane($))
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const kit = $.ui.resolve(e)
    // A reload forgets where the ledger lives; find it again on the first draw.
    if (ledgerFile === undefined) await locate($)
    const b = normalize(await read($, book))
    const v: View = migrateView(await read($, view))
    const now = await $.clock.now()
    const rows = e.props.scroll?.bodyRows ?? (e.viewport?.rows ?? 50) - 6
    return drawPane(
      kit,
      { book: b, view: v, now, limits, width: e.props.bodyColumns, rows, hasFile: ledgerFile !== undefined, startedAt },
      {
        setTab: tab => void update($, view, cur => ({ ...migrateView(cur), tab, entry: null })),
        toggle: (id, isFolded) => void update($, view, cur => toggleSection({ ...migrateView(cur) }, id, isFolded)),
        drill: task => void update($, view, cur => ({ ...migrateView(cur), task, tab: task === null ? cur.tab : 'activity', entry: null })),
        expand: entry => void update($, view, cur => ({ ...migrateView(cur), entry })),
        openLedger: () => void openLedger($),
        close: () => void setPane($, false),
        raise: (taskId, by) => void decide($, 'raise', taskId, by),
        allow: () => void decide($, 'allow'),
        skip: taskId => void decide($, 'skip', taskId),
      },
    )
  })
}
