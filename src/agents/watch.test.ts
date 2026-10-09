import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ActivityStore } from '../shared/activity'
import type { AgentKind } from './parse'
import { SessionWatcher, matchAgentProcesses, type AgentRoots } from './watch'

const NOW = Date.parse('2026-10-09T08:00:00Z')

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
        message: { content: [{ type: 'text', text: '登录页已更新' }] }
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
})

function watcherFor(store: ActivityStore, roots: AgentRoots, listProcesses: () => Set<AgentKind> = () => new Set()): SessionWatcher {
  return new SessionWatcher(store, { roots, now: () => NOW, listProcesses })
}

function tempHome(): { roots: AgentRoots } {
  const home = mkdtempSync(path.join(tmpdir(), 'cute-island-'))
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
