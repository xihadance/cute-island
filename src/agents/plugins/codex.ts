import { open } from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { commandText } from '../operation'
import { cleanText, contentEvents, isRecord, jsonlRows, messageEvents, outputText, parseMaybeRecord, safeId, textOf, toolEvent } from '../events'
import type { AgentEvent, AgentPlugin, ChildLink, ParsedTranscript } from '../types'
import { unwrapExec } from '../script-tool'
export { unwrapExec } from '../script-tool'

/**
 * Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl`.
 * Sub-agents are separate rollouts whose `session_meta` names a `parent_thread_id`.
 * Long commands yield to the background ("Script running with cell ID N") and are
 * settled by a later `wait`; sub-agents are settled by `wait` results or notifications.
 */
export const codexPlugin: AgentPlugin = {
  kind: 'codex',
  label: 'Codex',
  defaultRoot: (home, env) => path.join(env.CODEX_HOME || path.join(home, '.codex'), 'sessions'),
  accepts: (file) => {
    const base = path.basename(file)
    return base.startsWith('rollout-') && base.endsWith('.jsonl')
  },
  sessionIdFrom: codexSessionId,
  parse: (text) => createCodexParser()(text),
  createParser: createCodexParser,
  executables: ['codex'],
  scripts: [/\/@openai\/codex\//i],
  child: codexChild
}

const HEAD_BYTES = 16 * 1024
/** Injected user-role messages that are not prompts. */
const INJECTED = /^<(turn_aborted|environment_context|recommended_plugins|user_instructions|system-reminder)>/

interface Call {
  name: string
  input: Record<string, unknown>
  title: string
  /** Waiting on sub-agents is already shown by their own tasks. */
  background: boolean
}

function codexSessionId(file: string): string {
  const base = path.basename(file).replace(/\.jsonl?$/, '')
  return base.match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/i)?.[1] ?? base
}

function createCodexParser(): (text: string) => ParsedTranscript {
  const calls = new Map<string, Call>()
  /** Background script cells and unified-exec sessions, keyed to their starting call. */
  const cells = new Map<string, string>()
  const processes = new Map<string, string>()
  const open = new Set<string>()
  let events: AgentEvent[] = []

  const settleTurn = (): void => {
    // Codex never records whether yielded work survived the turn, so stop claiming it runs.
    for (const taskId of open) events.push({ kind: 'task_drop', taskId })
    open.clear()
    cells.clear()
    processes.clear()
    calls.clear()
  }

  const parse = (text: string): ParsedTranscript => {
    events = []
    let sessionId: string | undefined
    let client: string | undefined
    for (const row of jsonlRows(text)) {
      if (!isRecord(row)) continue
      if (row.type === 'session_meta') {
        const meta = isRecord(row.payload) ? row.payload : {}
        sessionId = textOf(meta.id) || undefined
        client = codexClient(meta)
        continue
      }
      if (row.type === 'event_msg') {
        const payload = isRecord(row.payload) ? row.payload : {}
        const type = textOf(payload.type)
        if (type === 'task_complete' || type === 'turn_aborted' || type === 'error' || type === 'user_message') settleTurn()
        events.push(...codexEvent(payload))
        continue
      }
      if (row.type === 'response_item') {
        events.push(...responseItem(isRecord(row.payload) ? row.payload : {}))
        continue
      }
      if (row.type === 'turn_context') continue
      events.push(...messageEvents(row))
    }
    return { events, sessionId, client }
  }
  return parse

  function responseItem(payload: Record<string, unknown>): AgentEvent[] {
    const type = textOf(payload.type)
    if (type === 'function_call' || type === 'custom_tool_call' || type === 'tool_call') {
      let name = textOf(payload.name) || 'tool'
      let input = parseMaybeRecord(payload.arguments ?? payload.input ?? payload.args)
      // Code mode wraps every tool in a script; show the tool it actually calls.
      if (name.split('.').pop() === 'exec' && typeof payload.input === 'string') {
        const inner = unwrapExec(payload.input)
        if (inner) ({ name, input } = inner)
      }
      const callId = textOf(payload.call_id) || undefined
      const event = toolEvent(name, input, callId)
      if (callId) calls.set(callId, { name: name.split('.').pop() ?? name, input, title: event.title, background: event.operation?.kind !== 'agent' })
      return [event]
    }
    if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'tool_result') {
      const callId = textOf(payload.call_id) || undefined
      const ok = payload.is_error !== true && payload.status !== 'error'
      const result: AgentEvent = { kind: 'tool_result', title: ok ? '工具完成' : '工具失败', ok, callId }
      const call = callId ? calls.get(callId) : undefined
      const events = call && callId ? backgroundEvents(call, callId, outputText(payload.output), result) : [result]
      if (callId) calls.delete(callId)
      return events
    }
    if (type === 'reasoning') {
      const summary = Array.isArray(payload.summary) ? payload.summary : []
      const title = summary.map((item) => (isRecord(item) ? textOf(item.text) : '')).find(Boolean)
      return [{ kind: 'thinking', title: title ? cleanText(title) : '思考中' }]
    }
    if (type === 'message') {
      const role = textOf(payload.role)
      if (role === 'user') {
        const first = outputText(payload.content).trimStart()
        if (first.startsWith('<subagent_notification>')) return notificationEvents(first)
        if (INJECTED.test(first)) return []
        const prompt = contentEvents(payload.content, role)
        if (prompt.some((event) => event.kind === 'user')) settleTurn()
        return prompt
      }
      const result = contentEvents(payload.content, role)
      if (role === 'assistant' && payload.phase === 'final_answer') result.push({ kind: 'done', title: '' })
      return result
    }
    return []
  }

  /** Keep a yielded call running until the wait that observes its end. */
  function backgroundEvents(call: Call, callId: string, output: string, result: AgentEvent): AgentEvent[] {
    const head = output.slice(0, 600)
    const cell = head.match(/^Script running with cell ID (\S+)/m)?.[1]
    const session = head.match(/Process running with session ID (\d+)/)?.[1]
    if (call.name === 'wait' || call.name === 'write_stdin') {
      const key = call.name === 'wait' ? textOf(call.input.cell_id) : String(call.input.session_id ?? '')
      const owners = call.name === 'wait' ? cells : processes
      const owner = owners.get(key)
      if (!owner || cell || session) return [result]
      const taskId = taskKey(call.name === 'wait' ? 'cell' : 'proc', key)
      const status = call.name === 'wait' ? scriptStatus(head) : processStatus(head)
      if (!status) return [result]
      owners.delete(key)
      open.delete(taskId)
      return [result, { kind: 'tool_result', title: '工具完成', ok: true, callId: owner }, { kind: 'task_end', taskId, status }]
    }
    const key = cell ?? session
    if (!key) return [result]
    const owners = cell ? cells : processes
    owners.set(key, callId)
    if (!call.background) return []
    const taskId = taskKey(cell ? 'cell' : 'proc', key)
    open.add(taskId)
    return [{ kind: 'task_start', taskId, task: 'command', label: call.title }]
  }
}

