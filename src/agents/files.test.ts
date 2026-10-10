import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readSession, SessionReader } from './files'
import { claudePlugin, codexPlugin } from './plugins'
import { presentTasks } from './reduce'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
function fileFor(text: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'island-reader-'))
  directories.push(directory)
  const file = path.join(directory, 'session.jsonl')
  writeFileSync(file, text)
  return file
}
const launch = [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'build', name: 'Bash', input: { command: 'npm run build', run_in_background: true } }] } },
  { type: 'user', toolUseResult: { backgroundTaskId: 'job-1' }, message: { content: [{ type: 'tool_result', tool_use_id: 'build', content: 'started' }] } }
]
const done = { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '构建在后台继续' }] } }

describe('incremental transcript reader', () => {
  it('keeps a forked Codex transcript identity and excludes inherited work across reads', async () => {
    const file = fileFor(jsonl([{ type: 'session_meta', ordinal: 0, payload: {
      id: 'child', session_id: 'parent', parent_thread_id: 'parent', subagent_history_start_ordinal: 5
    } }]))
    const reader = new SessionReader()
    expect(await reader.read('codex', 'filename', file, statSync(file).size)).toBeNull()
    appendFileSync(file, jsonl([
      { type: 'session_meta', ordinal: 1, payload: { id: 'parent', originator: 'codex-tui' } },
      { type: 'event_msg', ordinal: 2, payload: { type: 'item_completed', item: {
        type: 'CollabAgentToolCall', tool: 'spawn_agent', status: 'completed', receiver_thread_ids: ['sibling']
      } } },
      { type: 'event_msg', ordinal: 3, payload: { type: 'exec_approval_request', call_id: 'old-approval', command: 'old command' } },
      { type: 'event_msg', ordinal: 4, payload: { type: 'turn_aborted' } }
    ]))
    expect(await reader.read('codex', 'filename', file, statSync(file).size)).toBeNull()
    appendFileSync(file, jsonl([
      { type: 'event_msg', ordinal: 5, timestamp: '2026-10-10T03:00:00Z', payload: { type: 'task_started' } },
      { type: 'response_item', ordinal: 6, payload: { type: 'reasoning', summary: [{ text: 'Child is working' }] } }
    ]))
    expect(await reader.read('codex', 'filename', file, statSync(file).size)).toMatchObject({
      id: 'codex-child', sessionId: 'child', client: undefined, state: 'thinking', title: 'Child is working',
      startedAt: Date.parse('2026-10-10T03:00:00Z'), tasks: [], steps: []
    })
    expect(await readSession('codex', 'filename', file, statSync(file).size)).toMatchObject({
      id: 'codex-child', tasks: [], steps: []
    })
  })

  it('retains metadata-only client records across appends and clears them on replacement', async () => {
    const file = fileFor(jsonl([{ type: 'session_meta', payload: { id: 'native', originator: 'codex-tui', source: 'cli' } }]))
    const reader = new SessionReader()
    expect(await reader.read('codex', 'fallback', file, statSync(file).size)).toBeNull()
    appendFileSync(file, jsonl([{ type: 'event_msg', payload: { type: 'task_started' } }]))
    expect(await reader.read('codex', 'fallback', file, statSync(file).size)).toMatchObject({ sessionId: 'native', client: 'CLI' })
    appendFileSync(file, jsonl([{ type: 'event_msg', payload: { type: 'task_complete' } }]))
    expect(await reader.read('codex', 'fallback', file, statSync(file).size)).toMatchObject({ client: 'CLI', state: 'success' })
    writeFileSync(file, jsonl([{ type: 'event_msg', payload: { type: 'task_started' } }]))
    expect(await reader.read('codex', 'fallback', file, statSync(file).size)).toMatchObject({ sessionId: 'fallback', client: undefined })
  })

  it.each([300_000, 4_500_000])('retains launches before %i bytes of subsequent output', async (length) => {
    const file = fileFor(jsonl([...launch, { type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(length) }] } }, done]))
    const view = await readSession('claude', 'large', file, statSync(file).size)
    expect(presentTasks(view!)).toMatchObject({ state: 'running', tasks: [{ id: 'build', status: 'active' }] })
  })

  it('parses only appended rows and resolves old task ids across new turns', async () => {
    let parsedCharacters = 0
    const plugin = { ...claudePlugin, createParser: () => {
      const parse = claudePlugin.createParser!()
      return (text: string) => { parsedCharacters += text.length; return parse(text) }
    } }
    const initial = jsonl([...launch, done])
    const file = fileFor(initial)
    const reader = new SessionReader()
    const first = await reader.read('claude', 'incremental', file, statSync(file).size, plugin)
    await reader.read('claude', 'incremental', file, statSync(file).size, plugin)
    expect(parsedCharacters).toBe(initial.length)
    const appended = jsonl([
      { type: 'user', message: { content: '继续处理' } },
      { type: 'user', origin: { kind: 'task-notification' }, message: { content: '<task-notification><task-id>job-1</task-id><status>completed</status></task-notification>' } }
    ])
    appendFileSync(file, appended)
    const next = await reader.read('claude', 'incremental', file, statSync(file).size, plugin)
    expect(parsedCharacters).toBe(initial.length + appended.length)
    expect(next?.tasks).toMatchObject([{ id: 'build', status: 'done' }])
    expect(first?.tasks).toMatchObject([{ id: 'build', status: 'active' }])
  })

  it('retains torn UTF-8 records and handles truncation followed by regrowth', async () => {
    const file = fileFor('')
    const row = Buffer.from(jsonl([{ type: 'event_msg', payload: { type: 'user_message', message: '中文任务' } }]))
    const split = row.indexOf(Buffer.from('中')) + 1
    writeFileSync(file, row.subarray(0, split))
    const reader = new SessionReader()
    expect(await reader.read('codex', 'partial', file, statSync(file).size)).toBeNull()
    appendFileSync(file, row.subarray(split))
    expect(await reader.read('codex', 'partial', file, statSync(file).size)).toMatchObject({ detail: '中文任务' })
    writeFileSync(file, jsonl([{ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '替换后的任务完成'.repeat(20) } }]))
    const replacement = await reader.read('codex', 'partial', file, statSync(file).size)
    expect(replacement).toMatchObject({ state: 'success', tasks: [] })
    expect(replacement?.detail).toBeUndefined()
  })

  it('keeps Codex process ownership across separate reads', async () => {
    const file = fileFor(jsonl([
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'run', arguments: '{"cmd":"npm test"}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'run', output: 'Process running with session ID 42' } }
    ]))
    const reader = new SessionReader()
    expect((await reader.read('codex', 'process', file, statSync(file).size))?.tasks[0].status).toBe('active')
    appendFileSync(file, jsonl([
      { type: 'response_item', payload: { type: 'function_call', name: 'functions.write_stdin', call_id: 'poll', arguments: '{"session_id":42}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'poll', output: 'Process exited with code 0' } }
    ]))
    expect((await reader.read('codex', 'process', file, statSync(file).size, codexPlugin))?.tasks[0].status).toBe('done')
  })
})
