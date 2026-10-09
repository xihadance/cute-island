import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ActivityStore } from '../shared/activity'
import { parseTranscript, type AgentKind, type SessionView } from './parse'

const FRESH_MS = 8_000
const RUNNING_GRACE_MS = 20_000
const LOOKBACK_MS = 120_000
const TAIL_BYTES = 256_000

export interface AgentRoots {
  claude: string
  codex: string
  gemini: string
  cursor: string
}

export interface WatchOptions {
  roots?: AgentRoots
  now?: () => number
  listProcesses?: () => Set<AgentKind>
  intervalMs?: number
  freshMs?: number
}

interface TrackedSession {
  signature: string
  id: string
}

export function defaultAgentRoots(home = homedir(), env: NodeJS.ProcessEnv = process.env): AgentRoots {
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
  const codexHome = env.CODEX_HOME || path.join(home, '.codex')
  const geminiHome = env.GEMINI_CLI_HOME || path.join(home, '.gemini')
  const cursorHome = env.CURSOR_HOME || path.join(home, '.cursor')
  return {
    claude: path.join(claudeHome, 'projects'),
    codex: path.join(codexHome, 'sessions'),
    gemini: path.join(geminiHome, 'tmp'),
    cursor: path.join(cursorHome, 'projects')
  }
}

export class SessionWatcher {
  private readonly roots: AgentRoots
  private readonly now: () => number
  private readonly listProcesses: () => Set<AgentKind>
  private readonly intervalMs: number
  private readonly freshMs: number
  private readonly tracked = new Map<string, TrackedSession>()
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly store: ActivityStore,
    options: WatchOptions = {}
  ) {
    this.roots = options.roots ?? defaultAgentRoots()
    this.now = options.now ?? (() => Date.now())
    this.listProcesses = options.listProcesses ?? listAgentProcesses
    this.intervalMs = options.intervalMs ?? 800
    this.freshMs = options.freshMs ?? FRESH_MS
  }

  start(): void {
    if (this.timer) return
    this.scan()
    this.timer = setInterval(() => this.scan(), this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  scan(): void {
    const now = this.now()
    const running = this.listProcesses()
    const seen = new Set<string>()
    for (const file of this.sessionFiles(now)) {
      const kind = file.kind
      let text = ''
      try {
        text = readTail(file.path)
      } catch {
        continue
      }
      const parsed = parseTranscript(kind, file.sessionId, text)
      if (!parsed) continue
      const age = now - file.mtimeMs
      const live = age <= this.freshMs || (running.has(kind) && age <= RUNNING_GRACE_MS)
      const view = presentSession(parsed, live, age)
      if (!view) continue
      const known = this.tracked.has(file.path)
      if ((view.state === 'success' || view.state === 'error') && age > this.freshMs && !known) continue
      seen.add(file.path)
      this.publish(file.path, view)
    }
    for (const [file, tracked] of this.tracked) {
      if (seen.has(file)) continue
      this.tracked.delete(file)
      this.store.dismiss(tracked.id)
    }
  }

  private publish(file: string, view: SessionView): void {
    const signature = JSON.stringify([view.state, view.title, view.detail ?? '', view.steps])
    const previous = this.tracked.get(file)
    this.tracked.set(file, { signature, id: view.id })
    if (previous?.signature === signature) return
    this.store.upsert({
      id: view.id,
      agent: view.agent,
      state: view.state,
      title: view.title,
      detail: view.detail ?? null,
      steps: view.steps
    })
  }

  private sessionFiles(now: number): SessionFile[] {
    const found: SessionFile[] = []
    collect(this.roots.claude, 'claude', 3, now, found, (file) => file.endsWith('.jsonl') && !file.includes(`${path.sep}subagents${path.sep}`))
    collect(this.roots.codex, 'codex', 5, now, found, (file) => path.basename(file).startsWith('rollout-') && file.endsWith('.jsonl'))
    collect(this.roots.gemini, 'gemini', 6, now, found, (file) => {
      const base = path.basename(file)
      return base.startsWith('session-') && (base.endsWith('.jsonl') || base.endsWith('.json'))
    })
    collect(this.roots.cursor, 'cursor', 6, now, found, (file) => {
      return file.includes(`${path.sep}agent-transcripts${path.sep}`) && file.endsWith('.jsonl') && !file.includes(`${path.sep}subagents${path.sep}`)
    })
    return found.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, 24)
  }
}

