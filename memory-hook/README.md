# memory-hook

Asks you before Claude Code writes to its auto-memory.

Whenever Claude saves a memory with `Write` or `Edit` to a file in `~/.claude/projects/<project>/memory/` (a memory file or the `MEMORY.md` index), Claude Code shows its usual permission dialog with the full diff, whatever the permission mode, auto mode included. Approve it and the memory is saved. Decline it and the write is refused, and Claude is told you declined.

Nothing else is touched: `CLAUDE.md` files, your own `#` and `/memory` edits, and any other file write go through as usual.

## Install

```
/plugin marketplace add michal-m/claude-mods
/plugin install memory-hook@claude-mods
/reload-plugins
```

## Limits

- Only `Write` and `Edit` are checked. A memory written through a shell command (`cat > …/memory/x.md`) isn't caught. Claude normally uses `Write` for memories.
- The memory folder is matched as `/.claude/projects/<project>/memory/`. With `CLAUDE_CONFIG_DIR` pointing somewhere not named `.claude`, or a custom memory directory, writes there aren't caught.
- In a non-interactive run (`claude -p`) there is no one to ask, so memory writes are refused.
