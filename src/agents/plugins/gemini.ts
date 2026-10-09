import path from 'node:path'
import { cleanText, isRecord, jsonlRows, messageEvents, textOf, toolCallEvents } from '../events'
import type { AgentEvent, AgentPlugin, ParsedTranscript } from '../types'

/** Gemini CLI: `~/.gemini/tmp/<hash>/chats/session-*.json[l]`, JSON documents or JSONL. */
export const geminiPlugin: AgentPlugin = {
  kind: 'gemini',
  label: 'Gemini',
  defaultRoot: (home, env) => path.join(env.GEMINI_CLI_HOME || path.join(home, '.gemini'), 'tmp'),
  accepts: (file) => {
    const base = path.basename(file)
    return base.startsWith('session-') && /\.jsonl?$/.test(base)
  },
  sessionIdFrom: (file) => path.basename(file).replace(/\.jsonl?$/, '').replace(/^session-/, ''),
  wholeFile: (file) => file.endsWith('.json'),
  parse: parseGemini,
  createParser: () => (text) => ({ events: jsonlRows(text).flatMap(rowEvents) }),
  executables: ['gemini'],
  scripts: [/\/@google\/gemini-cli\//i]
}

function parseGemini(text: string): ParsedTranscript {
  // Gemini persists a pretty-printed JSON document, unlike the JSONL agents.
  try {
    const document: unknown = JSON.parse(text)
    if (isRecord(document) && Array.isArray(document.messages)) {
      return { events: document.messages.flatMap(rowEvents), sessionId: textOf(document.sessionId) || undefined }
    }
  } catch { /* JSONL or a document that is still being written. */ }
  return { events: jsonlRows(text).flatMap(rowEvents) }
}

function rowEvents(row: unknown): AgentEvent[] {
  if (!isRecord(row)) return []
  const events: AgentEvent[] = []
  if (Array.isArray(row.thoughts)) {
    for (const thought of row.thoughts) {
      if (isRecord(thought)) events.push({ kind: 'thinking', title: cleanText(textOf(thought.subject) || textOf(thought.description)) || '思考中' })
    }
  }
  events.push(...messageEvents(row))
  if (Array.isArray(row.toolCalls)) events.push(...toolCallEvents(row.toolCalls))
  if (row.type === 'gemini' && (!Array.isArray(row.toolCalls) || row.toolCalls.length === 0) && events.some((event) => event.kind === 'text')) {
    events.push({ kind: 'done', title: '' })
  }
  return events
}
