import { describe, expect, it } from 'vitest'
import { describeOperation } from './operation'
import { parseTranscript } from './parse'
import { unwrapExec } from './script-tool'

const transcript = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n')
const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: 'response_item', payload: {
  type: 'function_call', name, call_id: id, arguments: JSON.stringify(args)
} })
const output = (id: string) => ({ type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: 'ok' } })

describe('operation display', () => {
  it('keeps the command separate from its description, including shell and working directory', () => {
    const view = parseTranscript('codex', 'cmd', transcript([call('cmd', 'functions.exec_command', {
      cmd: 'cmd /c npm run typecheck', description: '检查类型', workdir: 'D:\\work\\app'
    })]))
    expect(view).toMatchObject({ title: '检查类型', operation: { kind: 'command', command: 'cmd /c npm run typecheck', shell: 'cmd', cwd: 'D:\\work\\app' } })
  })

  it.each([
    ['mcp__context7__query_docs', {}, 'mcp', 'context7 / query_docs'],
    ['functions.mcp__chrome_devtools__take_snapshot', {}, 'mcp', 'chrome_devtools / take_snapshot'],
    ['Read', { file_path: '/skills/frontend-design/SKILL.md' }, 'skill', 'frontend-design'],
    ['functions.exec_command', { cmd: "Get-Content 'D:\\skills\\playwright\\SKILL.md'" }, 'skill', 'playwright'],
    ['Skill', { skill: 'frontend-design' }, 'skill', 'frontend-design'],
    ['collaboration.spawn_agent', { task_name: 'review_tests' }, 'agent', 'review_tests'],
    ['Read', { path: 'src/App.tsx' }, 'read', 'src/App.tsx'],
    ['Edit', { file_path: 'src/App.tsx' }, 'edit', 'src/App.tsx'],
    ['unknown_tool', {}, 'tool', 'unknown_tool']
  ])('describes %s using recorded inputs', (name, input, kind, label) => {
    expect(describeOperation(name, input)).toMatchObject({ kind, name: label })
  })

  it('recognizes a literal MCP call inside an exec wrapper without evaluating source', () => {
    const view = parseTranscript('codex', 'wrapped', transcript([{ type: 'response_item', payload: {
      type: 'custom_tool_call', name: 'functions.exec', input: 'text(await tools.mcp__context7__query_docs({query: "React"}));'
    } }]))
    expect(view).toMatchObject({ state: 'running', title: '调用 context7 / query_docs', operation: { kind: 'mcp', name: 'context7 / query_docs' } })
    expect(view?.operation?.command).toBeUndefined()
  })

  it('does not infer approval from command descriptions', () => {
    const view = parseTranscript('codex', 'ordinary', transcript([call('one', 'exec_command', { cmd: 'echo approval', description: '需要审批吗' })]))
    expect(view?.state).toBe('running')
  })

  it('finds approval after earlier tools in the same code-mode batch', () => {
    const source = `text(await tools.apply_patch('*** Begin Patch'));
      text(await tools.exec_command({ cmd: 'npm run typecheck' }));
      text(await tools.exec_command({ cmd: 'node scripts/smoke-interaction.cjs', sandbox_permissions: 'require_escalated', justification: '启动隔离测试' }));`
    const pending = { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'batch', input: source } }
    expect(parseTranscript('codex', 'batch', transcript([pending]))).toMatchObject({
      state: 'approval', detail: '启动隔离测试', operation: { kind: 'command', command: 'node scripts/smoke-interaction.cjs' }
    })
    const yielded = { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'batch', output: 'Script running with cell ID 33' } }
    expect(parseTranscript('codex', 'batch', transcript([pending, yielded]))?.state).toBe('approval')
    const finished = { type: 'response_item', payload: { type: 'function_call_output', call_id: 'wait', output: 'Script completed' } }
    expect(parseTranscript('codex', 'batch', transcript([pending, yielded, call('wait', 'functions.wait', { cell_id: '33' }), finished]))?.state).toBe('thinking')
  })

  it('prioritizes static parallel approvals and human-input calls without matching strings or dynamic permissions', () => {
    expect(unwrapExec(`await Promise.allSettled([tools.read_file({path:'a.ts'}), tools.exec_command({cmd:'npm install',sandbox_permissions:'require_escalated'})])`))
      .toMatchObject({ name: 'exec_command', input: { sandbox_permissions: 'require_escalated' } })
    expect(unwrapExec(`await tools.read_file({path:'a.ts'}); await tools.request_user_input({questions: []})`))
      .toMatchObject({ name: 'request_user_input' })
    expect(unwrapExec(`await tools.read_file({path:'a.ts'}); await tools.exec_command({cmd:'approval text',sandbox_permissions: permission})`))
      .toMatchObject({ name: 'read_file' })
    expect(unwrapExec(`await tools.read_file({path:'a.ts'}); const sample = "tools.exec_command({sandbox_permissions:'require_escalated'})"`))
      .toMatchObject({ name: 'read_file' })
  })

  it('keeps explicit approval visible across unrelated parallel tools and reasoning', () => {
    const rows = [call('approval', 'exec_command', { cmd: 'npm install', sandbox_permissions: 'require_escalated', justification: '需要网络访问' }),
      call('read', 'read_file', { path: 'app.ts' }), output('read'),
      { type: 'response_item', payload: { type: 'reasoning', summary: [{ text: '继续思考' }] } }]
    const waiting = parseTranscript('codex', 'approval', transcript(rows))
    expect(waiting).toMatchObject({ state: 'approval', detail: '需要网络访问', operation: { command: 'npm install' }, terminal: false })
    expect(waiting?.steps.map((step) => step.status)).toEqual(['waiting', 'done'])
    const resumed = parseTranscript('codex', 'approval', transcript([...rows, output('approval')]))
    expect(resumed).toMatchObject({ state: 'thinking', terminal: false })
    expect(resumed?.operation).toBeUndefined()
    expect(resumed?.detail).toBeUndefined()
    expect(resumed?.steps.map((step) => step.status)).toEqual(['done', 'done'])
  })

  it('resumes the same step on an explicit command begin and preserves array commands', () => {
    const rows = [
      { type: 'event_msg', payload: { type: 'exec_approval_request', call_id: 'cmd', command: ['cmd', '/c', 'npm test'], reason: '确认执行' } },
      { type: 'event_msg', payload: { type: 'exec_command_begin', call_id: 'cmd', command: ['cmd', '/c', 'npm test'] } }
    ]
    const view = parseTranscript('codex', 'resume', transcript(rows))
    expect(view).toMatchObject({ state: 'running', operation: { command: 'cmd /c "npm test"' } })
    expect(view?.steps).toHaveLength(1)
    expect(view?.steps[0].status).toBe('active')
  })

  it('recognizes Gemini approval and clears the waiting state when execution starts', () => {
    const document = (status: string) => JSON.stringify({ messages: [{ type: 'gemini', toolCalls: [{ id: 'cmd', name: 'run_shell_command', args: { command: 'npm install' }, status }] }] })
    expect(parseTranscript('gemini', 'approval', document('awaiting_approval'))?.state).toBe('approval')
    expect(parseTranscript('gemini', 'approval', document('executing'))?.state).toBe('running')
  })
})
