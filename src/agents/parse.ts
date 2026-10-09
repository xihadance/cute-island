import type { ActivityOperation, ActivityState, ActivityStep } from '../shared/activity'
import { commandText, describeOperation } from './operation'

export type AgentKind = 'claude' | 'codex' | 'gemini' | 'cursor'

export const AGENT_LABEL: Record<AgentKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini',
  cursor: 'Cursor'
}

export interface SessionView {
  id: string
  agent: string
  kind: AgentKind
  state: ActivityState
  title: string
  detail?: string
  operation?: ActivityOperation
  steps: ActivityStep[]
  /** The transcript itself says this turn finished. */
  terminal: boolean
}

interface AgentEvent {
  kind: 'user' | 'thinking' | 'text' | 'tool' | 'approval' | 'tool_result' | 'done' | 'error'
  title: string
  ok?: boolean
  callId?: string
  operation?: ActivityOperation
  reason?: string
}

const TOOL_LABEL: Record<string, string> = {
  bash: '运行命令',
  shell: '运行命令',
  exec: '运行命令',
  exec_command: '运行命令',
  run_shell_command: '运行命令',
  read: '读取文件',
  read_file: '读取文件',
  edit: '修改文件',
  write: '写入文件',
  write_file: '写入文件',
  apply_patch: '修改文件',
  grep: '搜索代码',
  glob: '查找文件',
  search_file_content: '搜索代码',
  list_directory: '查看目录',
  websearch: '搜索网页',
  webfetch: '打开网页',
  task: '派生子任务'
}

export function parseTranscript(kind: AgentKind, sessionId: string, text: string): SessionView | null {
  // Gemini persists a pretty-printed JSON document, unlike the JSONL agents.
  let rows: unknown[] | undefined
  if (kind === 'gemini') {
    try {
      const document: unknown = JSON.parse(text)
      if (isRecord(document) && Array.isArray(document.messages)) {
        rows = document.messages
        sessionId = textOf(document.sessionId) || sessionId
      }
    } catch { /* JSONL or a document that is still being written. */ }
  }
  const events = rows ? rows.flatMap(eventsFromRow) : text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => eventsFromLine(line))
  if (events.length === 0) return null
  const reduced = reduceEvents(events)
  return {
    id: activityId(kind, sessionId),
    agent: AGENT_LABEL[kind],
    kind,
    ...reduced
  }
}

export function activityId(kind: AgentKind, sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 60)
  return `${kind}-${cleaned || 'session'}`.slice(0, 80)
}

function eventsFromLine(line: string): AgentEvent[] {
  try {
    return eventsFromRow(JSON.parse(line) as unknown)
  } catch {
    return []
  }
}

function eventsFromRow(row: unknown): AgentEvent[] {
  if (!isRecord(row)) return []
  if (row.type === 'turn_ended') return [endedEvent(row.status, row.error)]
  if (row.type === 'event_msg') return eventsFromCodexEvent(row.payload)
  if (row.type === 'response_item') return eventsFromResponseItem(row.payload)
  if (row.type === 'tool_call') return eventsFromCursorToolCall(row)
  if (row.type === 'result' && (row.subtype === 'success' || row.is_error === true)) {
    return [endedEvent(row.is_error === true ? 'error' : 'success', row.result ?? row.error)]
  }

  const events: AgentEvent[] = []
  const message = isRecord(row.message) ? row.message : row
  const role = textOf(row.role) || textOf(message.role) || textOf(row.type)
  const content = message.content ?? row.content ?? row.parts ?? message.parts
  if (role === 'system' || role === 'developer' || role === 'info') return []
  if (Array.isArray(row.thoughts)) {
    for (const thought of row.thoughts) {
      if (isRecord(thought)) events.push({ kind: 'thinking', title: cleanText(textOf(thought.subject) || textOf(thought.description)) || '思考中' })
    }
  }
  events.push(...eventsFromContent(content, role))
  if (Array.isArray(row.toolCalls)) events.push(...eventsFromToolCalls(row.toolCalls))
  if (message !== row && Array.isArray(message.toolCalls)) events.push(...eventsFromToolCalls(message.toolCalls))
  if (message.stop_reason === 'end_turn' || message.stop_reason === 'stop_sequence') {
    events.push({ kind: 'done', title: '' })
  }
  if (row.type === 'gemini' && (!Array.isArray(row.toolCalls) || row.toolCalls.length === 0) && events.some((event) => event.kind === 'text')) {
    events.push({ kind: 'done', title: '' })
  }
  return events
}

