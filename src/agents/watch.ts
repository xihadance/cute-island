import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { ActivityStore } from '../shared/activity'
import { collect, mapLimited, readSession, SessionReader, type SessionFile } from './files'
import { activityId } from './parse'
import { BUILTIN_PLUGINS } from './plugins'
import { clientForProcess, listProcessSnapshot, matchAgentProcesses, type ProcessSnapshot } from './processes'
import { dropActiveTasks, mergeChildTasks, presentTasks, type ChildSession } from './reduce'
import type { AgentPlugin, ChildLink, SessionView } from './types'

export { readSession } from './files'
export { listAgentProcesses, matchAgentProcesses } from './processes'

const FRESH_MS = 8_000
const LOOKBACK_MS = 120_000
const RECOVERY_MS = 24 * 60 * 60_000
/** Background work with no sign of life for this long is assumed gone. */
const BACKGROUND_MS = 30 * 60_000
const FILES_PER_AGENT = 64

/** Transcript root per plugin kind. Kinds without a root are not watched. */
export type AgentRoots = Record<string, string>

export interface WatchOptions {
  roots?: AgentRoots
  plugins?: readonly AgentPlugin[]
  now?: () => number
  listProcesses?: () => Set<string> | Promise<Set<string>>
  listProcessSnapshot?: () => ProcessSnapshot | Promise<ProcessSnapshot>
  intervalMs?: number
  freshMs?: number
  discoveryMs?: number
  processMs?: number
  backgroundMs?: number
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
  /** When the stamp last changed. Windows may not bump mtime while a writer holds the file. */
  changedAt: number
  client?: string
}

interface LoadedFile {
  file: SessionFile
  view: SessionView
  age: number
}

export function defaultAgentRoots(home = homedir(), env: NodeJS.ProcessEnv = process.env, plugins: readonly AgentPlugin[] = BUILTIN_PLUGINS): AgentRoots {
  return Object.fromEntries(plugins.map((plugin) => [plugin.kind, plugin.defaultRoot(home, env)]))
}

export class SessionWatcher {
  private readonly sources: Array<{ plugin: AgentPlugin; root: string }>
  private readonly now: () => number
  private readonly listProcesses: WatchOptions['listProcesses']
  private readonly listSnapshot: WatchOptions['listProcessSnapshot']
  private readonly intervalMs: number
  private readonly freshMs: number
  private readonly discoveryMs: number
  private readonly processMs: number
  private readonly backgroundMs: number
  private readonly readSession: typeof readSession
  private readonly tracked = new Map<string, TrackedSession>()
  private readonly cache = new Map<string, CachedSession>()
  /** Resolved parent links; `null` marks a top-level transcript. */
  private readonly links = new Map<string, { stamp: string; link: ChildLink | null }>()
  private readonly reader = new SessionReader()
  private files: SessionFile[] = []
  private running = new Set<string>()
  private liveIds = new Map<string, Set<string>>()
  private sessionClients = new Map<string, Map<string, string | null>>()
  private lastDiscovery = -Infinity
  private lastProcesses = -Infinity
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<void> | undefined
  private started = false
  private generation = 0

