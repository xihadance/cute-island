import { describe, expect, it } from 'vitest'
import { parseTranscript } from './parse'
import { claudePlugin } from './plugins/claude'
import { createReducer } from './reduce'

const START = Date.parse('2026-10-10T02:40:00.000Z')
const END = Date.parse('2026-10-10T02:44:54.591Z')
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n')
const request = { type: 'user', timestamp: START, message: { content: '继续检查' } }
const failure = {
  type: 'assistant', timestamp: END, isApiErrorMessage: true, error: 'model_not_found',
  message: { role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence',
    content: [{ type: 'text', text: 'The selected model does not exist or is not accessible.' }] }
}

describe('Claude interactive lifecycle', () => {
  it.each(['stop_sequence', 'end_turn', null])('treats a native API failure with %s as an error', (stopReason) => {
    const view = parseTranscript('claude', 'session', jsonl([
      request,
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'read', name: 'Read', input: {} }] } },
      { ...failure, message: { ...failure.message, stop_reason: stopReason } }
    ]))
    expect(view).toMatchObject({ state: 'error', terminal: true, title: failure.message.content[0].text,
      startedAt: START, endedAt: END })
    expect(view?.steps[0].status).toBe('error')
  })

  it('keeps the error and its timing through a local command split across appends', () => {
    const parse = claudePlugin.createParser!()
    const reducer = createReducer()
    reducer.push(parse(jsonl([request, failure, {
      type: 'user', isMeta: true, uuid: 'caveat', promptId: 'local-prompt', timestamp: END + 1000,
      message: { content: '<local-command-caveat>This command was run locally.</local-command-caveat>' }
    }])).events)
    reducer.push(parse(jsonl([
      { type: 'user', parentUuid: 'caveat', promptId: 'local-prompt', timestamp: END + 2000,
        message: { content: '<command-name>/list-agents</command-name>\n<command-message>list-agents</command-message>' } },
      { type: 'system', subtype: 'local_command', timestamp: END + 3000,
        content: '<local-command-stdout>This session: ...</local-command-stdout>' }
    ])).events)
    expect(reducer.snapshot()).toMatchObject({ state: 'error', terminal: true, turn: 1, startedAt: START, endedAt: END })
    reducer.push(parse(jsonl([{ ...request, timestamp: END + 4000 }])).events)
    expect(reducer.snapshot()).toMatchObject({ state: 'waiting', terminal: false, turn: 2, startedAt: END + 4000 })
    expect(reducer.snapshot().endedAt).toBeUndefined()
  })

  it('preserves real slash prompts and ordinary assistant explanations of API errors', () => {
    const view = parseTranscript('claude', 'session', jsonl([request, failure,
      { type: 'user', timestamp: END + 1000, promptId: 'real-prompt',
        message: { content: '<command-name>/review</command-name>' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Investigating model_not_found in the application.' }] } }
    ]))
    expect(view).toMatchObject({ state: 'thinking', terminal: false, turn: 2, startedAt: END + 1000 })
  })

  it.each(['[Request interrupted by user]', '[Request interrupted by user for tool use]'])('recognizes %s as an interruption, not a new request', (content) => {
    expect(parseTranscript('claude', 'session', jsonl([request,
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '检查中' }] } },
      { type: 'user', timestamp: END, message: { content: [{ type: 'text', text: content }] } }
    ]))).toMatchObject({ state: 'error', title: '已中断', terminal: true, turn: 1, startedAt: START, endedAt: END })
  })
})