function eventsFromCodexEvent(payload: unknown): AgentEvent[] {
  if (!isRecord(payload)) return []
  const type = textOf(payload.type)
  if (type === 'user_message') return [{ kind: 'user', title: cleanText(textOf(payload.message) || textOf(payload.text)) }]
  if (type === 'agent_message' || type === 'agent_reasoning') {
    const title = cleanText(textOf(payload.message) || textOf(payload.text))
    return title ? [{ kind: type === 'agent_reasoning' ? 'thinking' : 'text', title }] : []
  }
  if (type === 'task_started') return [{ kind: 'thinking', title: '开始执行' }]
  if (type === 'task_complete') return [{ kind: 'done', title: cleanText(textOf(payload.last_agent_message) || textOf(payload.message)) || '已完成' }]
  if (type === 'error' || type === 'turn_aborted') {
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
  return []
}

function eventsFromResponseItem(payload: unknown): AgentEvent[] {
  if (!isRecord(payload)) return []
  const type = textOf(payload.type)
  if (type === 'function_call' || type === 'custom_tool_call' || type === 'tool_call') {
    const name = textOf(payload.name) || 'tool'
    const input = parseMaybeRecord(payload.arguments ?? payload.input ?? payload.args)
    return [toolEvent(name, input, textOf(payload.call_id) || undefined)]
  }
  if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'tool_result') {
    const ok = payload.is_error !== true && payload.status !== 'error'
    return [{ kind: 'tool_result', title: ok ? '工具完成' : '工具失败', ok, callId: textOf(payload.call_id) || undefined }]
  }
  if (type === 'reasoning') {
    const summary = Array.isArray(payload.summary) ? payload.summary : []
    const title = summary.map((item) => (isRecord(item) ? textOf(item.text) : '')).find(Boolean)
    return title ? [{ kind: 'thinking', title: cleanText(title) }] : [{ kind: 'thinking', title: '思考中' }]
  }
  if (type === 'message') {
    const role = textOf(payload.role)
    const events = eventsFromContent(payload.content, role)
    if (role === 'assistant' && payload.phase === 'final_answer') events.push({ kind: 'done', title: '' })
    return events
  }
  return []
}

function eventsFromCursorToolCall(row: Record<string, unknown>): AgentEvent[] {
  const call = isRecord(row.tool_call) ? row.tool_call : {}
  const name = Object.keys(call)[0] || textOf(row.name) || 'tool'
  const body = isRecord(call[name]) ? call[name] : call
  const args = isRecord(body.args) ? body.args : isRecord(body.input) ? body.input : {}
  if (row.subtype === 'completed' || isRecord(body.result)) {
    const ok = !isRecord(body.result) || body.result.error === undefined
    return [{ kind: 'tool_result', title: toolTitle(name.replace(/ToolCall$/, ''), args), ok }]
  }
  return [toolEvent(name.replace(/ToolCall$/, ''), args)]
}

function eventsFromToolCalls(calls: unknown[]): AgentEvent[] {
  return calls.flatMap((call) => {
    if (!isRecord(call)) return []
    const name = textOf(call.name) || 'tool'
    const input = parseMaybeRecord(call.args ?? call.input ?? call.arguments)
    const status = textOf(call.status)
    const callId = textOf(call.id) || undefined
    const events: AgentEvent[] = [toolEvent(name, input, callId, status === 'awaiting_approval' || status === 'awaitingApproval')]
    if (status === 'success' || status === 'error' || status === 'cancelled' || call.result !== undefined) {
      events.push({
        kind: 'tool_result',
        callId,
        title: status === 'error' ? '工具失败' : '工具完成',
        ok: status !== 'error' && status !== 'cancelled'
      })
    }
    return events
  })
}

