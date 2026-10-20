# usage-bar

One band above the prompt in the Claude desktop app's Code tab:

```
◑ 412k ▃▄▂█▆ ▲ +6.3k │ 5h ━━━╍── 32% · 3h 0m │ 7d ━━━━╍─ 59% · 3d 0h │ cache 52 min [Extend] │ credits $1.84 │ 1 running · 2
```

Point at any pill to see more detail.

- **Context**: a circle that fills with the context window (`○ ◔ ◑ ◕ ●`, green, then amber from 50%, red from 75%), the tokens in context, one bar per recent prompt (the tokens it added), and the last prompt's change.
- **5h / 7d**: share of your session and weekly limits used, then the time until reset. The solid part is what you've used. The hatched part is the gap to the time elapsed: grey while you're behind the clock, in the bar's color when you're using faster than time passes. Green while behind the clock, amber when ahead, red from 90% or when the pace would use the window up well before it resets. The hover card gives the reset time.
- **Cache**: time left before the prompt cache expires. **Extend** sends one tiny request over the conversation, which reads the cached context back and restarts the countdown. That costs about a tenth of the normal input price and counts against your limits. Five minutes before expiry (one minute for a 5-minute cache) a toast pops up and the pill offers **Keep alive** or **Let it expire**. No button while a turn runs, after expiry, or after a compaction: the next message writes a new cache anyway.
- **Credits**: extra-usage credits spent since this session started. Hidden when extra usage is off. The hover card links to your balance on claude.ai.
- **Agents**: subagents this session, and how many are running. The hover card lists the running ones.

`/usage-bar` refreshes now and prints the raw figures.

## How the figures are read

- **Context and limits** come from Claude Code after each response, with no extra requests.
- **Credits** come from the account endpoint Claude's `/usage` screen reads (`api.anthropic.com/api/oauth/usage`), with your login's own token. This endpoint is unofficial and may change: if it does, the credits pill just disappears. The first reading in a session is the baseline, so the figure is **your whole account's** spend while the session has been open, including other sessions and claude.ai. All open sessions share one reading, refreshed at most every 3 minutes. If the endpoint rate-limits, every session backs off for 5 minutes, doubling up to an hour.
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

Licensed under Apache-2.0 (see [LICENSE](../LICENSE)). Heavily inspired by Eric Cologni's [Token Weather Usage](https://github.com/augiefra/claude-mods/tree/main/plugins/token-weather-usage) (Apache-2.0): the band's layout, the context chart and the pace-hatched limit gauges follow its ideas. Written from scratch, without its code.
