import { commandText, describeOperation } from './operation'
import type { AgentEvent, ToolEvent } from './types'

/** Shared row helpers. Plugins handle their native shapes first and fall back to these. */

const TOOL_LABEL: Record<string, string> = {
  bash: '运行命令',
  shell: '运行命令',
  exec: '运行命令',
  exec_command: '运行命令',
  run_shell_command: '运行命令',
  write_stdin: '与命令交互',
  wait: '等待后台任务',
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

const AGENT_ACTION: Record<string, string> = {
  spawn_agent: '派生子 Agent',
  wait_agent: '等待子 Agent',
  close_agent: '关闭子 Agent',
  send_input: '发消息给子 Agent',
  send_message: '发消息给子 Agent',
  list_agents: '查看子 Agent',
  interrupt_agent: '中断子 Agent'
}

/** Message-shaped rows shared by Claude, Cursor and Gemini JSONL logs. */
export function messageEvents(row: Record<string, unknown>): AgentEvent[] {
  if (row.type === 'result' && (row.subtype === 'success' || row.is_error === true)) {
    return [endedEvent(row.is_error === true ? 'error' : 'success', row.result ?? row.error)]
  }
  const events: AgentEvent[] = []
  const message = isRecord(row.message) ? row.message : row
  const role = textOf(row.role) || textOf(message.role) || textOf(row.type)
  const content = message.content ?? row.content ?? row.parts ?? message.parts
  if (role === 'system' || role === 'developer' || role === 'info') return []
  events.push(...contentEvents(content, role))
  if (message !== row && Array.isArray(message.toolCalls)) events.push(...toolCallEvents(message.toolCalls))
  if (message.stop_reason === 'end_turn' || message.stop_reason === 'stop_sequence') {
    events.push({ kind: 'done', title: '' })
  }
  return events
}

export function toolCallEvents(calls: unknown[]): AgentEvent[] {
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

export function contentEvents(content: unknown, role: string): AgentEvent[] {
  if (typeof content === 'string') return textEvents(content, role)
  if (!Array.isArray(content)) return []
  return content.flatMap((block): AgentEvent[] => {
    if (typeof block === 'string') return textEvents(block, role)
    if (!isRecord(block)) return []
    if (block.type === 'thinking' || block.thought === true) {
      const title = cleanText(textOf(block.thinking) || textOf(block.text) || textOf(block.thought))
      return title ? [{ kind: 'thinking', title }] : []
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
      return [{ kind: 'tool_result', title: ok ? '工具完成' : '工具失败', ok, callId: textOf(block.tool_use_id) || undefined }]
    }
    if (block.type === 'text' || block.text !== undefined) {
      return textEvents(textOf(block.text), role)
    }
    return []
  })
}

export function textEvents(raw: string, role: string): AgentEvent[] {
  const title = cleanText(unwrapUserQuery(raw))
  if (!title || title === '[REDACTED]') return []
  if (role === 'user' || role === 'human') return [{ kind: 'user', title }]
  if (role === 'assistant' || role === 'model' || role === 'gemini') return [{ kind: 'text', title }]
  return []
}

export function endedEvent(status: unknown, message: unknown): AgentEvent {
  const title = cleanText(textOf(message))
  if (status === 'error' || status === 'failed') {
    return { kind: 'error', title: title || '执行失败' }
  }
  return { kind: 'done', title: title || '已完成' }
}

export function toolEvent(name: string, input: Record<string, unknown>, callId?: string, approval = input.sandbox_permissions === 'require_escalated'): ToolEvent {
  const title = toolTitle(name, input)
  const operation = describeOperation(name, input)
  if (!approval) return { kind: 'tool', title, callId, operation }
  return { kind: 'approval', title, callId, operation, reason: cleanText(textOf(input.justification) || textOf(input.reason)) }
}

export function toolTitle(name: string, input: Record<string, unknown>): string {
  const description = textOf(input.description) || textOf(input.summary)
  if (description) return clip(description, 80)
  const operation = describeOperation(name, input)
  if (operation.kind === 'mcp') return clip(`调用 ${operation.name}`, 80)
  if (operation.kind === 'skill') return clip(`${name.toLowerCase() === 'skill' ? '使用' : '读取'}技能 ${operation.name}`, 80)
  if (operation.kind === 'agent') {
    const action = AGENT_ACTION[(name.split(/[.:]/).pop() ?? name).toLowerCase()]
    if (!action) return clip(`协作 ${operation.name}`, 80)
    return clip(operation.name && operation.name !== name.split(/[.:]/).pop() ? `${action} ${operation.name}` : action, 80)
  }
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

/** Split JSONL into parsed rows, skipping torn or invalid lines. */
export function jsonlRows(text: string): unknown[] {
  const rows: unknown[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      rows.push(JSON.parse(trimmed))
    } catch { /* A partial append or a corrupted line. */ }
  }
  return rows
}

/** Flatten tool output that may be a string or a list of text blocks. */
export function outputText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return isRecord(value) ? textOf(value.text) || textOf(value.content) : ''
  return value.map((part) => (typeof part === 'string' ? part : isRecord(part) ? textOf(part.text) : '')).join('\n')
}

export function unwrapUserQuery(text: string): string {
  const match = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i)
  return match?.[1] ?? text
}

export function cleanText(text: string): string {
  return text
    .replace(/\[REDACTED\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function clip(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}

export function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function parseMaybeRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) ? parsed : { command: value }
  } catch {
    return { command: value }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Activity and task ids share the store's id alphabet. */
export function safeId(value: string, max = 60): string {
  return value.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, max)
}

function hasError(value: unknown): boolean {
  return isRecord(value) && (value.error !== undefined || value.is_error === true)
}
