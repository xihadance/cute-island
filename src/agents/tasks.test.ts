import { describe, expect, it } from 'vitest'
import { parseTranscript } from './parse'
import { unwrapExec } from './plugins/codex'

const jsonl = (rows: unknown[]): string => rows.map((row) => JSON.stringify(row)).join('\n')

describe('Codex background work', () => {
  const exec = (id: string, source: string) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: id, input: source } })
  const output = (id: string, text: string, type = 'custom_tool_call_output') => ({ type: 'response_item', payload: { type, call_id: id, output: text } })
  const wait = (id: string, cell: string) => ({ type: 'response_item', payload: { type: 'function_call', name: 'wait', call_id: id, arguments: JSON.stringify({ cell_id: cell }) } })
  const shell = 'const r = await tools.shell_command({"command":"npm test","workdir":"D:\\\\app"}); text(r)'

  it('keeps a yielded script running until a wait observes its end', () => {
    const rows = [exec('run', shell), output('run', 'Script running with cell ID 3\nWall time 10.0 seconds\nOutput:\n')]
    const yielded = parseTranscript('codex', 'bg', jsonl(rows))
    expect(yielded).toMatchObject({ state: 'running', title: 'npm test', operation: { kind: 'command', command: 'npm test', cwd: 'D:\\app' } })
    expect(yielded?.steps.map((step) => step.status)).toEqual(['active'])
    expect(yielded?.tasks).toEqual([{ id: 'cell-3', kind: 'command', label: 'npm test', status: 'active' }])

    const polling = parseTranscript('codex', 'bg', jsonl([...rows, wait('w1', '3'), output('w1', 'Script running with cell ID 3\nWall time 30.0 seconds', 'function_call_output')]))
    expect(polling?.tasks?.[0].status).toBe('active')
    expect(polling?.steps.map((step) => step.status)).toEqual(['active', 'done'])

    const finished = parseTranscript('codex', 'bg', jsonl([...rows, wait('w2', '3'), output('w2', 'Script failed\nWall time 3.0 seconds', 'function_call_output')]))
    expect(finished?.tasks?.[0]).toMatchObject({ id: 'cell-3', status: 'error' })
    expect(finished?.steps.map((step) => step.status)).toEqual(['done', 'done'])
  })

  it('forgets yielded commands when the turn ends, since their fate is never recorded', () => {
    const view = parseTranscript('codex', 'bg', jsonl([
      exec('run', shell), output('run', 'Script running with cell ID 3'),
      { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '测试在后台运行' } }
    ]))
    expect(view).toMatchObject({ state: 'success', title: '测试在后台运行', tasks: [] })
  })

  it('tracks unified exec sessions through write_stdin', () => {
    const start = { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'dev', arguments: JSON.stringify({ cmd: 'npm run dev' }) } }
    const poll = { type: 'response_item', payload: { type: 'function_call', name: 'write_stdin', call_id: 'poll', arguments: JSON.stringify({ session_id: 42, chars: '' }) } }
    const rows = [start, output('dev', 'Chunk ID: a\nWall time: 10 seconds\nProcess running with session ID 42\n', 'function_call_output')]
    expect(parseTranscript('codex', 'proc', jsonl(rows))?.tasks).toMatchObject([{ id: 'proc-42', status: 'active', label: 'npm run dev' }])
    const exited = parseTranscript('codex', 'proc', jsonl([...rows, poll, output('poll', 'Chunk ID: b\nProcess exited with code 1\n', 'function_call_output')]))
    expect(exited?.tasks?.[0]).toMatchObject({ status: 'error' })
    expect(exited?.steps.every((step) => step.status === 'done')).toBe(true)
  })

  it('shows spawned sub-agents and stays running after the parent turn completes', () => {
    const collab = (item: Record<string, unknown>) => ({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CollabAgentToolCall', ...item } } })
    const rows = [
      collab({ tool: 'spawn_agent', status: 'completed', receiver_thread_ids: ['t-1'], receiver_agents: [{ thread_id: 't-1', agent_nickname: 'Dirac' }], prompt: '校订 EP04' }),
      collab({ tool: 'spawn_agent', status: 'completed', receiver_thread_ids: ['t-2'], receiver_agents: [{ thread_id: 't-2', agent_nickname: 'Newton' }], prompt: '校订 EP05' }),
      collab({ tool: 'wait', status: 'completed', receiver_thread_ids: ['t-1'], agents_states: { 't-1': { completed: 'EP04 已校订' } } }),
      { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '一个子代理已返回' } }
    ]
    const background = parseTranscript('codex', 'collab', jsonl(rows))
    expect(background).toMatchObject({ state: 'running', title: '子 Agent Newton 进行中', terminal: false })
    expect(background?.tasks).toEqual([
      { id: 't-1', kind: 'agent', label: 'Dirac', status: 'done', detail: 'EP04 已校订' },
      { id: 't-2', kind: 'agent', label: 'Newton', status: 'active', detail: '校订 EP05' }
    ])

    const notice = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text',
      text: '<subagent_notification>\n{"agent_path":"t-2","status":{"completed":"EP05 已校订"}}\n</subagent_notification>' }] } }
    const settled = parseTranscript('codex', 'collab', jsonl([...rows, notice]))
    // The notification is not a new prompt: the finished turn and its tasks stay.
    expect(settled).toMatchObject({ state: 'success', title: '一个子代理已返回', terminal: true })
    expect(settled?.tasks?.map((task) => task.status)).toEqual(['done', 'done'])
  })

  it('does not treat injected user-role messages as prompts', () => {
    const view = parseTranscript('codex', 'aborted', jsonl([
      exec('run', shell),
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<turn_aborted>\nThe user interrupted\n</turn_aborted>' }] } },
      { type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } }
    ]))
    expect(view).toMatchObject({ state: 'error', title: '已中断' })
    expect(view?.steps).toHaveLength(1)
  })

  it('unwraps code-mode tool calls without evaluating them', () => {
    expect(unwrapExec('const r = await tools.multi_agent_v1__wait_agent({"targets":["a"]})')).toEqual({ name: 'wait_agent', input: { targets: ['a'] } })
    expect(unwrapExec('await tools.shell_command({command: "x"})')).toEqual({ name: 'shell_command', input: { command: 'x' } })
    expect(unwrapExec('text(1 + 1)')).toBeNull()
  })

  it.each(['write_stdin', 'functions.write_stdin'])('settles a process through %s', (name) => {
    const view = parseTranscript('codex', 'namespace', jsonl([
      { type: 'response_item', payload: { type: 'function_call', name: 'functions.exec_command', call_id: 'cmd', arguments: '{"cmd":"npm test"}' } },
      output('cmd', 'Process running with session ID 42', 'function_call_output'),
      { type: 'response_item', payload: { type: 'function_call', name, call_id: 'poll', arguments: '{"session_id":42}' } },
      output('poll', 'Process exited with code 0', 'function_call_output')
    ]))
    expect(view?.tasks).toMatchObject([{ id: 'proc-42', status: 'done' }])
    expect(view?.steps.every((step) => step.status === 'done')).toBe(true)
  })

  it('settles a script through functions.wait', () => {
    const view = parseTranscript('codex', 'namespace', jsonl([
      exec('cmd', shell), output('cmd', 'Script running with cell ID 42'),
      { type: 'response_item', payload: { type: 'function_call', name: 'functions.wait', call_id: 'poll', arguments: '{"cell_id":"42"}' } },
      output('poll', 'Script completed', 'function_call_output')
    ]))
    expect(view?.tasks).toMatchObject([{ id: 'cell-42', status: 'done' }])
  })

  it('preserves Skill and approval arguments in ordinary JavaScript object literals', () => {
    const skill = parseTranscript('codex', 'skill', jsonl([exec('s', "text(await tools.exec_command({cmd: 'Get-Content /skills/frontend-design/SKILL.md', workdir: '/project',}));")]))
    expect(skill?.operation).toMatchObject({ kind: 'skill', name: 'frontend-design', cwd: '/project' })
    const approval = parseTranscript('codex', 'approval', jsonl([exec('a', "text(await tools.exec_command({cmd: 'npm install', sandbox_permissions: 'require_escalated', justification: '访问网络'}));")]))
    expect(approval).toMatchObject({ state: 'approval', detail: '访问网络', operation: { command: 'npm install' } })
  })

  it('reads literals without executing code or matching tool names in comments and strings', () => {
    const source = '// tools.fake({})\nconst sample = "tools.other({})"; await tools.exec_command({cmd: `npm test`, workdir: dangerous(), yield_time_ms: 1000, /* comment */});'
    expect(unwrapExec(source)).toEqual({ name: 'exec_command', input: { cmd: 'npm test', yield_time_ms: 1000 } })
    expect(unwrapExec('await tools.exec_command({cmd: "old", ...options, shell: "cmd"})'))
      .toEqual({ name: 'exec_command', input: { shell: 'cmd' } })
  })
})

