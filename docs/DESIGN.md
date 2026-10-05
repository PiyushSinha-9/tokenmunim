# TokenMunim design

## The problem

Agents now run for hours without anyone watching. When one gets stuck, it rarely crashes: it retries, rereads, rewrites, and keeps spending. The session total tells you what you spent, but not which task spent it, and nothing stops the spending while it happens.

TokenMunim answers three questions while the agent works, not after:

1. **Where is the money going?** Cost and tokens per task.
2. **What did the agent actually do?** A complete, readable record.
3. **When should it stop?** Rules that block a call before it runs.

## Shape

```
 tool call ──► check ──► run ──► record ─┐
 model reply ──► book tokens and cost ───┼──► Book (session state) ──► pane
 turn end ──► session summary ───────────┘          │
                                                     └──► ledger file (.tokenmunim/)
```

* **Hooks** live in `plugin/hooks/register.tsx`: `tool.call` gates and records every call, `turn.step` books each reply's usage, `turn.complete` saves the session summary and the ledger file, `command.run` serves `/munim`, and `ui.render` draws the pane.
* **Drawing** lives in `plugin/hooks/pane.tsx`: a pure function from the book and the view to an element tree. It never touches the engine; every button calls back through a small set of actions the hooks module hands it.
* **Rules** live in `plugin/hooks/ledger.ts`: pure functions from a book to a book. Booking cost, opening a task, deciding a trip and recording an entry are each a function with no I/O, which is what makes them easy to test and safe to retry.
* **State** is two values in the session's state store: the book, and the pane's own view (tab, folded sections, drill-down). Keeping them apart means clicking around the pane can never change the accounting. The book redraws the pane exactly when it changes and survives the mod being hot reloaded mid session. Writes go through a read, apply and compare loop, so two tool calls finishing together can't lose an update.
* **The ledger file** is written at the moments that matter (a task opens or closes, a circuit trips, a turn ends), never on every call. Writing it is best effort: a failed write never gets in the agent's way.

## Cost and tokens

* **Cost** comes from the session's own ledger, the same figure `/cost` prints. TokenMunim takes the difference since its last reading and books it to the task that was open.
* **Tokens** come from each reply's usage as the API reported it: uncached input, cache reads, cache writes and output. Cache reads are counted because they are tokens the model really read, which is why a long session with a big context shows a high token rate.
* **A reading arrives late.** Cost is only known when the next call or reply lands, so a long think followed by one call looks like a spike. Every delta is spread over the time it was actually spent before rates are worked out. A unit test pins this: three dollars over ten minutes is thirty cents a minute, not a three dollar spike.
* **Per agent.** Each reply arrives tagged with the loop that made it, so tokens per agent are exact. Cost is booked per reply too: the session's cost difference since the last reading goes to the loop whose reply brought it.
* **Known limit.** Tasks are booked by time: whatever task is open when a cost lands gets it, so parallel subagents working on different tasks under one task share it. Per agent cost is exact for sequential replies and an approximation when two replies land together.

## The circuit breaker

**Block the call, never kill the session.** A tripped circuit answers the tool call with a denial and a reason the agent can act on. An exchange halts one stock, not the market, and the agent works the same way: it reads why, changes approach, or moves to the next task.

| Circuit | Rule | Design choice |
|---|---|---|
| Loop | The same action fails `loopLimit` times in a row in a task | "The same" is the tool plus its main argument, with long digit runs folded, so a timestamp in a URL doesn't hide a loop. Any success resets the streak, so fixing the code and rerunning the same command is allowed. |
| Burn | Spend over two minutes is above the rate limit | A two minute window ignores one expensive reply. It pauses the agent once, then stays quiet for two minutes so it can't lock the agent out. |
| Budget | A task's spend reaches its budget | Checked before every call and after every reply, so a reply that crosses the line halts the task before the next call. |
| Session | Total spend reaches the session budget | The last line of defence. Counted from when TokenMunim started, not from when the session did. |

