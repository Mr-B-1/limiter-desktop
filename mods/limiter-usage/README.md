# limiter-usage

A Claude Code mod that writes the account's own plan windows to a file the Limiter desktop widget reads. It needs Claude Code 2.1.286 or later and runs in the desktop app's Code tab, in the terminal and in VS Code.

## What it writes

`~/.local/share/Limiter/claude-usage.json`, or the path in `LIMITER_USAGE_FILE`:

```json
{"schemaVersion":1,"source":"claude-code-mod","host":"MY-PC","observedAt":1791600000000,
 "rateLimits":[{"kind":"five_hour","percentUsed":12.5,"resetsAt":"2026-10-10T00:00:00.000Z"},
               {"kind":"seven_day","percentUsed":84,"resetsAt":"2026-10-10T03:00:00.000Z"}]}
```

It writes on session start and after every turn. It writes figures only: no token, no text, no session id.

## Loading it

1. Terminal, one session: `claude --plugin-dir <path to Limiter>\mods\limiter-usage`.
2. Every session, desktop app included: add `CLAUDE_CODE_PLUGIN_DIRS` to the `env` block of `~/.claude/settings.json` with that path. New sessions pick it up.

## Checks

1. `claude plugin validate <path to Limiter>\mods\limiter-usage`
2. `claude plugin test <path to Limiter>\mods\limiter-usage`
