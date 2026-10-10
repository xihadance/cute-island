import { open, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { activityId, parseSession } from './parse'
import { pluginFor } from './plugins'
import { createReducer } from './reduce'
import type { AgentPlugin, ChildLink, SessionView } from './types'

const CHUNK_BYTES = 64 * 1024
const CHECK_BYTES = 512
const MAX_JSON_BYTES = 16 * 1024 * 1024
const DEFAULT_SKIP = ['node_modules', '.git', 'subagents']

export interface SessionFile {
  plugin: AgentPlugin
  path: string
  sessionId: string
  mtimeMs: number
  stamp: string
  /** Present for sub-agent transcripts, which render inside their parent. */
  link?: ChildLink
}

/** Walk a plugin's root for transcripts it accepts. */
export async function collect(root: string, plugin: AgentPlugin): Promise<SessionFile[]> {
  const skip = plugin.skipDirs ?? DEFAULT_SKIP
  const found: SessionFile[] = []
  const dirs: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  while (dirs.length) {
    const batch = dirs.splice(0, 8)
    await Promise.all(batch.map(async ({ dir, depth }) => {
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        const files: string[] = []
        for (const entry of entries) {
          if (skip.includes(entry.name)) continue
          const full = path.join(dir, entry.name)
          if (entry.isDirectory() && depth < 6) dirs.push({ dir: full, depth: depth + 1 })
          else if (entry.isFile() && plugin.accepts(full)) files.push(full)
        }
        await mapLimited(files, 4, async (file) => {
          try {
            const info = await stat(file)
            found.push({ plugin, path: file, sessionId: plugin.sessionIdFrom(file), mtimeMs: info.mtimeMs,
              stamp: `${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.ino}` })
          } catch { /* File disappeared during discovery. */ }
        })
      } catch { /* An agent may not be installed, or a directory may be inaccessible. */ }
    }))
  }
  return found
}

/** A one-off read; watchers reuse SessionReader to consume only appended bytes. */
export async function readSession(kind: string, sessionId: string, file: string, size: number, plugin = pluginFor(kind)): Promise<SessionView | null> {
  return new SessionReader().read(kind, sessionId, file, size, plugin)
}

interface ReaderState {
  plugin: AgentPlugin
  sessionId: string
  identity: string
  stamp: string
  offset: number
  prefix: Buffer
  boundary: Buffer
  pending: string
  decoder: StringDecoder
  parse: ReturnType<NonNullable<AgentPlugin['createParser']>>
  reducer: ReturnType<typeof createReducer>
  seen: boolean
  nativeId?: string
  client?: string
  continuedInSessionId?: string
}

export class SessionReader {
  private readonly states = new Map<string, ReaderState>()

  retain(files: ReadonlySet<string>): void {
    for (const file of this.states.keys()) if (!files.has(file)) this.states.delete(file)
  }

  clear(): void { this.states.clear() }

  async read(kind: string, sessionId: string, file: string, size: number, plugin = pluginFor(kind)): Promise<SessionView | null> {
    if (!plugin) return null
    const whole = plugin.wholeFile?.(file) || !plugin.createParser
    if (whole && size > MAX_JSON_BYTES) return null
    const fd = await open(file, 'r')
    const range = async (start: number, length: number): Promise<Buffer> => {
      const buffer = Buffer.alloc(length)
      let read = 0
      while (read < length) {
        const { bytesRead } = await fd.read(buffer, read, length - read, start + read)
        if (!bytesRead) break
        read += bytesRead
      }
      return buffer.subarray(0, read)
    }
    try {
      const info = await fd.stat()
      const end = Math.min(size, info.size)
      if (whole) return parseSession(plugin, sessionId, (await range(0, end)).toString('utf8'))
      const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`
      const stamp = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`
      let state = this.states.get(file)
      if (state && state.plugin === plugin && state.sessionId === sessionId && state.identity === identity && state.stamp === stamp && state.offset === end) {
        return this.view(state)
      }
      let append = !!state && state.plugin === plugin && state.sessionId === sessionId && state.identity === identity && end > state.offset
      if (append && state) {
        // Detect replacement or truncation/regrowth before trusting retained parser state.
        append = (await range(0, state.prefix.length)).equals(state.prefix) &&
          (await range(state.offset - state.boundary.length, state.boundary.length)).equals(state.boundary)
      }
      if (!append || !state) {
        state = { plugin, sessionId, identity, stamp, offset: 0, prefix: Buffer.alloc(0), boundary: Buffer.alloc(0),
          pending: '', decoder: new StringDecoder('utf8'), parse: plugin.createParser!(), reducer: createReducer(), seen: false }
        this.states.set(file, state)
      }
      const consume = (text: string): void => {
        const parsed = state.parse(text)
        if (parsed.sessionId) state.nativeId = parsed.sessionId
        if (parsed.client) state.client = parsed.client
        if (parsed.continuedInSessionId) state.continuedInSessionId = parsed.continuedInSessionId
        if (parsed.events.length) { state.seen = true; state.reducer.push(parsed.events) }
      }
      while (state.offset < end) {
        const chunk = await range(state.offset, Math.min(CHUNK_BYTES, end - state.offset))
        if (!chunk.length) break
        state.offset += chunk.length
        const text = state.decoder.write(chunk)
        const newline = text.lastIndexOf('\n')
        if (newline >= 0) {
          consume(state.pending + text.slice(0, newline + 1))
          state.pending = text.slice(newline + 1)
        } else state.pending += text
      }
      // Accept a complete last record without a newline; retain torn JSON/UTF-8 for the next append.
      if (state.pending.trim()) {
        let complete = false
        try { JSON.parse(state.pending); complete = true } catch { /* Still being written. */ }
        if (complete) { consume(state.pending); state.pending = '' }
      }
      state.stamp = stamp
      state.prefix = await range(0, Math.min(CHECK_BYTES, state.offset))
      state.boundary = await range(Math.max(0, state.offset - CHECK_BYTES), Math.min(CHECK_BYTES, state.offset))
      return this.view(state)
    } catch (error) {
      this.states.delete(file)
      throw error
    } finally { await fd.close() }
  }

  private view(state: ReaderState): SessionView | null {
    return state.seen ? { id: activityId(state.plugin.kind, state.nativeId || state.sessionId), agent: state.plugin.label,
      kind: state.plugin.kind, sessionId: state.nativeId || state.sessionId, client: state.client,
      continuedInSessionId: state.continuedInSessionId, ...state.reducer.snapshot() } : null
  }
}

export async function mapLimited<T>(items: T[], limit: number, visit: (item: T) => Promise<void>): Promise<void> {
  let index = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) await visit(items[index++])
  }))
}
