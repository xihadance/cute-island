import { describe, expect, it } from 'vitest'
import { parseTranscript } from './parse'

describe('parseTranscript', () => {
  it.each([
    [{ originator: 'codex-tui', source: 'cli' }, 'CLI'],
    [{ originator: 'codex_vscode', source: 'vscode' }, 'IDE 扩展'],
    [{ originator: 'unknown-app', source: 'unknown' }, undefined]
  ])('uses Codex metadata without guessing a terminal or compatible editor', (meta, client) => {
    const text = [
      { type: 'session_meta', payload: { id: 'native-id', ...meta } },
      { type: 'event_msg', payload: { type: 'task_started' } }
    ].map((row) => JSON.stringify(row)).join('\n')
    expect(parseTranscript('codex', 'file-id', text)).toMatchObject({ id: 'codex-native-id', sessionId: 'native-id', client })
  })

  it('recognizes explicit completion in interactive Claude transcripts', () => {
    expect(parseTranscript('claude', 'completed', JSON.stringify({ type: 'assistant', message: {
      stop_reason: 'end_turn', content: [{ type: 'text', text: '已经完成' }]
    } }))).toMatchObject({ state: 'success', terminal: true, title: '已经完成' })
  })

  it('ignores system and developer prompt records', () => {
    expect(parseTranscript('codex', 'prompt', JSON.stringify({ type: 'response_item', payload: {
      type: 'message', role: 'developer', content: [{ type: 'text', text: 'Instructions' }]
    } }))).toBeNull()
  })

  it('recognizes Codex final answers and completion summaries', () => {
    expect(parseTranscript('codex', 'done', JSON.stringify({ type: 'response_item', payload: {
      type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '已完成检查' }]
    } }))).toMatchObject({ state: 'success', terminal: true, title: '已完成检查' })
    expect(parseTranscript('codex', 'done', JSON.stringify({ type: 'event_msg', payload: {
      type: 'task_complete', last_agent_message: '修复已完成'
    } }))).toMatchObject({ title: '修复已完成' })
  })

  it('reads Gemini JSON documents without duplicating tool calls or hiding them behind text', () => {
    const document = { sessionId: 'native', messages: [
      { type: 'user', content: '检查文件' },
      { type: 'gemini', content: '正在检查', toolCalls: [{ id: 'read', name: 'read_file', args: { path: 'app.ts' }, status: 'executing' }] }
    ] }
    const view = parseTranscript('gemini', 'fallback', JSON.stringify(document, null, 2))
    expect(view).toMatchObject({ id: 'gemini-native', state: 'running', detail: '检查文件', terminal: false })
    expect(view?.steps).toHaveLength(1)
    expect(parseTranscript('gemini', 'done', JSON.stringify({ messages: [{ type: 'gemini', content: '检查完成' }] }, null, 2)))
      .toMatchObject({ state: 'success', terminal: true })
  })

  it('matches out-of-order parallel tool results to their call ids', () => {
    const view = parseTranscript('claude', 'parallel', [
      { type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'first', name: 'Read', input: { path: 'first.ts' } },
        { type: 'tool_use', id: 'second', name: 'Read', input: { path: 'second.ts' } }
      ] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'first', content: 'ok' }] } }
    ].map((row) => JSON.stringify(row)).join('\n'))
    expect(view?.steps.map((step) => step.status)).toEqual(['done', 'active'])
  })

  it('clears previous-turn steps when a new user request arrives', () => {
    const view = parseTranscript('claude', 'next', [
      { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] },
      { role: 'user', content: '开始新的任务' }
    ].map((row) => JSON.stringify(row)).join('\n'))
    expect(view).toMatchObject({ state: 'waiting', detail: '开始新的任务', steps: [] })
  })
  it('reads a Claude Code tool call as running', () => {
    const view = parseTranscript(
      'claude',
      '11111111-1111-1111-1111-111111111111',
      [
        JSON.stringify({
          type: 'user',
          message: { content: [{ type: 'text', text: '<user_query>修好登录页</user_query>' }] }
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'thinking', thinking: '先看表单' },
              { type: 'tool_use', name: 'Edit', input: { file_path: 'src/Login.tsx', description: '补上表单校验' } }
            ]
          }
        })
      ].join('\n')
    )
    expect(view).toMatchObject({
      id: 'claude-11111111-1111-1111-1111-111111111111',
      agent: 'Claude Code',
      state: 'running',
      title: '补上表单校验',
      detail: '修好登录页',
      terminal: false
    })
    expect(view?.steps.at(-1)).toMatchObject({ label: '补上表单校验', status: 'active' })
  })

  it('uses the Claude Code result summary when a turn finishes', () => {
    const view = parseTranscript(
      'claude',
      'abc',
      [
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Edit', input: { description: '补上表单校验' } }] }
        }),
        JSON.stringify({ type: 'result', subtype: 'success', result: '登录页已更新' })
      ].join('\n')
    )
    expect(view).toMatchObject({ state: 'success', title: '登录页已更新', terminal: true })
  })

  it('marks a Claude Code tool failure', () => {
    const view = parseTranscript(
      'claude',
      'abc',
      [
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] }
        }),
        JSON.stringify({
          type: 'user',
          message: { content: [{ type: 'tool_result', is_error: true, content: 'failed' }] }
        })
      ].join('\n')
    )
    expect(view).toMatchObject({ state: 'error', title: '工具执行失败', terminal: true })
    expect(view?.steps.at(-1)?.status).toBe('error')
  })

  it('reads Codex function calls and completion', () => {
    const running = parseTranscript(
      'codex',
      '22222222-2222-2222-2222-222222222222',
      [
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: 'ls src' }) }
        })
      ].join('\n')
    )
    expect(running).toMatchObject({ agent: 'Codex', state: 'running', title: 'ls src' })

    const done = parseTranscript(
      'codex',
      '22222222-2222-2222-2222-222222222222',
      [
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'function_call', name: 'shell', arguments: '{"command":"ls src"}' }
        }),
        JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'ok' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: '目录已经看过' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })
      ].join('\n')
    )
    expect(done).toMatchObject({ state: 'success', terminal: true })
    expect(done?.steps.at(-1)?.status).toBe('done')
  })

  it('reads Gemini tool calls', () => {
    const view = parseTranscript(
      'gemini',
      'abcd1234',
      [
        JSON.stringify({ type: 'user', content: '给按钮加大一点' }),
        JSON.stringify({
          role: 'model',
          parts: [{ functionCall: { name: 'write_file', args: { file_path: 'Button.tsx' } } }]
        })
      ].join('\n')
    )
    expect(view).toMatchObject({
      agent: 'Gemini',
      state: 'running',
      title: '写入文件 Button.tsx',
      detail: '给按钮加大一点'
    })
  })

  it('reads a Cursor turn from tool use through success', () => {
    const running = parseTranscript(
      'cursor',
      '33333333-3333-3333-3333-333333333333',
      JSON.stringify({
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: '我先改登录页' },
            { type: 'tool_use', name: 'Shell', input: { command: 'npm test', description: '跑登录测试' } }
          ]
        }
      })
    )
    expect(running).toMatchObject({ agent: 'Cursor', state: 'running', title: '跑登录测试' })

    const done = parseTranscript(
      'cursor',
      '33333333-3333-3333-3333-333333333333',
      [
        JSON.stringify({
          role: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Edit', input: { path: 'Login.tsx' } }] }
        }),
        JSON.stringify({ type: 'turn_ended', status: 'success' })
      ].join('\n')
    )
    expect(done).toMatchObject({ state: 'success', terminal: true })
  })

  it('reads a Cursor turn failure', () => {
    const view = parseTranscript(
      'cursor',
      'session',
      JSON.stringify({ type: 'turn_ended', status: 'error', error: '无法写入文件' })
    )
    expect(view).toMatchObject({ state: 'error', title: '无法写入文件', terminal: true })
  })
})
