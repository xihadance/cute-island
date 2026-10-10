import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readSession, SessionReader } from './files'
import { parseSession } from './parse'
import { claudePlugin } from './plugins'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const jsonl = (rows: unknown[]): string => rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
const thinking = { type: 'assistant', timestamp: '2026-10-10T02:37:27.140Z', message: {
  role: 'assistant', content: [{ type: 'thinking', thinking: 'Working on the task' }]
} }
const handoff = { type: 'continued-in', timestamp: '2026-10-10T02:39:37.330Z', sessionId: 'source-session', continuedInSessionId: 'next-session' }

function fileFor(rows: unknown[]): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'island-continuation-'))
  directories.push(directory)
  const file = path.join(directory, 'source-session.jsonl')
  writeFileSync(file, jsonl(rows))
  return file
}

describe('native session continuation', () => {
  it('preserves explicit handoffs across incremental appends and clears them on replacement', async () => {
    const file = fileFor([thinking])
    const reader = new SessionReader()
    const read = () => reader.read('claude', 'source-session', file, statSync(file).size)
    expect((await read())?.continuedInSessionId).toBeUndefined()
    appendFileSync(file, jsonl([handoff]))
    expect(await read()).toMatchObject({ sessionId: 'source-session', continuedInSessionId: 'next-session' })
    appendFileSync(file, jsonl([{ type: 'cost-state', sessionId: 'source-session' }]))
    expect(await read()).toMatchObject({ continuedInSessionId: 'next-session' })
    expect(await readSession('claude', 'source-session', file, statSync(file).size)).toMatchObject({ continuedInSessionId: 'next-session' })
    writeFileSync(file, jsonl([thinking]))
    expect((await read())?.continuedInSessionId).toBeUndefined()
  })

  it('exposes a native handoff in one-shot parsing without changing the source identity', () => {
    expect(parseSession(claudePlugin, 'source-session', jsonl([thinking, handoff]))).toMatchObject({
      id: 'claude-source-session', sessionId: 'source-session', continuedInSessionId: 'next-session'
    })
  })

  it('does not infer continuation from matching content in different sessions', () => {
    const first = parseSession(claudePlugin, 'first', jsonl([thinking]))
    const second = parseSession(claudePlugin, 'second', jsonl([thinking]))
    expect(first?.id).not.toBe(second?.id)
    expect(first?.continuedInSessionId).toBeUndefined()
    expect(second?.continuedInSessionId).toBeUndefined()
  })
})
