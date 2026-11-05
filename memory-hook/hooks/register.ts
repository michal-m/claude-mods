import type { Register } from 'claude-code'

// Every write to the auto-memory folder (~/.claude/projects/<project>/memory/)
// goes through Claude Code's own permission dialog, whatever the permission
// mode, so the diff can be read before it lands. Declining refuses the write.
// Windows paths may use either slash.
const MEMORY_FILE = /[\\/]\.claude[\\/]projects[\\/][^\\/]+[\\/]memory[\\/]/

const isMemoryWrite = (tool: string, input: { file_path?: unknown }) =>
  (tool === 'Write' || tool === 'Edit') && typeof input.file_path === 'string' && MEMORY_FILE.test(input.file_path)

export const register: Register = on => {
  on('classic.PreToolUse', ($, e, next) =>
    isMemoryWrite(e.tool, e as { file_path?: unknown })
      ? { ask: `${$.plugin.name}: Claude wants to save a memory. Review it before it is written.` }
      : next(e),
  ).catch(($, e, next) =>
    next.called ? next(e) : { ask: `${$.plugin.name}: its check failed, so this write asks first.` },
  )
}