  constructor(private readonly store: ActivityStore, options: WatchOptions = {}) {
    const plugins = options.plugins ?? BUILTIN_PLUGINS
    const roots = options.roots ?? defaultAgentRoots(homedir(), process.env, plugins)
    this.sources = plugins.filter((plugin) => roots[plugin.kind]).map((plugin) => ({ plugin, root: roots[plugin.kind] }))
    this.now = options.now ?? Date.now
    this.listProcesses = options.listProcesses
    this.listSnapshot = options.listProcessSnapshot ?? (options.listProcesses ? undefined : () => listProcessSnapshot(plugins))
    this.intervalMs = options.intervalMs ?? 800
    this.freshMs = options.freshMs ?? FRESH_MS
    this.discoveryMs = options.discoveryMs ?? 10_000
    this.processMs = options.processMs ?? 5_000
    this.backgroundMs = options.backgroundMs ?? BACKGROUND_MS
    this.readSession = options.readSession ?? this.reader.read.bind(this.reader)
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
    this.reader.clear()
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
      let processes: ProcessSnapshot['processes'] = []
      try {
        if (this.listSnapshot) {
          const snapshot = await this.listSnapshot()
          this.running = snapshot.running
          processes = snapshot.processes
        } else if (this.listProcesses) this.running = await this.listProcesses()
      } catch {
        // A transient process-query failure is not evidence that an agent exited.
      }
      const registrations = await Promise.all(this.sources.map(async ({ plugin, root }) => {
        const clients = new Map<string, string | null>()
        if (!plugin.registeredSessions) return { kind: plugin.kind, clients, live: plugin.liveSessions ? await plugin.liveSessions(root) : new Set<string>() }
        const sessions = await plugin.registeredSessions(root)
        for (const session of sessions) {
          const process = processes.find((row) => row.pid === session.pid)
          if (!process || (process.createdAt !== undefined && process.createdAt > session.updatedAt)) continue
          if (!matchAgentProcesses(process.commandLine || process.name, [plugin]).has(plugin.kind)) continue
          const client = clientForProcess(session.pid, processes) ?? null
          clients.set(session.sessionId, clients.has(session.sessionId) && clients.get(session.sessionId) !== client ? null : client)
        }
        return { kind: plugin.kind, clients, live: new Set(sessions.filter((session) => session.busy).map((session) => session.sessionId)) }
      }))
      this.liveIds = new Map(registrations.map(({ kind, live }) => [kind, live]))
      this.sessionClients = new Map(registrations.map(({ kind, clients }) => [kind, clients]))
    }
    if (generation !== this.generation) return
    if (now - this.lastDiscovery >= this.discoveryMs) {
      this.files = await this.sessionFiles(now)
      this.reader.retain(new Set(this.files.map((file) => file.path)))
      this.lastDiscovery = now
    }
    const seen = new Set<string>()
    const loaded: LoadedFile[] = []
    await mapLimited(this.files, 8, async (file) => {
      try {
        const info = await stat(file.path)
        const stamp = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`
        const previous = this.cache.get(file.path)
        const view = previous?.stamp === stamp
          ? previous.view
          : await this.readSession(file.plugin.kind, file.sessionId, file.path, info.size, file.plugin)
        if (generation !== this.generation) return
        // Incomplete appends and atomic JSON rewrites must not clear a live session.
        const parsed = view ?? previous?.view ?? null
        const changedAt = !previous ? info.mtimeMs : previous.stamp === stamp ? previous.changedAt : now
        const registered = this.sessionClients.get(file.plugin.kind)?.get(parsed?.sessionId ?? file.sessionId)
        // Retain the last observed host after exit, but let a new binding replace it.
        const remembered = previous?.view?.sessionId === parsed?.sessionId && previous?.client !== previous?.view?.client ? previous?.client : undefined
        const client = registered === null ? parsed?.client : registered ?? remembered ?? parsed?.client
        this.cache.set(file.path, { stamp, view: parsed, changedAt, client })
        seen.add(file.path)
        if (parsed) loaded.push({ file, view: { ...parsed, client }, age: Math.max(0, now - Math.max(info.mtimeMs, changedAt)) })
      } catch {
        // Logs may be rotated, locked or deleted while an agent writes them.
      }
    })
    if (generation !== this.generation) return
    this.present(loaded)
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

  /** Fold sub-agent transcripts into their parents, then publish top-level sessions. */
  private present(loaded: readonly LoadedFile[]): void {
    const children = new Map<string, LoadedFile[]>()
    for (const item of loaded) {
      const { file } = item
      if (!file.link) continue
      const parent = activityId(file.plugin.kind, file.link.parentSessionId)
      const list = children.get(parent) ?? []
      list.push(item)
      children.set(parent, list)
    }
    const folded = new Map<string, { view: SessionView; age: number; live: boolean }>()
    const visiting = new Set<string>()
    const fold = ({ file, view, age }: LoadedFile): { view: SessionView; age: number; live: boolean } => {
      const cached = folded.get(view.id)
      if (cached) return cached
      // Corrupt/cyclic parent links must not stall every other session.
      if (visiting.has(view.id)) return { view: presentTasks(view), age, live: this.isLive(file, age) }
      visiting.add(view.id)
      const linked: Array<ChildSession & { age: number }> = (children.get(view.id) ?? []).map((child) => ({
        ...fold(child), link: child.file.link!
      }))
      const busy = linked.filter((child) => child.live && !child.view.terminal)
      // Propagate a descendant's activity and native busy registration all the way to the root.
      const effectiveAge = Math.min(age, ...busy.map((child) => child.age))
      let merged = mergeChildTasks(view, linked)
      const registered = this.hasLiveRegistration(file)
      if (effectiveAge > this.backgroundMs && !registered) merged = dropActiveTasks(merged, new Set(busy.map((child) => child.link.taskId)))
      const live = this.isLive(file, effectiveAge) || busy.length > 0
      const result = { view: presentTasks(merged), age: effectiveAge, live }
      folded.set(view.id, result)
      visiting.delete(view.id)
      return result
    }
    for (const item of loaded) {
      const { file } = item
      if (file.link) continue
      const result = fold(item)
      const known = this.tracked.has(file.path)
      const presented = presentSession(result.view, result.live || this.running.has(file.plugin.kind), result.age, known)
      if (!presented) continue
      if (presented.terminal && result.age > this.freshMs && !known) continue
      this.publish(file.path, presented)
    }
  }

  private isLive(file: SessionFile, age: number): boolean {
    return age <= this.freshMs || (age <= this.backgroundMs && this.running.has(file.plugin.kind)) || this.hasLiveRegistration(file)
  }

  private publish(file: string, view: SessionView): void {
    const signature = JSON.stringify([view.state, view.title, view.detail ?? '', view.operation, view.steps, view.tasks, view.client])
    const previous = this.tracked.get(file)
    this.tracked.set(file, { signature, id: view.id })
    if (previous?.signature === signature) return
    this.store.upsert({
      id: view.id, agent: view.agent, state: view.state, title: view.title,
      client: view.client ?? null,
      detail: view.detail ?? null, operation: view.operation ?? null, steps: view.steps,
      tasks: view.tasks.length ? view.tasks : null
    })
  }

  private async sessionFiles(now: number): Promise<SessionFile[]> {
    const retained = new Set<string>()
    for (const [file, tracked] of this.tracked) {
      if (this.store.get(tracked.id)) retained.add(file)
    }
    const present = new Set<string>()
    const pinned = (file: SessionFile): boolean => retained.has(file.path) || this.hasLiveRegistration(file)
    const groups = await Promise.all(this.sources.map(async ({ plugin, root }) => {
      const window = this.running.has(plugin.kind) ? RECOVERY_MS : LOOKBACK_MS
      const all = await collect(root, plugin)
      const bySession = new Map(all.map((file) => [file.sessionId, file]))
      const found = all
        .filter((file) => pinned(file) || now - file.mtimeMs <= window)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
      // Only the newest files need their parent resolved; the rest are cut below anyway.
      let shortlist = found.filter((file, index) => index < FILES_PER_AGENT * 2 || pinned(file))
      const resolved: SessionFile[] = []
      const attempted = new Set<string>()
      // Include ancestors even if only a descendant has written recently.
      while (shortlist.length) {
        const next = new Map<string, SessionFile>()
        for (const file of shortlist) attempted.add(file.path)
        await mapLimited(shortlist, 8, async (file) => {
          present.add(file.path)
          const link = await this.linkFor(plugin, file)
          if (link === undefined) return
          resolved.push(link ? { ...file, link } : file)
          const parent = link ? bySession.get(link.parentSessionId) : undefined
          if (parent && !attempted.has(parent.path)) next.set(parent.path, parent)
        })
        shortlist = [...next.values()]
      }
      resolved.sort((a, b) => b.mtimeMs - a.mtimeMs)
      const top = resolved.filter((file) => !file.link).filter((file, index) => index < FILES_PER_AGENT || pinned(file))
      const parents = new Set(top.map((file) => file.sessionId))
      const kids: SessionFile[] = []
      let added = true
      while (added && kids.length < FILES_PER_AGENT) {
        added = false
        for (const file of resolved) {
          if (!file.link || parents.has(file.sessionId) || !parents.has(file.link.parentSessionId)) continue
          kids.push(file)
          parents.add(file.sessionId)
          added = true
          if (kids.length >= FILES_PER_AGENT) break
        }
      }
      return [...top, ...kids]
    }))
    for (const file of this.links.keys()) if (!present.has(file)) this.links.delete(file)
    return groups.flat()
  }

  /** `undefined` means the link could not be resolved yet; skip the file this round. */
  private async linkFor(plugin: AgentPlugin, file: SessionFile): Promise<ChildLink | null | undefined> {
    if (!plugin.child) return null
    const cached = this.links.get(file.path)
    if (cached?.stamp === file.stamp) return cached.link
    try {
      const link = await plugin.child(file.path)
      if (link !== undefined) this.links.set(file.path, { stamp: file.stamp, link })
      return link
    } catch {
      return undefined
    }
  }

  private hasLiveRegistration(file: SessionFile): boolean {
    const ids = this.liveIds.get(file.plugin.kind)
    if (!ids?.size) return false
    return ids.has(file.sessionId) || ids.has(file.sessionId.slice(0, 8))
  }
}

function presentSession(view: SessionView, live: boolean, age: number, known: boolean): SessionView | null {
  if (view.terminal || live) return view
  if (!known) return null
  if (age <= 60_000) return view
  return {
    ...view,
    state: 'error',
    title: '会话已中断',
    terminal: true,
    tasks: view.tasks.map((task) => (task.status === 'active' ? { ...task, status: 'stopped' as const } : task))
  }
}