function codexClient(meta: Record<string, unknown>): string | undefined {
  const originator = textOf(meta.originator).toLowerCase()
  // The VS Code extension also runs in compatible editors, so it cannot prove the host.
  if (originator === 'codex_vscode' || meta.source === 'vscode') return 'IDE 扩展'
  if (originator === 'codex-tui' || originator === 'codex_exec' || meta.source === 'cli' || meta.source === 'exec') return 'CLI'
  return undefined
}

function codexEvent(payload: Record<string, unknown>): AgentEvent[] {
  const type = textOf(payload.type)
  if (type === 'user_message') return [{ kind: 'user', title: cleanText(textOf(payload.message) || textOf(payload.text)) }]
  if (type === 'agent_message' || type === 'agent_reasoning') {
    const title = cleanText(textOf(payload.message) || textOf(payload.text))
    return title ? [{ kind: type === 'agent_reasoning' ? 'thinking' : 'text', title }] : []
  }
  if (type === 'task_started') return [{ kind: 'thinking', title: '开始执行' }]
  if (type === 'task_complete') return [{ kind: 'done', title: cleanText(textOf(payload.last_agent_message) || textOf(payload.message)) || '已完成' }]
  if (type === 'turn_aborted') {
    const title = cleanText(textOf(payload.message) || textOf(payload.error))
    return [{ kind: 'error', title: title || (payload.reason === 'interrupted' ? '已中断' : '执行失败') }]
  }
  if (type === 'error') {
    return [{ kind: 'error', title: cleanText(textOf(payload.message) || textOf(payload.error)) || '执行失败' }]
  }
  if (type === 'exec_command_begin' || type === 'exec_command_end') {
    const command = commandText(payload.command) || commandText(payload.parsed_cmd)
    const callId = textOf(payload.call_id) || undefined
    if (type === 'exec_command_begin') return [toolEvent('shell', { ...payload, command }, callId, false)]
    const ok = payload.exit_code === undefined || payload.exit_code === 0
    return [{ kind: 'tool_result', title: ok ? '命令完成' : '命令失败', ok, callId }]
  }
  if (type === 'exec_approval_request' || type === 'apply_patch_approval_request') {
    return [toolEvent(type === 'exec_approval_request' ? 'shell' : 'apply_patch', payload, textOf(payload.call_id) || undefined, true)]
  }
  if (type === 'item_completed' && isRecord(payload.item) && payload.item.type === 'CollabAgentToolCall') {
    return collabEvents(payload.item)
  }
  return []
}

