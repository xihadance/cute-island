import path from 'node:path'
import { endedEvent, isRecord, jsonlRows, messageEvents, textOf, timestampEvents, toolEvent, toolTitle } from '../events'
import type { AgentEvent, AgentPlugin, ParsedTranscript } from '../types'

/** Cursor agent: `~/.cursor/projects/<workspace>/agent-transcripts/<id>/<id>.jsonl`. */
export const cursorPlugin: AgentPlugin = {
  kind: 'cursor',
  label: 'Cursor',
  defaultRoot: (home, env) => path.join(env.CURSOR_HOME || path.join(home, '.cursor'), 'projects'),
  accepts: (file) => file.includes(`${path.sep}agent-transcripts${path.sep}`) && file.endsWith('.jsonl'),
  sessionIdFrom: (file) => path.basename(file).replace(/\.jsonl$/, ''),
  parse: parseCursor,
  createParser: () => parseCursor,
  executables: ['cursor-agent', 'agent'],
  scripts: [/\/cursor-agent\//i]
}

function parseCursor(text: string): ParsedTranscript {
  return { events: jsonlRows(text).flatMap(rowEvents) }
}

function rowEvents(row: unknown): AgentEvent[] {
  if (!isRecord(row)) return []
  if (row.type === 'turn_ended') return timestampEvents([endedEvent(row.status, row.error)], row)
  if (row.type === 'tool_call') return timestampEvents(toolCallRow(row), row)
  return timestampEvents(messageEvents(row), row)
}

function toolCallRow(row: Record<string, unknown>): AgentEvent[] {
  const call = isRecord(row.tool_call) ? row.tool_call : {}
  const name = Object.keys(call)[0] || textOf(row.name) || 'tool'
  const body = isRecord(call[name]) ? call[name] : call
  const args = isRecord(body.args) ? body.args : isRecord(body.input) ? body.input : {}
  const short = name.replace(/ToolCall$/, '')
  if (row.subtype === 'completed' || isRecord(body.result)) {
    const ok = !isRecord(body.result) || body.result.error === undefined
    return [{ kind: 'tool_result', title: toolTitle(short, args), ok }]
  }
  return [toolEvent(short, args)]
}