function eventsFromContent(content: unknown, role: string): AgentEvent[] {
  if (typeof content === 'string') return eventsFromText(content, role)
  if (!Array.isArray(content)) return []
  return content.flatMap((block) => {
    if (typeof block === 'string') return eventsFromText(block, role)
    if (!isRecord(block)) return []
    if (block.type === 'thinking' || block.thought === true) {
      const title = cleanText(textOf(block.thinking) || textOf(block.text) || textOf(block.thought))
      return title ? [{ kind: 'thinking' as const, title }] : []
    }
    if (block.type === 'tool_use' || isRecord(block.functionCall)) {
      const call = isRecord(block.functionCall) ? block.functionCall : block
      const name = textOf(call.name) || 'tool'
      const input = parseMaybeRecord(call.input ?? call.args ?? call.arguments)
      return [toolEvent(name, input, textOf(call.id) || undefined)]
    }
    if (block.type === 'tool_result' || isRecord(block.functionResponse)) {
      const response = isRecord(block.functionResponse) ? block.functionResponse : block
      const ok = block.is_error !== true && response.is_error !== true && !hasError(response.response)
      return [{ kind: 'tool_result' as const, title: ok ? '工具完成' : '工具失败', ok, callId: textOf(block.tool_use_id) || undefined }]
    }
    if (block.type === 'text' || block.text !== undefined) {
      return eventsFromText(textOf(block.text), role)
    }
    return []
  })
}

function eventsFromText(raw: string, role: string): AgentEvent[] {
  const title = cleanText(unwrapUserQuery(raw))
  if (!title || title === '[REDACTED]') return []
  if (role === 'user' || role === 'human') return [{ kind: 'user', title }]
  if (role === 'assistant' || role === 'model' || role === 'gemini') return [{ kind: 'text', title }]
  return []
}

function endedEvent(status: unknown, message: unknown): AgentEvent {
  const title = cleanText(textOf(message))
  if (status === 'error' || status === 'failed') {
    return { kind: 'error', title: title || '执行失败' }
  }
  return { kind: 'done', title: title || '已完成' }
}

