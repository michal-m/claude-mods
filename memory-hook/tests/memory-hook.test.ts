import { expect, test } from 'claude-code/testing'

const MEMORY = '/Users/me/.claude/projects/-Users-me-app/memory/user-role.md'

// Reads the permission verdict PreToolUse settled for each call. Under the
// test kit an ask has no one to answer it, so the call ends refused.
function verdicts(on: any) {
  const seen: Record<string, string> = {}
  on('tool.check', async (_$: any, e: any, next: any) => {
    const v = await next(e)
    seen[e.input.file_path] = v.decision
    return v
  })
  on('tool.call', () => ({ result: {} }))
  return seen
}

test('writing a memory file asks first', async ($, on) => {
  const seen = verdicts(on)

  const r = await $.tool.call({ tool: 'Write', file_path: MEMORY, content: '---\nname: user-role\n---\nA data scientist.' })

  expect(seen[MEMORY]).toBe('ask')
  expect(r.isError).toBe(true)
})

test('editing the memory index asks first', async ($, on) => {
  const seen = verdicts(on)
  const index = MEMORY.replace('user-role.md', 'MEMORY.md')

  await $.tool.call({ tool: 'Edit', file_path: index, old_string: 'a', new_string: 'b' })

  expect(seen[index]).toBe('ask')
})

test('writes elsewhere are left alone', async ($, on) => {
  const seen = verdicts(on)
  const elsewhere = ['/Users/me/app/src/memory/cache.ts', '/Users/me/.claude/CLAUDE.md', '/Users/me/.claude/projects/-Users-me-app/notes.md']

  for (const file_path of elsewhere) {
    const r = await $.tool.call({ tool: 'Write', file_path, content: 'x' })
    expect(r.isError).not.toBe(true)
    expect(seen[file_path]).toBe('allow')
  }
})
