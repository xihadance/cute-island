import { describe, expect, it } from 'vitest'
import { parseTranscript } from './parse'
import { createReducer, mergeChildTasks, presentTasks } from './reduce'

const START = Date.parse('2026-10-10T08:00:00Z')
const at = (seconds: number) => new Date(START + seconds * 1000).toISOString()
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n')

describe('latest execution round timing', () => {
  it.each(['claude', 'cursor', 'gemini'])('uses the latest user round in %s instead of session creation or the last tool', (kind) => {
    const rows = [
      { type: 'user', timestamp: at(0), message: { content: '上一轮' } },
      { type: 'assistant', timestamp: at(10), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '完成' }] } },
      { type: 'user', timestamp: at(120), message: { content: '新一轮' } },
      { type: 'assistant', timestamp: at(140), message: { content: [{ type: 'tool_use', id: 'run', name: 'Bash', input: { command: 'npm test' } }] } }
    ]
    expect(parseTranscript(kind, 'session', jsonl(rows))).toMatchObject({ startedAt: START + 120_000, endedAt: undefined })
    rows.push({ type: 'assistant', timestamp: at(180), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '完成' }] } })
    expect(parseTranscript(kind, 'session', jsonl(rows))).toMatchObject({ startedAt: START + 120_000, endedAt: START + 180_000 })
  })

  it('honors Codex task_started even when the same session starts again without a recorded completion', () => {
    const rows = [
      { type: 'session_meta', timestamp: at(0), payload: { id: 'native' } },
      { type: 'event_msg', timestamp: at(10), payload: { type: 'task_started' } },
      { type: 'event_msg', timestamp: at(100), payload: { type: 'task_started' } },
      { type: 'response_item', timestamp: at(130), payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"npm test"}' } }
    ]
    expect(parseTranscript('codex', 'file', jsonl(rows))).toMatchObject({ startedAt: START + 100_000, endedAt: undefined })
    expect(parseTranscript('codex', 'file', jsonl([...rows,
      { type: 'event_msg', timestamp: at(160), payload: { type: 'task_complete' } },
      { type: 'turn_context', timestamp: at(200), payload: {} }
    ]))).toMatchObject({ startedAt: START + 100_000, endedAt: START + 160_000 })
  })

  it('preserves Gemini document message times across whole-file parsing', () => {
    expect(parseTranscript('gemini', 'file', JSON.stringify({ messages: [
      { type: 'user', timestamp: at(60), content: '检查' },
      { type: 'gemini', timestamp: at(90), content: '完成' }
    ] }))).toMatchObject({ startedAt: START + 60_000, endedAt: START + 90_000 })
  })

  it('keeps timing through approvals and background tasks, then freezes at their completion', () => {
    const reducer = createReducer()
    reducer.push([{ kind: 'user', title: '任务', at: START },
      { kind: 'approval', title: '等待审批', at: START + 5000 },
      { kind: 'task_start', taskId: 'bg', task: 'command', label: '构建', at: START + 10_000 },
      { kind: 'done', title: '前台完成', at: START + 20_000 }])
    expect(presentTasks(reducer.snapshot())).toMatchObject({ startedAt: START, endedAt: undefined, state: 'running' })
    reducer.push([{ kind: 'task_end', taskId: 'bg', status: 'done', at: START + 50_000 }])
    expect(presentTasks(reducer.snapshot())).toMatchObject({ startedAt: START, endedAt: START + 50_000, state: 'success' })
    reducer.push([{ kind: 'task_end', taskId: 'bg', status: 'done', at: START + 90_000 }])
    expect(reducer.snapshot().endedAt).toBe(START + 50_000)
  })

  it('uses the parent start and child completion when folding separate transcripts', () => {
    const parent = parseTranscript('claude', 'parent', jsonl([
      { type: 'user', timestamp: at(0), message: { content: '主任务' } },
      { type: 'assistant', timestamp: at(20), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '结束' }] } }
    ]))!
    const child = parseTranscript('claude', 'child', jsonl([
      { type: 'user', timestamp: at(5), message: { content: '子任务' } },
      { type: 'assistant', timestamp: at(50), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '结束' }] } }
    ]))!
    expect(mergeChildTasks(parent, [{ view: child, live: false, link: { parentSessionId: 'parent', taskId: 'child', label: '子任务' } }]))
      .toMatchObject({ startedAt: START, endedAt: START + 50_000 })
  })

  it('keeps a failure duration frozen when a background task later finishes', () => {
    const reducer = createReducer()
    reducer.push([{ kind: 'user', title: '任务', at: START },
      { kind: 'task_start', taskId: 'bg', task: 'command', label: '构建', at: START + 5000 },
      { kind: 'error', title: '失败', at: START + 10_000 },
      { kind: 'task_end', taskId: 'bg', status: 'done', at: START + 50_000 }])
    expect(reducer.snapshot()).toMatchObject({ state: 'error', startedAt: START, endedAt: START + 10_000 })
  })
})
