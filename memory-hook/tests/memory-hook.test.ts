import { expect, test } from 'claude-code/testing'

const MEMORY = '/Users/me/.claude/projects/-Users-me-app/memory/user-role.md'

// The verdict the whole check chain reaches for a call, the plugin's hook
// included. `plugin` set on an ask means it is a person's to answer: no
// auto-mode classifier can settle it.
const check = ($: any, tool: string, input: Record<string, unknown>) => $.tool.check({ tool, input })

test("writing a memory file is a person's ask", async $ => {
  const v = await check($, 'Write', { file_path: MEMORY, content: '---\nname: user-role\n---\nA data scientist.' })

  expect(v.decision).toBe('ask')
  expect(v.plugin).toBe('memory-hook')
})

test('with nobody to ask, the memory write is refused', async ($, on) => {
  on('tool.call', () => ({ result: {} }))

  const r = await $.tool.call({ tool: 'Write', file_path: MEMORY, content: 'x' })

  expect(r.isError).toBe(true)
})

test('editing the memory index asks first', async $ => {
  const v = await check($, 'Edit', { file_path: MEMORY.replace('user-role.md', 'MEMORY.md'), old_string: 'a', new_string: 'b' })

  expect(v.decision).toBe('ask')
  expect(v.plugin).toBe('memory-hook')
})

test('writing a memory file with Windows paths asks first', async $ => {
  const paths = [
    'C:\\Users\\me\\.claude\\projects\\C--Users-me-app\\memory\\user-role.md',
    'C:/Users/me/.claude/projects/C--Users-me-app/memory/user-role.md',
  ]

  for (const file_path of paths) {
    const v = await check($, 'Write', { file_path, content: 'x' })
    expect(v.decision).toBe('ask')
    expect(v.plugin).toBe('memory-hook')
  }
})

test('writes elsewhere are left alone', async ($, on) => {
  // Stands for core: whatever it decides for other files is what comes back.
  on('tool.check', () => ({ decision: 'allow' }))
  const elsewhere = ['/Users/me/app/src/memory/cache.ts', '/Users/me/.claude/CLAUDE.md', '/Users/me/.claude/projects/-Users-me-app/notes.md', 'C:\\Users\\me\\.claude\\CLAUDE.md', 'C:\\Users\\me\\app\\src\\memory\\cache.ts']

  for (const file_path of elsewhere) {
    const v = await check($, 'Write', { file_path, content: 'x' })
    expect(v.decision).toBe('allow')
    expect(v.plugin).toBeUndefined()
  }
})