**Never blocked:** the mod's own tools and `ToolSearch`, because an agent that is told to open a new task has to be able to reach the tool that does it.

## Plain words

Version 0.6 replaced the first names, which came from an Indian shop's books (khata for a task's account, bahi for the ledger, tape for the call record), with words anyone can read: tasks, the ledger, activity, alerts. The name TokenMunim keeps the story; the product speaks plainly. Ledgers saved by older versions are migrated on load, so nothing recorded is lost, and a saved view with the old tab names opens on the new ones.

## Found by using it

TokenMunim watched its own development session, and that session broke it four times. Each one is now a rule and a test.

1. **It locked out its own author.** The catch-all task for unassigned work had the default $1 budget. Two minutes of real work crossed it, the task halted, and every tool call was blocked, including the one needed to escape. The catch-all task now has no budget of its own, and the tools needed to recover are never blocked.
2. **Defaults in two places.** The manifest's declared defaults overrode the code's, so a new burn limit never took effect. A test running against the manifest caught it, and the manifest is now the one source of defaults.
3. **Overspend between calls.** In a demo run, one task went to 142% of its budget inside a single reply, with no tool call in between to stop it. Budgets are now also checked after every reply.
4. **Reopening a halted task.** Told that a task was halted, an agent could open a new task with the same name and carry on. Halted tasks now refuse to reopen by name, and the message tells the agent to leave the task.

## Plan limits runway

The API reports how much of each plan window (5 hour, weekly) is used. TokenMunim keeps twenty minutes of those readings per window and works out the pace in points per minute. Dividing what is left by that pace gives the minutes until the window runs out, and comparing that with the window's reset time gives the answer that matters: this pace makes it to the reset, or it runs out in 42 minutes. Until there are two minutes of readings it says it is measuring rather than guess, and a window that resets starts its history over.

## Acting from the pane

Each button on a circuit card is a pure function on the book, recorded on the trip it answers:

* **Raise budget** adds half the task's budget (at least five cents). A task halted for its budget can carry on; one the agent already left stays closed.
* **Allow once** adds a pass. The next call that a circuit would stop uses the pass up instead, and goes through.
* **Skip task** halts the task, so the agent's next call there is told to move on.

## The pane

* **Tabs.** Overview, Tasks, Activity, Alerts and Agents. The overview is a dashboard; each other tab gives one list the full height.
* **Fits any width.** The pane is laid out for the columns it actually has, in three tiers. As it narrows, the task table drops its tokens column and then its calls column, activity rows shorten their timestamps, tab labels lose their counts and then shorten, and every bar stretches or shrinks. Text is cut to fit, never padded past its frame. A test draws every tab at four widths on both surfaces.
* **Fixed frames.** The overview fits itself to the pane's visible rows: it trims the task list first, then folds the recent activity, the token mix and the burn chart, in that order, into one line summaries. No list ever grows past its frame, and older rows live in the ledger file.
* **The person's choice wins.** The view remembers what the person folded and what they opened. The pane only ever folds sections the person has not opened, so a section they open stays open, and if they open more than fits, the pane scrolls. The first version folded a section straight back after it was opened whenever room was short, which made the fold arrows look dead; a test now clicks every section at four pane sizes.
* **Color carries meaning only.** Gold is the ledger, green is healthy, amber is close, red is over. Everything else is muted.
* **One source of truth.** The pane reads the same book the circuit breaker writes, so what you see is what the rules acted on.

## Testing

`claude plugin test ./plugin` runs the suite against the engine's own test kit, with a mocked clock, store and cost ledger:

* Each circuit end to end: a loop blocked on its third failure, a task halted over budget, a burn pause that lets work resume, a session that keeps working when only the catch-all task is busy.
* The rules that came from the incidents above, one test each.
* The pane drawn on both the terminal and the desktop app: every tab at four widths, the tabs switching, a section folding and unfolding, a task opening its own calls, and the alert's buttons raising a budget and letting one call through a loop.

CI runs validation and the suite on every push.
