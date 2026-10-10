import { describe, expect, it } from 'vitest'
import { parseTranscript } from './parse'
import { createReducer, mergeChildTasks, presentTasks } from './reduce'
import type { SessionView } from './types'

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

describe('background execution timing', () => {
  it('keeps each task start through updates, repeated starts and later user turns, then freezes its end', () => {
    const reducer = createReducer()
    reducer.push([{ kind: 'task_start', taskId: 'agent', task: 'agent', label: '检查', at: START }])
    reducer.push([
      { kind: 'task_update', taskId: 'agent', detail: '读取文件', at: START + 10_000 },
      { kind: 'task_start', taskId: 'agent', task: 'agent', label: '检查', at: START + 20_000 },
      { kind: 'user', title: '另一轮', at: START + 30_000 }
    ])
    expect(reducer.snapshot().tasks[0]).toMatchObject({ status: 'active', startedAt: START })
    reducer.push([{ kind: 'task_end', taskId: 'agent', status: 'done', at: START + 40_000 }])
    const done = reducer.snapshot().tasks[0]
    reducer.push([{ kind: 'task_end', taskId: 'agent', status: 'stopped', at: START + 70_000 }])
    expect(reducer.snapshot().tasks[0]).toEqual(done)
    expect(done).toMatchObject({ status: 'done', startedAt: START, endedAt: START + 40_000 })
    reducer.push([{ kind: 'task_start', taskId: 'agent', task: 'agent', label: '继续检查', at: START + 90_000 }])
    expect(reducer.snapshot().tasks[0]).toMatchObject({ status: 'active', startedAt: START + 90_000 })
    expect(reducer.snapshot().tasks[0].endedAt).toBeUndefined()
  })

  it('does not infer task timing from ordinary updates or a missing timestamp', () => {
    const reducer = createReducer()
    reducer.push([
      { kind: 'task_start', taskId: 'unknown', task: 'agent', label: '检查' },
      { kind: 'task_update', taskId: 'unknown', detail: '读取文件', at: START },
      { kind: 'task_end', taskId: 'unknown', status: 'done' },
      { kind: 'task_end', taskId: 'unknown', status: 'done', at: START + 20_000 }
    ])
    expect(reducer.snapshot().tasks[0]).toEqual({ id: 'unknown', kind: 'agent', label: '检查', status: 'done', detail: '读取文件' })
  })

  it.each(['done', 'error', 'stopped'] as const)('records a task %s time and isolates returned snapshots', (status) => {
    const reducer = createReducer()
    reducer.push([{ kind: 'task_start', taskId: 'agent', task: 'agent', label: '检查', at: START }])
    const previous = reducer.snapshot()
    reducer.push([{ kind: 'task_end', taskId: 'agent', status, at: START + 40_000 }])
    expect(reducer.snapshot().tasks[0]).toMatchObject({ status, startedAt: START, endedAt: START + 40_000 })
    expect(previous.tasks[0]).toMatchObject({ status: 'active', startedAt: START })
    expect(previous.tasks[0].endedAt).toBeUndefined()
  })

  it('times yielded Codex commands from invocation through completion instead of their yield or poll', () => {
    const row = (seconds: number, payload: unknown) => ({ type: 'response_item', timestamp: at(seconds), payload })
    const view = parseTranscript('codex', 'parent', jsonl([
      row(0, { type: 'function_call', call_id: 'run', name: 'exec_command', arguments: '{"cmd":"npm test"}' }),
      row(10, { type: 'function_call_output', call_id: 'run', output: 'Process running with session ID 42' }),
      row(30, { type: 'function_call', call_id: 'poll', name: 'write_stdin', arguments: '{"session_id":42}' }),
      row(40, { type: 'function_call_output', call_id: 'poll', output: 'Process exited with code 0' })
    ]))!
    expect(view.tasks[0]).toMatchObject({ startedAt: START, endedAt: START + 40_000, status: 'done' })
  })

  it('recognizes native Codex SubAgentActivity starts and never restarts timing for interactions', () => {
    const row = (seconds: number, kind: string) => ({ type: 'event_msg', timestamp: at(seconds + 1), payload: {
      type: 'item_completed', started_at_ms: START + seconds * 1000, completed_at_ms: START + seconds * 1000,
      item: { type: 'SubAgentActivity', id: `call-${seconds}`, kind, agent_thread_id: 'child-uuid', agent_path: '/root/review' }
    } })
    const view = parseTranscript('codex', 'parent', jsonl([row(5, 'started'), row(30, 'interacted')]))!
    expect(view.tasks).toEqual([{ id: 'child-uuid', kind: 'agent', label: 'review', status: 'active', startedAt: START + 5000 }])
  })

  it('times Claude background commands from the tool call and sub-agents from spawn through notification', () => {
    const view = parseTranscript('claude', 'parent', jsonl([
      { type: 'assistant', timestamp: at(0), message: { content: [{ type: 'tool_use', id: 'command', name: 'Bash', input: { command: 'npm test' } }] } },
      { type: 'user', timestamp: at(10), toolUseResult: { backgroundTaskId: 'bg' }, message: { content: [{ type: 'tool_result', tool_use_id: 'command' }] } },
      { type: 'assistant', timestamp: at(20), message: { content: [{ type: 'tool_use', id: 'agent', name: 'Agent', input: { description: '检查' } }] } },
      { type: 'user', timestamp: at(25), toolUseResult: { status: 'async_launched', agentId: 'a1' }, message: { content: [{ type: 'tool_result', tool_use_id: 'agent' }] } },
      { type: 'queue-operation', timestamp: at(30), content: '<task-notification><task-id>bg</task-id><status>completed</status></task-notification>' },
      { type: 'queue-operation', timestamp: at(40), content: '<task-notification><task-id>a1</task-id><status>completed</status></task-notification>' }
    ]))!
    expect(view.tasks).toMatchObject([
      { id: 'command', startedAt: START, endedAt: START + 30_000, status: 'done' },
      { id: 'agent', startedAt: START + 20_000, endedAt: START + 40_000, status: 'done' }
    ])
  })

  it('fills missing parent task timing from its child without overwriting an authoritative completion', () => {
    const parent = parseTranscript('claude', 'parent', jsonl([
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'agent', name: 'Agent', input: { description: '检查' } }] } }
    ]))!
    const child = parseTranscript('claude', 'child', jsonl([
      { type: 'user', timestamp: at(5), message: { content: '子任务' } },
      { type: 'assistant', timestamp: at(50), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '完成' }] } }
    ]))!
    const children = [{ view: child, live: false, link: { parentSessionId: 'parent', taskId: 'agent', label: '检查' } }]
    expect(mergeChildTasks(parent, children).tasks[0]).toMatchObject({ startedAt: START + 5000, endedAt: START + 50_000, status: 'done' })
    expect(parent.tasks[0]).toEqual({ id: 'agent', kind: 'agent', label: '检查', status: 'active' })
    const authoritative = { ...parent, tasks: [{ ...parent.tasks[0], status: 'stopped' as const, startedAt: START, endedAt: START + 30_000 }] }
    expect(mergeChildTasks(authoritative, children).tasks[0]).toMatchObject({ startedAt: START, endedAt: START + 30_000, status: 'stopped' })
    const finishedWithoutTimes = { ...parent, tasks: [{ ...parent.tasks[0], status: 'done' as const }] }
    expect(mergeChildTasks(finishedWithoutTimes, children).tasks[0]).toMatchObject({ startedAt: START + 5000, endedAt: START + 50_000, status: 'done' })
    const childOnly = mergeChildTasks<SessionView>({ ...parent, tasks: [] }, [{ ...children[0], live: true, view: { ...child, terminal: false, state: 'running' as const, endedAt: undefined } }])
    expect(childOnly.tasks[0]).toMatchObject({ startedAt: START + 5000, status: 'active' })
    expect(childOnly.tasks[0].endedAt).toBeUndefined()
  })

  it('exposes a linked child approval without changing the parent operation or reviving settled tasks', () => {
    const parent = parseTranscript('claude', 'parent', jsonl([
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'agent', name: 'Agent', input: { description: '检查' } }] } }
    ]))!
    const child = parseTranscript('codex', 'child', jsonl([
      { type: 'response_item', timestamp: at(5), payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"npm install","sandbox_permissions":"require_escalated"}' } }
    ]))!
    const children = [{ view: child, live: true, link: { parentSessionId: 'parent', taskId: 'agent', label: '检查' } }]
    const merged = mergeChildTasks(parent, children)
    expect(merged.tasks[0]).toMatchObject({ status: 'active', state: 'approval', startedAt: START + 5000 })
    expect(merged.operation).toEqual(parent.operation)
    const settled = mergeChildTasks({ ...parent, tasks: [{ ...parent.tasks[0], status: 'done' as const }] }, children)
    expect(settled.tasks[0].state).toBeUndefined()
    expect(settled.tasks[0].status).toBe('done')
  })
})
