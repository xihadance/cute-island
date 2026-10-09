import { appendFileSync, mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActivityStore } from '../shared/activity'
import type { AgentKind } from './parse'
import { SessionWatcher, matchAgentProcesses, readSession, type AgentRoots } from './watch'

const NOW = Date.parse('2026-10-09T08:00:00Z')
const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('SessionWatcher', () => {
  const stores: ActivityStore[] = []

  afterEach(() => {
    for (const store of stores) store.dispose()
    stores.length = 0
  })

  it('notifies while Claude is editing and Codex is waiting, then records success once', async () => {
    const home = tempHome()
    const claudeFile = path.join(home.roots.claude, '-work', '11111111-1111-1111-1111-111111111111.jsonl')
    const codexFile = path.join(home.roots.codex, '2026', '10', '09', 'rollout-2026-10-09T08-00-00-22222222-2222-2222-2222-222222222222.jsonl')
    writeJsonl(claudeFile, [
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: { description: '补上表单校验' } }] }
      }
    ])
    writeJsonl(codexFile, [{ type: 'event_msg', payload: { type: 'user_message', message: '看一下测试' } }])
    touch(claudeFile, NOW)
    touch(codexFile, NOW)

    const store = newStore()
    const watcher = watcherFor(store, home.roots, () => new Set<AgentKind>(['codex']))
    await watcher.scan()
    expect(store.list().map((item) => [item.agent, item.state, item.title])).toEqual([
      ['Claude Code', 'running', '补上表单校验'],
      ['Codex', 'waiting', '等待回复']
    ])

    writeJsonl(claudeFile, [
      {
        type: 'assistant',
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '登录页已更新' }] }
      }
    ])
    touch(claudeFile, NOW - 9_000)
    await watcher.scan()
    const finished = store.get('claude-11111111-1111-1111-1111-111111111111')
    expect(finished).toMatchObject({ state: 'success', title: '登录页已更新' })

    const updatedAt = finished?.updatedAt
    await watcher.scan()
    expect(store.get('claude-11111111-1111-1111-1111-111111111111')?.updatedAt).toBe(updatedAt)
  })

  it('shows Gemini and Cursor sessions and ignores old history', async () => {
    const home = tempHome()
    const geminiFile = path.join(home.roots.gemini, 'hash', 'chats', 'session-2026-10-09T08-00-abcd1234.jsonl')
    const cursorFile = path.join(
      home.roots.cursor,
      'workspace',
      'agent-transcripts',
      '33333333-3333-3333-3333-333333333333',
      '33333333-3333-3333-3333-333333333333.jsonl'
    )
    const oldFile = path.join(home.roots.cursor, 'workspace', 'agent-transcripts', 'old-session', 'old-session.jsonl')
    writeJsonl(geminiFile, [
      {
        role: 'model',
        parts: [{ functionCall: { name: 'run_shell_command', args: { command: 'npm test' } } }]
      }
    ])
    writeJsonl(cursorFile, [
      { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { path: 'README.md' } }] } },
      { type: 'turn_ended', status: 'error', error: '无法写入文件' }
    ])
    writeJsonl(oldFile, [{ type: 'turn_ended', status: 'success' }])
    touch(geminiFile, NOW)
    touch(cursorFile, NOW)
    touch(oldFile, NOW - 10 * 60_000)

    const store = newStore()
    await watcherFor(store, home.roots).scan()
    expect(store.list().map((item) => [item.agent, item.state, item.title])).toEqual([
      ['Cursor', 'error', '无法写入文件'],
      ['Gemini', 'running', 'npm test']
    ])
  })

  it('keeps a quiet file quiet until it belongs to a session we already showed', async () => {
    const home = tempHome()
    const file = path.join(home.roots.claude, 'proj', 'quiet.jsonl')
    writeJsonl(file, [{ type: 'assistant', message: { content: [{ type: 'text', text: '昨天就做完了' }] } }])
    touch(file, NOW - 30_000)
    const store = newStore()
    await watcherFor(store, home.roots).scan()
    expect(store.list()).toEqual([])
  })

  it.each(['claude', 'codex', 'gemini', 'cursor'] as const)('recovers a quiet %s turn that started before the app', async (kind) => {
    const { roots } = tempHome()
    const folder = kind === 'cursor' ? 'project/agent-transcripts' : 'project'
    const name = kind === 'codex' ? 'rollout-active' : kind === 'gemini' ? 'session-active' : 'active'
    const file = path.join(roots[kind], folder, `${name}.jsonl`)
    writeJsonl(file, [{ role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] }])
    touch(file, NOW - 20 * 60_000)
    const store = newStore()
    let now = NOW
    const watcher = new SessionWatcher(store, { roots, now: () => now, listProcesses: () => new Set([kind]) })
    await watcher.scan()
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]).toMatchObject({ state: 'running', title: 'npm test' })
    now += 25 * 60 * 60_000
    await watcher.scan()
    expect(store.list()[0]?.state).toBe('running')
  })

  it('never revives completed historical turns just because an agent process exists', async () => {
    const { roots } = tempHome()
    const file = path.join(roots.claude, 'project', 'done.jsonl')
    writeJsonl(file, [{ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '完成了' }] } }])
    touch(file, NOW - 10 * 60_000)
    const store = newStore()
    await watcherFor(store, roots, () => new Set(['claude'])).scan()
    expect(store.list()).toEqual([])
  })

  it('recovers registered busy Claude sessions beyond the fallback history window', async () => {
    const { roots } = tempHome()
    const id = '12345678-1234-1234-1234-123456789abc'
    const file = path.join(roots.claude, 'project', `${id}.jsonl`)
    writeJsonl(file, [{ role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'long task' } }] }])
    touch(file, NOW - 48 * 60 * 60_000)
    const registry = path.join(roots.claude, '..', 'sessions', `${process.pid}.json`)
    mkdirSync(path.dirname(registry), { recursive: true })
    writeFileSync(registry, JSON.stringify({ pid: process.pid, sessionId: id, status: 'busy' }))
    const store = newStore()
    await watcherFor(store, roots).scan()
    expect(store.list()[0]).toMatchObject({ id: `claude-${id}`, state: 'running' })
    store.clear()
    writeFileSync(registry, JSON.stringify({ pid: process.pid, sessionId: id, status: 'idle' }))
    await watcherFor(store, roots).scan()
    expect(store.list()).toEqual([])
  })

  it('caches unchanged logs and process queries while still detecting appends', async () => {
    const { roots } = tempHome()
    const file = path.join(roots.codex, 'rollout-active.jsonl')
    writeJsonl(file, [{ type: 'event_msg', payload: { type: 'task_started' } }])
    touch(file, NOW)
    const read = vi.fn(readSession)
    const processes = vi.fn(() => new Set<AgentKind>(['codex']))
    const store = newStore()
    const watcher = new SessionWatcher(store, { roots, now: () => NOW, listProcesses: processes, readSession: read })
    await watcher.scan()
    await watcher.scan()
    expect(read).toHaveBeenCalledTimes(1)
    expect(processes).toHaveBeenCalledTimes(1)
    appendFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n')
    await watcher.scan()
    expect(read).toHaveBeenCalledTimes(2)
    expect(store.list()[0]?.state).toBe('success')
  })

  it('shares overlapping scans and does not publish after stopping', async () => {
    const { roots } = tempHome()
    let resolve!: (value: Set<AgentKind>) => void
    const processes = vi.fn(() => new Promise<Set<AgentKind>>((done) => { resolve = done }))
    const store = newStore()
    const watcher = new SessionWatcher(store, { roots, listProcesses: processes })
    const pending = watcher.scan()
    expect(watcher.scan()).toBe(pending)
    watcher.stop()
    resolve(new Set())
    await pending
    expect(processes).toHaveBeenCalledTimes(1)
    expect(store.list()).toEqual([])
  })

  it('preserves a session through partial writes, and failures past the history window', async () => {
    const { roots } = tempHome()
    const file = path.join(roots.claude, 'project', 'active.jsonl')
    writeJsonl(file, [{ role: 'assistant', content: [{ type: 'thinking', thinking: '处理中' }] }])
    touch(file, NOW)
    let now = NOW
    let running = new Set<AgentKind>(['claude'])
    const store = newStore()
    const watcher = new SessionWatcher(store, { roots, now: () => now, listProcesses: () => running, processMs: 0 })
    await watcher.scan()
    writeFileSync(file, '{"type":')
    touch(file, NOW)
    await watcher.scan()
    expect(store.list()[0]?.state).toBe('thinking')
    now += 3 * 60_000
    running = new Set()
    await watcher.scan()
    expect(store.list()[0]?.state).toBe('error')
    now += 30 * 60_000
    await watcher.scan()
    expect(store.list()[0]?.state).toBe('error')
    store.dismiss(store.list()[0].id)
    await watcher.scan()
    expect(store.list()).toEqual([])
  })

  it('reads full Gemini JSON and expands a tail containing an oversized JSONL record', async () => {
    const { roots } = tempHome()
    const json = path.join(roots.gemini, 'project', 'chats', 'session-current.json')
    mkdirSync(path.dirname(json), { recursive: true })
    writeFileSync(json, JSON.stringify({ sessionId: 'native-id', messages: [
      { type: 'user', content: 'x'.repeat(300_000) },
      { type: 'gemini', toolCalls: [{ id: 'call', name: 'read_file', args: { path: 'file.ts' }, status: 'executing' }] }
    ] }, null, 2))
    expect(await readSession('gemini', 'fallback', json, statSync(json).size)).toMatchObject({ id: 'gemini-native-id', state: 'running' })
    const log = path.join(roots.codex, 'rollout-current.jsonl')
    writeJsonl(log, [{ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: 'x'.repeat(300_000) }) } }])
    expect(await readSession('codex', 'current', log, statSync(log).size)).toMatchObject({ state: 'running' })
  })

  function newStore(): ActivityStore {
    const store = new ActivityStore(() => ({ cancel() {} }), () => NOW)
    stores.push(store)
    return store
  }
})

