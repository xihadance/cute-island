import { execFile } from 'node:child_process'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ActivityStore } from '../shared/activity'
import { parseTranscript, type AgentKind, type SessionView } from './parse'

const FRESH_MS = 8_000
const LOOKBACK_MS = 120_000
const RECOVERY_MS = 24 * 60 * 60_000
const TAIL_BYTES = 256 * 1024
const MAX_TAIL_BYTES = 4 * 1024 * 1024
const MAX_JSON_BYTES = 16 * 1024 * 1024
const FILES_PER_AGENT = 64
const execFileAsync = promisify(execFile)

export interface AgentRoots {
  claude: string
  codex: string
  gemini: string
  cursor: string
}

export interface WatchOptions {
  roots?: AgentRoots
  now?: () => number
  listProcesses?: () => Set<AgentKind> | Promise<Set<AgentKind>>
  intervalMs?: number
  freshMs?: number
  discoveryMs?: number
  processMs?: number
  /** Override for diagnostics and deterministic I/O tests. */
  readSession?: typeof readSession
}

interface TrackedSession {
  signature: string
  id: string
}

interface CachedSession {
  stamp: string
  view: SessionView | null
}

interface SessionFile {
  kind: AgentKind
  path: string
  sessionId: string
  mtimeMs: number
}

export function defaultAgentRoots(home = homedir(), env: NodeJS.ProcessEnv = process.env): AgentRoots {
  return {
    claude: path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects'),
    codex: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'sessions'),
    gemini: path.join(env.GEMINI_CLI_HOME || path.join(home, '.gemini'), 'tmp'),
    cursor: path.join(env.CURSOR_HOME || path.join(home, '.cursor'), 'projects')
  }
}

export class SessionWatcher {
  private readonly roots: AgentRoots
  private readonly now: () => number
  private readonly listProcesses: NonNullable<WatchOptions['listProcesses']>
  private readonly intervalMs: number
  private readonly freshMs: number
  private readonly discoveryMs: number
  private readonly processMs: number
  private readonly readSession: typeof readSession
  private readonly tracked = new Map<string, TrackedSession>()
  private readonly cache = new Map<string, CachedSession>()
  private files: SessionFile[] = []
  private running = new Set<AgentKind>()
  private activeClaudeIds = new Set<string>()
  private lastDiscovery = -Infinity
  private lastProcesses = -Infinity
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<void> | undefined
  private started = false
  private generation = 0

  constructor(private readonly store: ActivityStore, options: WatchOptions = {}) {
    this.roots = options.roots ?? defaultAgentRoots()
    this.now = options.now ?? Date.now
    this.listProcesses = options.listProcesses ?? listAgentProcesses
    this.intervalMs = options.intervalMs ?? 800
    this.freshMs = options.freshMs ?? FRESH_MS
    this.discoveryMs = options.discoveryMs ?? 10_000
    this.processMs = options.processMs ?? 5_000
    this.readSession = options.readSession ?? readSession
  }

  start(): void {
    if (this.started) return
    this.started = true
    const generation = this.generation
    const tick = async (): Promise<void> => {
      try {
        await this.scan()
      } catch (error) {
        console.error('会话扫描失败', error)
      }
      if (!this.started || generation !== this.generation) return
      this.timer = setTimeout(() => void tick(), this.intervalMs)
      this.timer.unref?.()
    }
    void tick()
  }

