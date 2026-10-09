import type { ActivityOperation, OperationKind } from '../shared/activity'

/** Describe recorded tool inputs only; never execute a command to identify it. */
export function describeOperation(name: string, input: Record<string, unknown>): ActivityOperation {
  const short = name.split(/[.:]/).pop()?.replace(/ToolCall$/, '') ?? name
  const key = short.toLowerCase()
  const command = commandText(input.command) || commandText(input.cmd)
  const file = stringOf(input.path) || stringOf(input.file_path) || stringOf(input.filePath) || stringOf(input.target_file)
  const skill = stringOf(input.skill) || stringOf(input.skill_name)
  const skillPath = (file || command).match(/(?:^|[/\\\s'"])([^/\\\s'"]+)[/\\]SKILL\.md\b/i)
  // Exec wrappers expose literal tool names in their recorded source. Do not evaluate it.
  const wrapped = key === 'exec' ? command.match(/\btools\.(mcp__[\w]+|mcp_[\w]+)\s*\(/)?.[1] : undefined
  const mcpName = wrapped || name
  const mcp = mcpName.match(/(?:^|[.:])mcp__(.+?)__(.+)$/) || mcpName.match(/(?:^|[.:])mcp_([^_]+)_(.+)$/)
  let kind: OperationKind = 'tool'
  let label = short
  if (key === 'skill' || key === 'use_skill' || key === 'read_skill' || skillPath) {
    kind = 'skill'
    label = skill || skillPath?.[1] || short
  } else if (mcp) {
    kind = 'mcp'
    label = `${mcp[1]} / ${mcp[2]}`
  } else if (/^(task|agent|spawn_agent|send_message|followup_task|wait_agent|list_agents|interrupt_agent)$/.test(key)) {
    kind = 'agent'
    label = stringOf(input.task_name) || stringOf(input.subagent_type) || stringOf(input.target) || short
  } else if (command || /^(bash|shell|shell_command|exec|exec_command|run_shell_command|write_stdin)$/.test(key)) {
    kind = 'command'
  } else if (/^(read|read_file|read_many_files|list_directory)$/.test(key)) {
    kind = 'read'
    label = file || short
  } else if (/^(edit|write|write_file|apply_patch|multiedit|replace)$/.test(key)) {
    kind = 'edit'
    label = file || short
  } else if (/search|grep|glob|webfetch|browse|fetch/.test(key)) {
    kind = 'search'
    label = stringOf(input.query) || stringOf(input.pattern) || short
  }
  const shell = stringOf(input.shell) || (/^cmd(?:\.exe)?\s/i.test(command) ? 'cmd' : /^pwsh|^powershell/i.test(command) ? 'PowerShell' : key === 'bash' ? 'Bash' : '')
  return {
    kind, name: label.slice(0, 120),
    ...(command && !wrapped ? { command: command.slice(0, 4000) } : {}),
    ...(shell ? { shell } : {}),
    ...((input.workdir || input.cwd) ? { cwd: stringOf(input.workdir) || stringOf(input.cwd) } : {})
  }
}

export function commandText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((part) => {
    if (typeof part === 'string') return /\s/.test(part) ? JSON.stringify(part) : part
    if (part && typeof part === 'object' && 'cmd' in part) return stringOf(part.cmd)
    return ''
  }).filter(Boolean).join(' ')
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
