import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BUILTIN_PLUGINS } from './plugins'
import type { AgentPlugin } from './types'

const execFileAsync = promisify(execFile)
const RUNTIMES = ['node', 'nodejs', 'bun']

/** Kinds of agents with a running process, detected from executables and npm script paths. */
export async function listAgentProcesses(plugins: readonly AgentPlugin[] = BUILTIN_PLUGINS): Promise<Set<string>> {
  try { return (await listProcessSnapshot(plugins)).running } catch { return new Set() }
}

export interface ProcessInfo {
  pid: number
  parentPid: number
  name: string
  commandLine: string
  createdAt?: number
}

export interface ProcessSnapshot {
  running: Set<string>
  processes: ProcessInfo[]
}

/** One query provides both liveness and the ancestry needed for session client labels. */
export async function listProcessSnapshot(plugins: readonly AgentPlugin[] = BUILTIN_PLUGINS): Promise<ProcessSnapshot> {
  const names = [...new Set([...plugins.flatMap((plugin) => plugin.executables), ...RUNTIMES])]
  const pattern = `^(${names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(\\.exe)?$`
  const { stdout } = process.platform === 'win32'
      ? await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; parentPid = $_.ParentProcessId; name = $_.Name; commandLine = $(if ($_.Name -match '${pattern}') { $_.CommandLine } else { '' }); createdAt = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }) } } | ConvertTo-Json -Compress`],
        { encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 })
      : await execFileAsync('ps', ['-ax', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 3000, maxBuffer: 2 * 1024 * 1024 })
  return processSnapshotFrom(stdout, process.platform, plugins)
}

export function processSnapshotFrom(output: string, platform: string, plugins: readonly AgentPlugin[] = BUILTIN_PLUGINS): ProcessSnapshot {
  let processes: ProcessInfo[]
  if (platform === 'win32') {
    const data: unknown = JSON.parse(output.replace(/^\uFEFF/, '') || '[]')
    processes = (Array.isArray(data) ? data : [data]).flatMap((row) => {
      if (!row || !Number.isSafeInteger(row.pid) || row.pid <= 0 || !Number.isSafeInteger(row.parentPid) || typeof row.name !== 'string') return []
      const createdAt = typeof row.createdAt === 'string' ? Date.parse(row.createdAt) : NaN
      return [{ pid: row.pid, parentPid: row.parentPid, name: row.name, commandLine: typeof row.commandLine === 'string' ? row.commandLine : '',
        ...(Number.isFinite(createdAt) ? { createdAt } : {}) }]
    })
  } else {
    processes = output.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)
      if (!match) return []
      const commandLine = match[3]
      const name = (commandLine.match(/^"([^"]+)"|^(\S+)/)?.slice(1).find(Boolean) ?? '').split('/').pop() ?? ''
      return [{ pid: Number(match[1]), parentPid: Number(match[2]), name, commandLine }]
    })
  }
  return { processes, running: matchAgentProcesses(processes.map((row) => row.commandLine || row.name).join('\n'), plugins) }
}

const CLIENT_PROCESSES: Record<string, string> = {
  code: 'VS Code', 'code - insiders': 'VS Code Insiders', cursor: 'Cursor', windsurf: 'Windsurf',
  windowsterminal: 'Windows Terminal', wezterm: 'WezTerm', 'wezterm-gui': 'WezTerm',
  alacritty: 'Alacritty', kitty: 'kitty', 'gnome-terminal-server': 'GNOME Terminal', konsole: 'Konsole',
  terminal: 'Terminal', iterm2: 'iTerm2', warp: 'Warp'
}
const SHELL_PROCESSES: Record<string, string> = { pwsh: 'PowerShell', powershell: 'PowerShell', cmd: 'cmd', bash: 'Bash', zsh: 'Zsh', fish: 'Fish' }

/** Only call with a PID bound to this particular native session. */
export function clientForProcess(pid: number, processes: readonly ProcessInfo[]): string | undefined {
  const byPid = new Map(processes.map((row) => [row.pid, row]))
  const visited = new Set<number>()
  let current = byPid.get(pid)
  let shell: string | undefined
  while (current && visited.size < 32 && !visited.has(current.pid)) {
    visited.add(current.pid)
    const name = current.name.replace(/\.exe$/i, '').toLowerCase()
    if (CLIENT_PROCESSES[name]) return CLIENT_PROCESSES[name]
    shell ??= SHELL_PROCESSES[name]
    const parent = byPid.get(current.parentPid)
    // A recycled parent PID is not a client relationship.
    if (parent?.createdAt !== undefined && current.createdAt !== undefined && parent.createdAt > current.createdAt) break
    current = parent
  }
  return shell
}

export function matchAgentProcesses(output: string, plugins: readonly AgentPlugin[] = BUILTIN_PLUGINS): Set<string> {
  const found = new Set<string>()
  const executables = new Map(plugins.flatMap((plugin) => plugin.executables.map((name) => [name, plugin.kind] as const)))
  for (const line of output.split(/\r?\n/)) {
    const tokens = line.trim().match(/"[^"]*"|'[^']*'|[^\s,]+/g) ?? []
    const command = (tokens[0] ?? '').replace(/^["']|["']$/g, '')
    const executable = command.split(/[\\/]/).pop()?.replace(/\.exe$/i, '').toLowerCase() ?? ''
    const direct = executables.get(executable)
    if (direct) found.add(direct)
    if (!RUNTIMES.includes(executable)) continue
    // Inspect only the script argument, never task text that happens to mention an agent.
    const script = tokens.slice(1).find((token) => !token.startsWith('-'))?.replace(/^["']|["']$/g, '').replace(/\\/g, '/') ?? ''
    for (const plugin of plugins) {
      if (plugin.scripts?.some((scriptPattern) => scriptPattern.test(script))) found.add(plugin.kind)
    }
  }
  return found
}