  stop(): void {
    this.started = false
    this.generation += 1
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Concurrent requests share a scan; slow disks never create overlapping work. */
  scan(): Promise<void> {
    this.pending ??= this.scanOnce(this.generation).finally(() => { this.pending = undefined })
    return this.pending
  }

  private async scanOnce(generation: number): Promise<void> {
    const now = this.now()
    if (now - this.lastProcesses >= this.processMs) {
      this.lastProcesses = now
      try {
        this.running = await this.listProcesses()
      } catch {
        // A transient process-query failure is not evidence that an agent exited.
      }
      this.activeClaudeIds = await activeClaudeSessions(path.join(this.roots.claude, '..', 'sessions'))
    }
    if (generation !== this.generation) return
    if (now - this.lastDiscovery >= this.discoveryMs) {
      this.files = await this.sessionFiles(now)
      this.lastDiscovery = now
    }
    const seen = new Set<string>()
    await mapLimited(this.files, 8, async (file) => {
      try {
        const info = await stat(file.path)
        const stamp = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`
        const previous = this.cache.get(file.path)
        const view = previous?.stamp === stamp
          ? previous.view
          : await this.readSession(file.kind, file.sessionId, file.path, info.size)
        if (generation !== this.generation) return
        // Incomplete appends and atomic JSON rewrites must not clear a live session.
        const parsed = view ?? previous?.view ?? null
        this.cache.set(file.path, { stamp, view: parsed })
        seen.add(file.path)
        if (!parsed) return
        const age = Math.max(0, now - info.mtimeMs)
        const known = this.tracked.has(file.path)
        const live = age <= this.freshMs || this.running.has(file.kind) || this.hasLiveRegistration(file)
        const presented = presentSession(parsed, live, age, known)
        if (!presented) return
        if (presented.terminal && age > this.freshMs && !known) return
        this.publish(file.path, presented)
      } catch {
        // Logs may be rotated, locked or deleted while an agent writes them.
      }
    })
    if (generation !== this.generation) return
    for (const file of this.cache.keys()) if (!seen.has(file)) this.cache.delete(file)
    const candidates = new Set(this.files.map((file) => file.path))
    for (const [file, tracked] of this.tracked) {
      if (seen.has(file)) continue
      // Preserve failures until explicitly dismissed, even if the log disappears.
      const activity = this.store.get(tracked.id)
      if (activity?.state === 'error' || activity?.state === 'success') continue
      if (candidates.has(file)) continue
      this.tracked.delete(file)
      this.store.dismiss(tracked.id)
    }
  }

  private publish(file: string, view: SessionView): void {
    const signature = JSON.stringify([view.state, view.title, view.detail ?? '', view.operation, view.steps])
    const previous = this.tracked.get(file)
    this.tracked.set(file, { signature, id: view.id })
    if (previous?.signature === signature) return
    this.store.upsert({
      id: view.id, agent: view.agent, state: view.state, title: view.title,
      detail: view.detail ?? null, operation: view.operation ?? null, steps: view.steps
    })
  }

  private async sessionFiles(now: number): Promise<SessionFile[]> {
    const retained = new Set<string>()
    for (const [file, tracked] of this.tracked) {
      if (this.store.get(tracked.id)) retained.add(file)
    }
    const groups = await Promise.all((Object.keys(this.roots) as AgentKind[]).map(async (kind) => {
      const files = await collect(this.roots[kind], kind)
      return files
        .filter((file) => retained.has(file.path) || this.hasLiveRegistration(file) || now - file.mtimeMs <= (this.running.has(kind) ? RECOVERY_MS : LOOKBACK_MS))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .filter((file, index) => index < FILES_PER_AGENT || retained.has(file.path) || this.hasLiveRegistration(file))
    }))
    return groups.flat()
  }

  private hasLiveRegistration(file: SessionFile): boolean {
    if (file.kind !== 'claude') return false
    return this.activeClaudeIds.has(file.sessionId) || this.activeClaudeIds.has(file.sessionId.slice(0, 8))
  }
}

/** Newer Claude versions register busy sessions by PID, including parked jobs. */
async function activeClaudeSessions(root: string): Promise<Set<string>> {
  const active = new Set<string>()
  try {
    const files = (await readdir(root)).filter((name) => /^\d+\.json$/.test(name))
    await mapLimited(files, 4, async (name) => {
      try {
        const file = path.join(root, name)
        if ((await stat(file)).size > 64 * 1024) return
        const row = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
        if (!row || row.pid !== Number(path.basename(name, '.json'))) return
        if (row.status !== 'busy' && row.status !== 'waiting') return
        const pid = Number(row.pid)
        if (!Number.isSafeInteger(pid) || pid <= 0) return
        process.kill(pid, 0)
        for (const id of [row.sessionId, row.parkedJobId]) {
          if (typeof id === 'string' && /^[A-Za-z0-9-]{8,}$/.test(id)) active.add(id)
        }
      } catch { /* Stale registrations and partial writes are expected. */ }
    })
  } catch { /* Older Claude versions do not have a session registry. */ }
  return active
}

async function collect(root: string, kind: AgentKind): Promise<SessionFile[]> {
  const found: SessionFile[] = []
  const dirs: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  while (dirs.length) {
    const batch = dirs.splice(0, 8)
    await Promise.all(batch.map(async ({ dir, depth }) => {
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        const files: string[] = []
        for (const entry of entries) {
          if (['node_modules', '.git', 'subagents'].includes(entry.name)) continue
          const full = path.join(dir, entry.name)
          if (entry.isDirectory() && depth < 6) dirs.push({ dir: full, depth: depth + 1 })
          else if (entry.isFile() && accepts(kind, full)) files.push(full)
        }
        await mapLimited(files, 4, async (file) => {
          try {
            const info = await stat(file)
            found.push({ kind, path: file, sessionId: sessionIdFrom(kind, file), mtimeMs: info.mtimeMs })
          } catch { /* File disappeared during discovery. */ }
        })
      } catch { /* An agent may not be installed, or a directory may be inaccessible. */ }
    }))
  }
  return found
}

function accepts(kind: AgentKind, file: string): boolean {
  const base = path.basename(file)
  if (kind === 'codex') return base.startsWith('rollout-') && base.endsWith('.jsonl')
  if (kind === 'gemini') return base.startsWith('session-') && /\.jsonl?$/.test(base)
  if (kind === 'cursor') return file.includes(`${path.sep}agent-transcripts${path.sep}`) && base.endsWith('.jsonl')
  return base.endsWith('.jsonl')
}

function sessionIdFrom(kind: AgentKind, file: string): string {
  const base = path.basename(file).replace(/\.jsonl?$/, '')
  if (kind === 'codex') return base.match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/i)?.[1] ?? base
  if (kind === 'gemini') return base.replace(/^session-/, '')
  return base
}

function presentSession(view: SessionView, live: boolean, age: number, known: boolean): SessionView | null {
  if (view.terminal || live) return view
  if (!known) return null
  if (age <= 60_000) return view
  return { ...view, state: 'error', title: '会话已中断', terminal: true }
}

export async function readSession(kind: AgentKind, sessionId: string, file: string, size: number): Promise<SessionView | null> {
  if (file.endsWith('.json') && size > MAX_JSON_BYTES) return null
  const fd = await open(file, 'r')
  try {
    let length = file.endsWith('.json') ? size : Math.min(size, TAIL_BYTES)
    while (length > 0) {
      const start = size - length
      const buffer = Buffer.alloc(length)
      let read = 0
      while (read < length) {
        const { bytesRead } = await fd.read(buffer, read, length - read, start + read)
        if (!bytesRead) break
        read += bytesRead
      }
      let text = buffer.subarray(0, read).toString('utf8')
      if (start > 0) {
        const newline = text.indexOf('\n')
        text = newline < 0 ? '' : text.slice(newline + 1)
      }
      const view = parseTranscript(kind, sessionId, text)
      if (view || length >= Math.min(size, MAX_TAIL_BYTES)) return view
      length = Math.min(size, length * 2, MAX_TAIL_BYTES)
    }
    return null
  } finally {
    await fd.close()
  }
}

async function mapLimited<T>(items: T[], limit: number, visit: (item: T) => Promise<void>): Promise<void> {
  let index = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) await visit(items[index++])
  }))
}

export async function listAgentProcesses(): Promise<Set<AgentKind>> {
  try {
    // Command lines also identify npm-installed agents running as node.exe.
    const { stdout } = process.platform === 'win32'
      ? await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Where-Object { $_.Name -match "^(claude|codex|gemini|cursor-agent|agent|node)(\\.exe)?$" } | ForEach-Object { if ($_.CommandLine) { $_.CommandLine } else { $_.Name } }'],
        { encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 })
      : await execFileAsync('ps', ['-ax', '-o', 'args='], { encoding: 'utf8', timeout: 3000, maxBuffer: 2 * 1024 * 1024 })
    return matchAgentProcesses(stdout)
  } catch {
    return new Set()
  }
}

export function matchAgentProcesses(output: string): Set<AgentKind> {
  const found = new Set<AgentKind>()
  const executables: Record<string, AgentKind> = { claude: 'claude', codex: 'codex', gemini: 'gemini', 'cursor-agent': 'cursor', agent: 'cursor' }
  for (const line of output.split(/\r?\n/)) {
    const tokens = line.trim().match(/"[^"]*"|'[^']*'|[^\s,]+/g) ?? []
    const command = (tokens[0] ?? '').replace(/^["']|["']$/g, '')
    const executable = command.split(/[\\/]/).pop()?.replace(/\.exe$/i, '').toLowerCase() ?? ''
    if (executables[executable]) found.add(executables[executable])
    if (executable !== 'node' && executable !== 'nodejs' && executable !== 'bun') continue
    // Inspect only the script argument, never task text that happens to mention an agent.
    const script = tokens.slice(1).find((token) => !token.startsWith('-'))?.replace(/^["']|["']$/g, '').replace(/\\/g, '/') ?? ''
    if (/\/@anthropic-ai\/claude-code\//i.test(script)) found.add('claude')
    if (/\/@openai\/codex\//i.test(script)) found.add('codex')
    if (/\/@google\/gemini-cli\//i.test(script)) found.add('gemini')
    if (/\/cursor-agent\//i.test(script)) found.add('cursor')
  }
  return found
}