interface SessionFile {
  kind: AgentKind
  path: string
  sessionId: string
  mtimeMs: number
}

function collect(
  root: string,
  kind: AgentKind,
  maxDepth: number,
  now: number,
  into: SessionFile[],
  accept: (file: string) => boolean
): void {
  if (!existsSync(root)) return
  walk(root, 0)
  function walk(dir: string, depth: number): void {
    let entries: Dirent<string>[] = []
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1)
        continue
      }
      if (!entry.isFile() || !accept(full)) continue
      let mtimeMs = 0
      try {
        mtimeMs = statSync(full).mtimeMs
      } catch {
        continue
      }
      if (now - mtimeMs > LOOKBACK_MS) continue
      into.push({ kind, path: full, sessionId: sessionIdFrom(kind, full), mtimeMs })
    }
  }
}

function sessionIdFrom(kind: AgentKind, file: string): string {
  const base = path.basename(file).replace(/\.jsonl?$/, '')
  if (kind === 'cursor') return path.basename(path.dirname(file))
  if (kind === 'codex') {
    const match = base.match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/i)
    return match?.[1] ?? base
  }
  if (kind === 'gemini') return base.replace(/^session-/, '')
  return base
}

function presentSession(view: SessionView, live: boolean, age: number): SessionView | null {
  if (view.terminal) return view
  if (live) return view
  if (view.state === 'running' && age <= 60_000) return view
  if (view.state === 'running') {
    return { ...view, state: 'error', title: '会话已中断', terminal: true }
  }
  if (view.state === 'thinking') {
    return { ...view, state: 'success', title: view.title || '已完成', terminal: true }
  }
  return null
}

function readTail(file: string, maxBytes = TAIL_BYTES): string {
  const size = statSync(file).size
  const length = Math.min(size, maxBytes)
  const start = size - length
  const buffer = Buffer.alloc(length)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, buffer, 0, length, start)
  } finally {
    closeSync(fd)
  }
  const text = buffer.toString('utf8')
  if (start === 0) return text
  const newline = text.indexOf('\n')
  return newline === -1 ? '' : text.slice(newline + 1)
}

const PROCESS_KIND: Array<[RegExp, AgentKind]> = [
  [/(^|[\\/])claude(\.exe)?$/i, 'claude'],
  [/(^|[\\/])codex(\.exe)?$/i, 'codex'],
  [/(^|[\\/])gemini(\.exe)?$/i, 'gemini'],
  [/(^|[\\/])cursor-agent(\.exe)?$/i, 'cursor'],
  [/(^|[\\/])agent(\.exe)?$/i, 'cursor']
]

export function listAgentProcesses(): Set<AgentKind> {
  try {
    const output =
      process.platform === 'win32'
        ? execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 1500, windowsHide: true })
        : execFileSync('ps', ['-ax', '-o', 'comm='], { encoding: 'utf8', timeout: 1500 })
    return matchAgentProcesses(output)
  } catch {
    return new Set()
  }
}

export function matchAgentProcesses(output: string): Set<AgentKind> {
  const found = new Set<AgentKind>()
  for (const line of output.split(/\r?\n/)) {
    const command = line.trim().replace(/^"|"$/g, '').split(',')[0]?.replace(/^"|"$/g, '') ?? ''
    for (const [pattern, kind] of PROCESS_KIND) {
      if (pattern.test(command)) found.add(kind)
    }
  }
  return found
}