function collabEvents(item: Record<string, unknown>): AgentEvent[] {
  const tool = textOf(item.tool)
  const agents = Array.isArray(item.receiver_agents) ? item.receiver_agents.filter(isRecord) : []
  const ids = Array.isArray(item.receiver_thread_ids)
    ? item.receiver_thread_ids.map(textOf).filter(Boolean)
    : agents.map((agent) => textOf(agent.thread_id)).filter(Boolean)
  const nickname = (id: string): string => textOf(agents.find((agent) => agent.thread_id === id)?.agent_nickname)
  if (tool === 'spawn_agent') {
    if (item.status === 'failed') return []
    const prompt = cleanText(textOf(item.prompt))
    return ids.map((id) => ({ kind: 'task_start', taskId: safeId(id), task: 'agent', label: nickname(id) || '子 Agent', ...(prompt ? { detail: prompt } : {}) }))
  }
  if (tool === 'wait' || tool === 'wait_agent') {
    const states = isRecord(item.agents_states) ? item.agents_states : {}
    return Object.entries(states).flatMap(([id, state]) => agentEnd(id, state))
  }
  if (tool === 'close_agent') return ids.map((id) => ({ kind: 'task_end', taskId: safeId(id), status: 'stopped' }))
  return []
}

function notificationEvents(text: string): AgentEvent[] {
  const body = text.match(/<subagent_notification>([\s\S]*?)<\/subagent_notification>/)?.[1] ?? ''
  const notice = parseMaybeRecord(body.trim())
  const id = textOf(notice.agent_path) || textOf(notice.agent_id) || textOf(notice.thread_id)
  return id ? agentEnd(id, notice.status) : []
}

/** Agent states look like `"running"` or `{ "completed": "last message" }`. */
function agentEnd(id: string, state: unknown): AgentEvent[] {
  const [key, message] = typeof state === 'string'
    ? [state, '']
    : isRecord(state) ? [Object.keys(state)[0] ?? '', textOf(Object.values(state)[0])] : ['', '']
  const status = key === 'completed' ? 'done'
    : key === 'errored' || key === 'error' || key === 'failed' ? 'error'
      : key === 'shutdown' || key === 'interrupted' || key === 'not_found' ? 'stopped' : undefined
  if (!status) return []
  const detail = cleanText(message)
  return [{ kind: 'task_end', taskId: safeId(id), status, ...(detail ? { detail } : {}) }]
}

function scriptStatus(head: string): 'done' | 'error' | 'stopped' | undefined {
  const word = head.match(/^Script (completed|failed|terminated|error)/m)?.[1]
  if (word === 'completed') return 'done'
  if (word === 'terminated') return 'stopped'
  return word ? 'error' : undefined
}

function processStatus(head: string): 'done' | 'error' | undefined {
  const code = head.match(/Process exited with code (-?\d+)/)?.[1]
  if (code === undefined) return undefined
  return code === '0' ? 'done' : 'error'
}

function taskKey(prefix: string, key: string): string {
  return `${prefix}-${safeId(key, 40)}`
}

async function codexChild(file: string): Promise<ChildLink | null | undefined> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const decoder = new StringDecoder('utf8')
    let head = ''
    let offset = 0
    while (offset < 16 * 1024 * 1024) {
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, offset)
      offset += bytesRead
      head += decoder.write(buffer.subarray(0, bytesRead))
      const newline = head.indexOf('\n')
      const meta = newline < 0 ? head : head.slice(0, newline)
      const parent = meta.match(/"parent_thread_id"\s*:\s*"([^"\\]+)"/)?.[1]
      if (/"type"\s*:\s*"session_meta"/.test(meta) && parent) {
        return { parentSessionId: parent, taskId: safeId(codexSessionId(file)),
          label: meta.match(/"agent_nickname"\s*:\s*"([^"\\]+)"/)?.[1] || '子 Agent' }
      }
      if (newline >= 0 || bytesRead < HEAD_BYTES) {
        try { JSON.parse(meta); return null } catch { return undefined }
      }
    }
    return undefined
  } finally {
    await handle.close()
  }
}