describe('matchAgentProcesses', () => {
  it('recognizes the four agent executables on Windows and Unix', () => {
    const found = matchAgentProcesses(['/usr/bin/claude', 'codex.exe', 'C:\\Tools\\gemini.exe', 'cursor-agent', 'bash'].join('\n'))
    expect([...found].sort()).toEqual(['claude', 'codex', 'cursor', 'gemini'])
  })

  it('recognizes quoted executables and npm scripts without matching arbitrary task text', () => {
    expect([...matchAgentProcesses([
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\npm\\node_modules\\@google\\gemini-cli\\dist\\index.js"',
      'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js',
      '"C:\\Tools\\codex.exe" app-server',
      'node unrelated.js "please run cursor-agent"'
    ].join('\n'))].sort()).toEqual(['claude', 'codex', 'gemini'])
  })
})

function watcherFor(store: ActivityStore, roots: AgentRoots, listProcesses: () => Set<AgentKind> = () => new Set()): SessionWatcher {
  return new SessionWatcher(store, { roots, now: () => NOW, listProcesses })
}

function tempHome(): { roots: AgentRoots } {
  const home = mkdtempSync(path.join(tmpdir(), 'cute-island-'))
  tempDirs.push(home)
  const roots: AgentRoots = {
    claude: path.join(home, '.claude', 'projects'),
    codex: path.join(home, '.codex', 'sessions'),
    gemini: path.join(home, '.gemini', 'tmp'),
    cursor: path.join(home, '.cursor', 'projects')
  }
  return { roots }
}

function writeJsonl(file: string, rows: unknown[]): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

function touch(file: string, ms: number): void {
  const date = new Date(ms)
  utimesSync(file, date, date)
}
