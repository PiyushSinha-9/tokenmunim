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
                                                     └──► bahi file (.tokenmunim/)
```

* **Hooks** live in `plugin/hooks/register.tsx`: `tool.call` gates and records every call, `turn.step` books each reply's usage, `turn.complete` saves the session summary and the ledger file, `command.run` serves `/munim`, and `ui.render` draws the pane.
* **Rules** live in `plugin/hooks/ledger.ts`: pure functions from a book to a book. Booking cost, opening a khata, deciding a trip and recording an entry are each a function with no I/O, which is what makes them easy to test and safe to retry.
* **State** is one value in the session's state store, so the pane redraws exactly when it changes and survives the mod being hot reloaded mid session. Writes go through a read, apply and compare loop, so two tool calls finishing together can't lose an update.
* **The bahi file** is written at the moments that matter (a khata opens or closes, a circuit trips, a turn ends), never on every call. Writing it is best effort: a failed write never gets in the agent's way.

## Cost and tokens

* **Cost** comes from the session's own ledger, the same figure `/cost` prints. TokenMunim takes the difference since its last reading and books it to the khata that was open.
* **Tokens** come from each reply's usage as the API reported it: uncached input, cache reads, cache writes and output. Cache reads are counted because they are tokens the model really read, which is why a long session with a big context shows a high token rate.
* **A reading arrives late.** Cost is only known when the next call or reply lands, so a long think followed by one call looks like a spike. Every delta is spread over the time it was actually spent before rates are worked out. A unit test pins this: three dollars over ten minutes is thirty cents a minute, not a three dollar spike.
* **Known limit.** Attribution is by time: whatever khata is open when a cost lands gets it. Parallel subagents working on different tasks under one khata are booked together.

## The circuit breaker

**Block the call, never kill the session.** A tripped circuit answers the tool call with a denial and a reason the agent can act on. An exchange halts one stock, not the market, and the agent works the same way: it reads why, changes approach, or moves to the next task.

| Circuit | Rule | Design choice |
|---|---|---|
| Loop | The same action fails `loopLimit` times in a row in a khata | "The same" is the tool plus its main argument, with long digit runs folded, so a timestamp in a URL doesn't hide a loop. Any success resets the streak, so fixing the code and rerunning the same command is allowed. |
| Burn | Spend over two minutes is above the rate limit | A two minute window ignores one expensive reply. It pauses the agent once, then stays quiet for two minutes so it can't lock the agent out. |
| Budget | A khata's spend reaches its budget | Checked before every call and after every reply, so a reply that crosses the line halts the khata before the next call. |
| Session | Total spend reaches the session budget | The last line of defence. Counted from when TokenMunim started, not from when the session did. |

**Never blocked:** the mod's own tools and `ToolSearch`, because an agent that is told to open a new khata has to be able to reach the tool that does it.

## Found by using it

TokenMunim watched its own development session, and that session broke it four times. Each one is now a rule and a test.

1. **It locked out its own author.** The catch-all khata for unassigned work had the default $1 budget. Two minutes of real work crossed it, the khata halted, and every tool call was blocked, including the one needed to escape. The catch-all khata now has no budget of its own, and the tools needed to recover are never blocked.
2. **Defaults in two places.** The manifest's declared defaults overrode the code's, so a new burn limit never took effect. A test running against the manifest caught it, and the manifest is now the one source of defaults.
3. **Overspend between calls.** In a demo run, one khata went to 142% of its budget inside a single reply, with no tool call in between to stop it. Budgets are now also checked after every reply.
4. **Reopening a halted task.** Told that a khata was halted, an agent could open a new khata with the same name and carry on. Halted khatas now refuse to reopen by name, and the message tells the agent to leave the task.

## The pane

* **Fixed frames.** Every section has a height budget worked out from the pane's own visible rows: the tape shows at most ten entries and the khata table at most eight, with older ones in the bahi file. A long session never floods the screen.
* **Color carries meaning only.** Gold is the ledger, green is healthy, amber is close, red is over. Everything else is muted.
* **One source of truth.** The pane reads the same book the circuit breaker writes, so what you see is what the rules acted on.

## Testing

`claude plugin test ./plugin` runs the suite against the engine's own test kit, with a mocked clock, store and cost ledger:

* Each circuit end to end: a loop blocked on its third failure, a khata halted over budget, a burn pause that lets work resume, a session that keeps working when only the catch-all khata is busy.
* The rules that came from the incidents above, one test each.
* The pane drawn on both the terminal and the desktop app, checked for its khatas, its circuit card and its tape.

CI runs validation and the suite on every push.
