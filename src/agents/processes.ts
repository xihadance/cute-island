import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BUILTIN_PLUGINS } from './plugins'
import type { AgentPlugin } from './types'

const execFileAsync = promisify(execFile)
const RUNTIMES = ['node', 'nodejs', 'bun']

/** Kinds of agents with a running process, detected from executables and npm script paths. */
export async function listAgentProcesses(plugins: readonly AgentPlugin[] = BUILTIN_PLUGINS): Promise<Set<string>> {
  const names = [...new Set([...plugins.flatMap((plugin) => plugin.executables), ...RUNTIMES])]
  const pattern = `^(${names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(\\.exe)?$`
  try {
    // Command lines also identify npm-installed agents running as node.exe.
    const { stdout } = process.platform === 'win32'
      ? await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.Name -match '${pattern}' } | ForEach-Object { if ($_.CommandLine) { $_.CommandLine } else { $_.Name } }`],
        { encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 })
      : await execFileAsync('ps', ['-ax', '-o', 'args='], { encoding: 'utf8', timeout: 3000, maxBuffer: 2 * 1024 * 1024 })
    return matchAgentProcesses(stdout, plugins)
  } catch {
    return new Set()
  }
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