describe('Claude background work', () => {
  const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
  const result = (id: string, toolUseResult: Record<string, unknown>) => ({
    type: 'user', toolUseResult, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }
  })
  const notify = (body: string) => ({ type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: `<task-notification>\n${body}\n</task-notification>` } })

  it('tracks an async agent from launch to its notification, across turns', () => {
    const rows = [
      { type: 'user', message: { content: '调研一下' } },
      use('agent-1', 'Agent', { description: '调研 MCP', subagent_type: 'general-purpose', run_in_background: true }),
      result('agent-1', { isAsync: true, status: 'async_launched', agentId: 'a123' }),
      { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '已派出调研' }] } }
    ]
    const running = parseTranscript('claude', 's', jsonl(rows))
    expect(running).toMatchObject({ state: 'running', title: '子 Agent 调研 MCP 进行中', terminal: false })
    expect(running?.tasks).toEqual([{ id: 'agent-1', kind: 'agent', label: '调研 MCP', status: 'active' }])

    // Resolved through the agent id even when the notice omits the tool-use id.
    const done = parseTranscript('claude', 's', jsonl([...rows, notify('<task-id>a123</task-id>\n<status>completed</status>\n<summary>Agent "调研 MCP" finished</summary>')]))
    expect(done?.tasks?.[0]).toMatchObject({ status: 'done', detail: 'Agent "调研 MCP" finished' })
    expect(done).toMatchObject({ state: 'success', title: '已派出调研' })
  })

  it('settles a foreground agent with its tool result', () => {
    const view = parseTranscript('claude', 's', jsonl([
      use('agent-1', 'Task', { description: '检查测试' }),
      result('agent-1', { status: 'completed', agentId: 'a1', content: [{ type: 'text', text: '全部通过' }] })
    ]))
    expect(view?.tasks).toEqual([{ id: 'agent-1', kind: 'agent', label: '检查测试', status: 'done', detail: '全部通过' }])
  })

  it('tracks background shell commands and queued notifications', () => {
    const rows = [
      use('bash-1', 'Bash', { command: 'npm run build', description: '构建项目', run_in_background: true }),
      result('bash-1', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bk1' })
    ]
    expect(parseTranscript('claude', 's', jsonl(rows))?.tasks).toEqual([{ id: 'bash-1', kind: 'command', label: '构建项目', status: 'active' }])
    const queued = { type: 'queue-operation', operation: 'enqueue', content: '<task-notification>\n<task-id>bk1</task-id>\n<status>failed</status>\n</task-notification>' }
    expect(parseTranscript('claude', 's', jsonl([...rows, queued]))?.tasks?.[0].status).toBe('error')
  })

  it('stops every sub-agent on a bulk stop notice and ignores injected rows', () => {
    const view = parseTranscript('claude', 's', jsonl([
      use('a', 'Agent', { description: '一号' }), result('a', { status: 'async_launched', agentId: 'x' }),
      use('b', 'Agent', { description: '二号' }), result('b', { status: 'teammate_spawned', agentId: 'y' }),
      { type: 'user', isMeta: true, message: { content: '# skill instructions' } },
      { type: 'user', message: { content: '<system-reminder>\nreminder\n</system-reminder>' } },
      { type: 'user', origin: { kind: 'task-notification' }, message: { content: '2 background agents were stopped by the user: "一号", "二号".' } }
    ]))
    expect(view?.tasks?.map((task) => task.status)).toEqual(['stopped', 'stopped'])
    expect(view?.steps).toHaveLength(2)
  })
})