function reduceEvents(events: AgentEvent[]): Omit<SessionView, 'id' | 'agent' | 'kind'> {
  const steps: ActivityStep[] = []
  const calls = new Map<string, ActivityStep>()
  const stepEvents = new Map<string, AgentEvent>()
  let stepSequence = 0
  let title = '正在处理'
  let detail: string | undefined
  let operation: ActivityOperation | undefined
  let taskDetail: string | undefined
  let state: ActivityState = 'thinking'
  let terminal = false

  for (const event of events) {
    if (event.kind === 'user') {
      steps.length = 0
      calls.clear()
      stepEvents.clear()
      detail = clip(event.title, 160)
      taskDetail = detail
      operation = undefined
      state = 'waiting'
      title = '等待回复'
      terminal = false
      continue
    }
    if (event.kind === 'thinking' || event.kind === 'text') {
      if (steps.some((step) => step.status === 'waiting')) continue
      state = 'thinking'
      operation = undefined
      detail = taskDetail
      title = clip(event.title, 80)
      terminal = false
      continue
    }
    if (event.kind === 'tool' || event.kind === 'approval') {
      const waiting = event.kind === 'approval'
      state = waiting ? 'approval' : 'running'
      title = clip(event.title, 80)
      operation = event.operation
      detail = waiting ? event.reason || taskDetail : taskDetail
      const existing = event.callId ? calls.get(event.callId) : undefined
      const step: ActivityStep = existing ?? { id: `s${++stepSequence}`, label: title, status: 'active' }
      step.status = waiting ? 'waiting' : 'active'
      step.kind = operation?.kind
      if (!existing) steps.push(step)
      stepEvents.set(step.id, event)
      if (event.callId) calls.set(event.callId, step)
      const blocked = steps.find((item) => item.status === 'waiting')
      if (blocked) {
        const pending = stepEvents.get(blocked.id)!
        state = 'approval'
        title = blocked.label
        operation = pending.operation
        detail = pending.reason || taskDetail
      }
      terminal = false
      continue
    }
    if (event.kind === 'tool_result') {
      let open = event.callId ? calls.get(event.callId) : undefined
      if (!event.callId) {
        for (let index = steps.length - 1; index >= 0; index -= 1) {
          if (steps[index].status === 'active' || steps[index].status === 'waiting') { open = steps[index]; break }
        }
      }
      if (open) open.status = event.ok === false ? 'error' : 'done'
      if (event.ok === false) {
        state = 'error'
        title = '工具执行失败'
        terminal = true
      } else if (state !== 'error') {
        state = steps.some((step) => step.status === 'waiting') ? 'approval' : steps.some((step) => step.status === 'active') ? 'running' : 'thinking'
        const pending = steps.find((step) => step.status === 'waiting') || steps.find((step) => step.status === 'active')
        if (pending) {
          title = pending.label
          operation = stepEvents.get(pending.id)?.operation
          detail = state === 'approval' ? stepEvents.get(pending.id)?.reason || taskDetail : taskDetail
        } else detail = taskDetail
        if (state === 'thinking') { title = '正在处理结果'; operation = undefined }
        terminal = false
      }
      continue
    }
    if (event.kind === 'done') {
      state = 'success'
      title = event.title && event.title !== '已完成' ? clip(event.title, 80) : title === '等待回复' ? '已完成' : clip(title, 80)
      for (const step of steps) if (step.status === 'active' || step.status === 'waiting') step.status = 'done'
      operation = undefined
      detail = taskDetail
      terminal = true
      continue
    }
    state = 'error'
    title = clip(event.title, 80)
    for (const step of steps) if (step.status === 'active' || step.status === 'waiting') step.status = 'error'
    terminal = true
  }

  if (state === 'success' && title === '等待回复') title = '已完成'
  return {
    state,
    title,
    detail,
    operation,
    steps: steps.slice(-4),
    terminal
  }
}

function toolTitle(name: string, input: Record<string, unknown>): string {
  const description = textOf(input.description) || textOf(input.summary)
  if (description) return clip(description, 80)
  const operation = describeOperation(name, input)
  if (operation.kind === 'mcp') return clip(`调用 ${operation.name}`, 80)
  if (operation.kind === 'skill') return clip(`${name.toLowerCase() === 'skill' ? '使用' : '读取'}技能 ${operation.name}`, 80)
  if (operation.kind === 'agent') return clip(`协作 ${operation.name}`, 80)
  const command = commandText(input.command) || commandText(input.cmd)
  if (command) return clip(command.replace(/\s+/g, ' '), 80)
  const file = textOf(input.path) || textOf(input.file_path) || textOf(input.filePath) || textOf(input.target_file)
  const short = name.split(/[.:]/).pop() ?? name
  const label = TOOL_LABEL[short.toLowerCase()] || short.replace(/[_-]+/g, ' ')
  if (file) return clip(`${label} ${file.split(/[/\\]/).pop()}`, 80)
  const pattern = textOf(input.pattern) || textOf(input.query) || textOf(input.glob_pattern)
  if (pattern) return clip(`${label} ${pattern}`, 80)
  return clip(label, 80)
}

function unwrapUserQuery(text: string): string {
  const match = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i)
  return match?.[1] ?? text
}

function cleanText(text: string): string {
  return text
    .replace(/\[REDACTED\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toolEvent(name: string, input: Record<string, unknown>, callId?: string, approval = input.sandbox_permissions === 'require_escalated'): AgentEvent {
  return {
    kind: approval ? 'approval' : 'tool', title: toolTitle(name, input), callId,
    operation: describeOperation(name, input),
    ...(approval ? { reason: cleanText(textOf(input.justification) || textOf(input.reason)) } : {})
  }
}

function hasError(value: unknown): boolean {
  return isRecord(value) && (value.error !== undefined || value.is_error === true)
}

function parseMaybeRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) ? parsed : { command: value }
  } catch {
    return { command: value }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
