import type { Register } from 'claude-code'

// Every write to the auto-memory folder (~/.claude/projects/<project>/memory/)
// is put to the person in Claude Code's own permission dialog, whatever the
// permission mode, so the diff can be read before it lands. Declining refuses
// the write. Windows paths may use either slash.
//
// The ask is made at `tool.check`, not `classic.PreToolUse`: a PreToolUse ask
// goes to the mode's decider, which in auto mode is the classifier, and it
// approves memory writes without asking. A plugin's own `tool.check` ask is the
// person's alone: no classifier settles it, and with nobody to ask it's a deny.
const MEMORY_FILE = /[\\/]\.claude[\\/]projects[\\/][^\\/]+[\\/]memory[\\/]/

const isMemoryWrite = (tool: string, input: unknown) => {
  const file_path = (input as { file_path?: unknown } | null)?.file_path
  return (tool === 'Write' || tool === 'Edit') && typeof file_path === 'string' && MEMORY_FILE.test(file_path)
}

export const register: Register = on => {
  on('tool.check', ($, e, next) =>
    isMemoryWrite(e.tool, e.input)
      ? { decision: 'ask', reason: `${$.plugin.name}: Claude wants to save a memory. Review it before it is written.` }
      : next(e),
  ).catch(($, e, next) =>
    next.called ? next(e) : { decision: 'ask', reason: `${$.plugin.name}: its check failed, so this write asks first.` },
  )
}
