import type { ActivityOperation, ActivityState, ActivityStep, ActivityTask, TaskKind, TaskStatus } from '../shared/activity'

/** Built-in plugin ids. Third-party plugins may use any other lowercase id. */
export type AgentKind = 'claude' | 'codex' | 'gemini' | 'cursor'

export interface SessionView {
  id: string
  agent: string
  kind: string
  state: ActivityState
  title: string
  detail?: string
  operation?: ActivityOperation
  steps: ActivityStep[]
  /** Sub-agents and background commands, including ones that outlive the turn. */
  tasks: ActivityTask[]
  /** The transcript itself says this turn finished. */
  terminal: boolean
}

export type ToolEvent = Extract<AgentEvent, { kind: 'tool' | 'approval' }>

/** A normalized transcript event. Plugins translate their native rows into these. */
export type AgentEvent =
  | { kind: 'user'; title: string }
  | { kind: 'thinking' | 'text'; title: string }
  | { kind: 'tool' | 'approval'; title: string; callId?: string; operation?: ActivityOperation; reason?: string }
  | { kind: 'tool_result'; title: string; ok: boolean; callId?: string }
  | { kind: 'done' | 'error'; title: string }
  | { kind: 'task_start'; taskId: string; task: TaskKind; label: string; detail?: string }
  | { kind: 'task_update'; taskId: string; detail: string }
  /** `taskId: '*'` settles every open sub-agent, e.g. "all background agents were stopped". */
  | { kind: 'task_end'; taskId: string; status: Exclude<TaskStatus, 'active'>; detail?: string }
  /** Forget a task whose outcome the transcript will never record. */
  | { kind: 'task_drop'; taskId: string }

export interface ParsedTranscript {
  events: AgentEvent[]
  /** A session id recorded inside the transcript, preferred over the file name. */
  sessionId?: string
}

/** Where a sub-agent transcript belongs in its parent's view. */
export interface ChildLink {
  /** Native session id of the parent transcript. */
  parentSessionId: string
  /** Task id inside the parent; matches the parent's task_start event when one exists. */
  taskId: string
  label: string
}

export interface AgentPlugin {
  /** Stable lowercase id; also the activity id prefix. */
  readonly kind: string
  readonly label: string
  /** Transcript root, honoring the agent's own environment overrides. */
  defaultRoot(home: string, env: NodeJS.ProcessEnv): string
  /** Directory names never descended into while discovering transcripts. */
  readonly skipDirs?: readonly string[]
  accepts(file: string): boolean
  sessionIdFrom(file: string): string
  /** Read whole files with these extensions instead of tailing them. */
  readonly wholeFile?: (file: string) => boolean
  parse(text: string): ParsedTranscript
  /** Independent parser for consecutive batches of complete JSONL rows. */
  createParser?(): (text: string) => ParsedTranscript
  /** Executable basenames (without .exe) that identify a running agent. */
  readonly executables: readonly string[]
  /** Script paths that identify the agent when it runs under node or bun. */
  readonly scripts?: readonly RegExp[]
  /**
   * Resolve a sub-agent transcript to its parent. Returns null for top-level
   * sessions, undefined while metadata is incomplete. May read sidecars or the transcript head.
   */
  child?(file: string): Promise<ChildLink | null | undefined>
  /** Native session ids an agent has registered as busy, independent of mtime. */
  liveSessions?(root: string): Promise<Set<string>>
}
