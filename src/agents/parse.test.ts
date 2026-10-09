import { describe, expect, it } from 'vitest'
import { parseTranscript } from './parse'

describe('parseTranscript', () => {
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
