# usage-bar

One band of tinted pills above the prompt in the Claude desktop app's Code tab:

```
(◑ 371k ▁▃▂█ ▲ +17.6k) (◷ 5h ━━━╍╍──── 7% ↺ 2h 53m) (▦ 7d ━━━━━━━╍─ 77% ↺ 22h 53m) (⚡ 51m [↻ Extend]) ($ €0.00) (🤖 1 agent)
```

At Medium and Wide chat widths everything sits on one row, and the 5h and 7d pills share the spare width, their bars stretching to fill it. When the chat column is too narrow for that (Narrow, or a split view), the band uses two rows: context, 5h and 7d on top, and on a right-aligned second row cache, agents and credits, with credits rightmost. The band switches a little before the row gets tight, and once it is on two rows it only goes back with clear room to spare, so it doesn't jump between layouts.

Point at any pill to see more detail.

- **Context**: a circle that fills by quarters with the context window (`○ ◔ ◑ ◕ ●`; blue, then orange from 50%, red from 75%), the tokens in context, one bar per recent prompt (the tokens it added), and the last prompt's change.
- **5h / 7d**: share of your session and weekly limits used, then the time until reset. Colored as Claude's own usage bars: green under 75%, orange from 75%, red from 90%. The solid part is what you've used. The hatched part is the gap to the time elapsed: grey while you're behind the clock, in the bar's color when you're using faster than time passes. The hover card gives the reset time.
- **Cache**: time left before the prompt cache expires (`51m`). **Extend** sends one tiny request over the conversation, which reads the cached context back and restarts the countdown. That costs about a tenth of the normal input price and counts against your limits. Five minutes before expiry (one minute for a 5-minute cache) a toast pops up and the pill offers **Keep alive** or **Let it expire**. No button while a turn runs, after expiry, or after a compaction: the next message writes a new cache anyway.
- **Credits**: extra-usage credits this session spent (`$0.00` until it spends any), or `disabled` when extra usage is off on your account. The hover card links to your balance on claude.ai.
- **Agents**: subagents this session, and how many are running. The hover card lists the running ones.

`/usage-bar` refreshes now and prints the raw figures.

## How the figures are read

- **Context and limits** come from Claude Code after each response, with no extra requests.
- **Credits** come from the account endpoint Claude's `/usage` screen reads (`api.anthropic.com/api/oauth/usage`), with your login's own token. This endpoint is unofficial and may change: if it does, the credits pill disappears. The endpoint only knows your whole account's spend, so the mod matches it to this session. Credits are billed at API prices, which is what Claude Code's session cost counts. When the account's credit spend rises, this session claims the rise only up to its own cost from the last 15 minutes not yet claimed. The figure therefore never exceeds what the session cost or what the account was charged. Turning credits on, which reveals earlier spend, adds nothing, and neither does another session spending while this one is idle. Two sessions spending credits at the same moment can split the charge unevenly. `/usage-bar reset` restarts the count. Readings are taken 5 seconds after each reply and after each subagent finishes (at most every 30 seconds), and otherwise every 3 minutes, shared by all open sessions. If the endpoint rate-limits, every session backs off for 5 minutes, doubling up to an hour.
- **Cache lifetime** follows Claude Code's own rules ([docs](https://code.claude.com/docs/en/prompt-caching#which-ttl-each-request-gets)): 1 hour for the main conversation on a subscription within plan usage, 5 minutes once requests draw on usage credits (so Fable on Pro gets 5 minutes). The mod takes the first that applies:
  1. `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL` or `ENABLE_PROMPT_CACHING_1H` in the environment (the `promptCacheTtl` setting is not read).
  2. The lifetime the last cache write asked for, when the response splits writes into 1-hour and 5-minute tokens.
  3. What hits and misses proved: a hit more than 5 minutes after the previous request means 1 hour, and a miss within the hour means 5 minutes.
  4. A guess: 5 minutes when a credits reading has just gone up or a limit is at 100%, otherwise 1 hour.

  The countdown starts when the request starts, as the API counts it. The hover card says which source was used.

Requires a Claude subscription login. Desktop app only: in the terminal the mod draws nothing.

## Install

```
/plugin marketplace add michal-m/claude-mods
/plugin install usage-bar@claude-mods
/reload-plugins
```

## Develop

```bash
claude plugin validate ./usage-bar
claude plugin test ./usage-bar
```

To run the working copy in the desktop app, point `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json` at the repository root. Every mod folder in it then loads, and saving a file reloads the mod:

```json
"env": {
  "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-mods",
  "CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"
}
```

## Credits

Licensed under Apache-2.0 (see [LICENSE](../LICENSE)). Heavily inspired by Eric Cologni's [Token Weather Usage](https://github.com/augiefra/claude-mods/tree/main/plugins/token-weather-usage) (Apache-2.0). The pill styling, the icons and the hatched limit gauge are adapted from its code (see [NOTICE](../NOTICE)); the rest is written from scratch.
