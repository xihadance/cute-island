import type { ActivityState, ActivityStep } from '../shared/activity'

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
  steps: ActivityStep[]
  /** The transcript itself says this turn finished. */
  terminal: boolean
}

interface AgentEvent {
  kind: 'user' | 'thinking' | 'text' | 'tool' | 'tool_result' | 'done' | 'error'
  title: string
  ok?: boolean
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
  const events = text
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
  if (Array.isArray(row.toolCalls)) events.push(...eventsFromToolCalls(row.toolCalls))
  if (Array.isArray(message.toolCalls)) events.push(...eventsFromToolCalls(message.toolCalls))
  events.push(...eventsFromContent(content, role))
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
  if (type === 'task_complete') return [{ kind: 'done', title: cleanText(textOf(payload.message)) || '已完成' }]
  if (type === 'error' || type === 'turn_aborted') {
    return [{ kind: 'error', title: cleanText(textOf(payload.message) || textOf(payload.error)) || '执行失败' }]
  }
  if (type === 'exec_command_begin' || type === 'exec_command_end') {
    const command = textOf(payload.command) || joinCommand(payload.parsed_cmd)
    if (type === 'exec_command_begin') return [{ kind: 'tool', title: toolTitle('shell', { command }) }]
    const ok = payload.exit_code === undefined || payload.exit_code === 0
    return [{ kind: 'tool_result', title: ok ? '命令完成' : '命令失败', ok }]
  }
  return []
}

function eventsFromResponseItem(payload: unknown): AgentEvent[] {
  if (!isRecord(payload)) return []
  const type = textOf(payload.type)
  if (type === 'function_call' || type === 'custom_tool_call' || type === 'tool_call') {
    const name = textOf(payload.name) || 'tool'
    const input = parseMaybeRecord(payload.arguments ?? payload.input ?? payload.args)
    return [{ kind: 'tool', title: toolTitle(name, input) }]
  }
  if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'tool_result') {
    const ok = payload.is_error !== true && payload.status !== 'error'
    return [{ kind: 'tool_result', title: ok ? '工具完成' : '工具失败', ok }]
  }
  if (type === 'reasoning') {
    const summary = Array.isArray(payload.summary) ? payload.summary : []
    const title = summary.map((item) => (isRecord(item) ? textOf(item.text) : '')).find(Boolean)
    return title ? [{ kind: 'thinking', title: cleanText(title) }] : [{ kind: 'thinking', title: '思考中' }]
  }
  if (type === 'message') {
    const role = textOf(payload.role)
    return eventsFromContent(payload.content, role)
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
  return [{ kind: 'tool', title: toolTitle(name.replace(/ToolCall$/, ''), args) }]
}

function eventsFromToolCalls(calls: unknown[]): AgentEvent[] {
  return calls.flatMap((call) => {
    if (!isRecord(call)) return []
    const name = textOf(call.name) || 'tool'
    const input = parseMaybeRecord(call.args ?? call.input ?? call.arguments)
    const status = textOf(call.status)
    const events: AgentEvent[] = [{ kind: 'tool', title: toolTitle(name, input) }]
    if (status === 'success' || status === 'error' || status === 'cancelled' || call.result !== undefined) {
      events.push({
        kind: 'tool_result',
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
      return [{ kind: 'tool' as const, title: toolTitle(name, input) }]
    }
    if (block.type === 'tool_result' || isRecord(block.functionResponse)) {
      const response = isRecord(block.functionResponse) ? block.functionResponse : block
      const ok = block.is_error !== true && response.is_error !== true && !hasError(response.response)
      return [{ kind: 'tool_result' as const, title: ok ? '工具完成' : '工具失败', ok }]
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
  return [{ kind: 'text', title }]
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
  let title = '正在处理'
  let detail: string | undefined
  let state: ActivityState = 'thinking'
  let terminal = false

  for (const event of events) {
    if (event.kind === 'user') {
      detail = clip(event.title, 160)
      state = 'waiting'
      title = '等待回复'
      terminal = false
      continue
    }
    if (event.kind === 'thinking' || event.kind === 'text') {
      state = 'thinking'
      title = clip(event.title, 80)
      terminal = false
      continue
    }
    if (event.kind === 'tool') {
      state = 'running'
      title = clip(event.title, 80)
      steps.push({ id: `s${steps.length + 1}`, label: title, status: 'active' })
      terminal = false
      continue
    }
    if (event.kind === 'tool_result') {
      const open = [...steps].reverse().find((step) => step.status === 'active')
      if (open) open.status = event.ok === false ? 'error' : 'done'
      if (event.ok === false) {
        state = 'error'
        title = '工具执行失败'
        terminal = true
      } else if (state !== 'error') {
        state = 'running'
        title = open ? open.label : '正在处理结果'
        terminal = false
      }
      continue
    }
    if (event.kind === 'done') {
      state = 'success'
      title = event.title && event.title !== '已完成' ? clip(event.title, 80) : title === '等待回复' ? '已完成' : clip(title, 80)
      for (const step of steps) if (step.status === 'active') step.status = 'done'
      terminal = true
      continue
    }
    state = 'error'
    title = clip(event.title, 80)
    for (const step of steps) if (step.status === 'active') step.status = 'error'
    terminal = true
  }

  if (state === 'success' && title === '等待回复') title = '已完成'
  return {
    state,
    title,
    detail,
    steps: steps.slice(-4),
    terminal
  }
}

function toolTitle(name: string, input: Record<string, unknown>): string {
  const description = textOf(input.description) || textOf(input.summary)
  if (description) return clip(description, 80)
  const command = textOf(input.command) || textOf(input.cmd)
  if (command) return clip(command.replace(/\s+/g, ' '), 80)
  const file = textOf(input.path) || textOf(input.file_path) || textOf(input.filePath) || textOf(input.target_file)
  const label = TOOL_LABEL[name.toLowerCase()] || name.replace(/[_-]+/g, ' ')
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

function joinCommand(value: unknown): string {
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(' ')
  return textOf(value)
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
