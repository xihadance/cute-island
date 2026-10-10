export const SUCCESS_DWELL_MS = 2800

export type ActivityState = 'thinking' | 'running' | 'waiting' | 'approval' | 'success' | 'error'
export type StepStatus = 'pending' | 'active' | 'waiting' | 'done' | 'error'
export const OPERATION_KINDS = ['command', 'read', 'edit', 'search', 'mcp', 'skill', 'agent', 'tool'] as const
export type OperationKind = typeof OPERATION_KINDS[number]

export interface ActivityOperation {
  kind: OperationKind
  name?: string
  command?: string
  shell?: string
  cwd?: string
}

export const OPERATION_LABEL: Record<OperationKind, string> = {
  command: '命令', read: '读取文件', edit: '修改文件', search: '搜索',
  mcp: 'MCP 调用', skill: 'Skill', agent: '子 Agent', tool: '工具'
}

export interface ActivityStep {
  id: string
  label: string
  status: StepStatus
  kind?: OperationKind
}

/** Work that outlives a single tool call: sub-agents and background commands. */
export type TaskKind = 'agent' | 'command'
export type TaskStatus = 'active' | 'done' | 'error' | 'stopped'
export const TASK_STATUSES: readonly TaskStatus[] = ['active', 'done', 'error', 'stopped']

export interface ActivityTask {
  id: string
  kind: TaskKind
  label: string
  status: TaskStatus
  detail?: string
}

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  active: '进行中', done: '已完成', error: '失败', stopped: '已停止'
}

export interface Activity {
  id: string
  agent: string
  /** Host client, separate from the agent and the tool's shell. */
  client?: string
  state: ActivityState
  title: string
  detail?: string
  operation?: ActivityOperation
  progress?: number
  steps: ActivityStep[]
  tasks?: ActivityTask[]
  startedAt: number
  updatedAt: number
  endedAt?: number
}

export interface ActivityInput {
  id: string
  agent?: string
  client?: string | null
  state?: ActivityState
  title?: string
  detail?: string | null
  operation?: ActivityOperation | null
  progress?: number | null
  steps?: ActivityStep[]
  tasks?: ActivityTask[] | null
  /** Unix milliseconds for the latest execution round. Omit to time local updates. */
  startedAt?: number
  endedAt?: number
}

export interface EndInput {
  result: 'success' | 'error'
  summary?: string
}

export const ACTIVITY_STATES: readonly ActivityState[] = [
  'thinking',
  'running',
  'waiting',
  'approval',
  'success',
  'error'
]

export const STATE_LABEL: Record<ActivityState, string> = {
  thinking: '思考中',
  running: '执行中',
  waiting: '等待中',
  approval: '需要审批',
  success: '已完成',
  error: '失败'
}

const PRIORITY: Record<ActivityState, number> = {
  error: 50,
  approval: 45,
  running: 40,
  thinking: 30,
  waiting: 20,
  success: 10
}

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/
const STEP_ID_PATTERN = /^[A-Za-z0-9._:-]{1,40}$/
const STEP_STATUSES: readonly StepStatus[] = ['pending', 'active', 'waiting', 'done', 'error']

export class ActivityError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'ActivityError'
  }
}

export interface Scheduler {
  (fn: () => void, ms: number): { cancel: () => void }
}

export const defaultScheduler: Scheduler = (fn, ms) => {
  const timer = setTimeout(fn, ms)
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    timer.unref()
  }
  return { cancel: () => clearTimeout(timer) }
}

export function priorityRank(state: ActivityState): number {
  return PRIORITY[state]
}

export function defaultTitle(state: ActivityState): string {
  return STATE_LABEL[state]
}

export function sortActivities(activities: readonly Activity[]): Activity[] {
  return [...activities].sort((left, right) => {
    const byRank = priorityRank(right.state) - priorityRank(left.state)
    if (byRank !== 0) return byRank
    return right.updatedAt - left.updatedAt
  })
}

export function pickPrimary(activities: readonly Activity[]): Activity | undefined {
  return sortActivities(activities)[0]
}

export function expandedHeight(activity: Activity, otherCount: number): number {
  let height = 112
  if (activity.detail) height += 20
  if (activity.operation) height += operationHeight(activity.operation)
  if (activity.state === 'approval') height += 70
  if (typeof activity.progress === 'number') height += 22
  height += Math.min(activity.steps.length, 4) * 22
  height += tasksHeight(activity.tasks)
  if (otherCount > 0) height += 22 + Math.min(otherCount, 3) * 22
  return Math.min(Math.max(height, 150), 480)
}

export const MAX_VISIBLE_TASKS = 4

export function tasksHeight(tasks: readonly ActivityTask[] | undefined): number {
  if (!tasks?.length) return 0
  return 26 + Math.min(tasks.length, MAX_VISIBLE_TASKS) * 24
}

export function operationHeight(operation: ActivityOperation): number {
  if (!operation.command) return 44
  return operation.command.length > 40 || /[\r\n]/.test(operation.command) ? 168 : 108
}

interface ParsedActivity {
  id: string
  agent?: string
  client?: string | null
  state?: ActivityState
  title?: string
  clearDetail: boolean
  detail?: string
  operation?: ActivityOperation | null
  clearProgress: boolean
  progress?: number
  steps?: ActivityStep[]
  tasks?: ActivityTask[] | null
  startedAt?: number
  endedAt?: number
}

export class ActivityStore {
  private readonly activities = new Map<string, Activity>()
  private readonly listeners = new Set<(activities: Activity[]) => void>()
  private readonly dismissTimers = new Map<string, { cancel: () => void }>()
  private readonly dismissGeneration = new Map<string, number>()
  private nextGeneration = 0

  constructor(
    private readonly schedule: Scheduler = defaultScheduler,
    private readonly now: () => number = () => Date.now()
  ) {}

  list(): Activity[] {
    return sortActivities([...this.activities.values()].map(cloneActivity))
  }

  get(id: string): Activity | undefined {
    const activity = this.activities.get(id)
    return activity ? cloneActivity(activity) : undefined
  }

  subscribe(listener: (activities: Activity[]) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  upsert(input: unknown): Activity {
    const parsed = parseActivityInput(input)
    const current = this.activities.get(parsed.id)
    const now = this.now()
    const state = parsed.state ?? current?.state ?? 'running'
    const newRound = parsed.startedAt !== undefined && parsed.startedAt !== current?.startedAt
    const restarting = newRound || (current?.endedAt !== undefined && state !== 'success' && state !== 'error')
    const next: Activity = {
      id: parsed.id,
      agent: parsed.agent ?? current?.agent ?? 'Agent',
      client: parsed.client === null ? undefined : parsed.client ?? current?.client,
      state,
      title: parsed.title ?? current?.title ?? defaultTitle(state),
      detail: resolveDetail(parsed, current),
      operation: parsed.operation === null ? undefined : parsed.operation ?? (restarting ? undefined : current?.operation),
      progress: resolveProgress(parsed, restarting ? undefined : current),
      steps: parsed.steps ?? (restarting ? [] : current?.steps.map((step) => ({ ...step }))) ?? [],
      ...resolveTasks(parsed, current),
      startedAt: parsed.startedAt ?? (restarting ? now : current?.startedAt ?? now),
      updatedAt: now
    }
    const terminal = state === 'success' || state === 'error'
    if (terminal) {
      next.endedAt = parsed.endedAt ?? (!newRound && current?.state === state && current.endedAt !== undefined ? current.endedAt : now)
      next.endedAt = Math.max(next.startedAt, next.endedAt)
    }
    this.activities.set(next.id, next)
    this.syncDismissTimer(next)
    this.emit()
    return cloneActivity(next)
  }

  end(id: string, input: unknown): Activity {
    if (!ID_PATTERN.test(id)) throw new ActivityError(400, 'id 无效')
    const current = this.activities.get(id)
    if (!current) throw new ActivityError(404, `找不到活动 ${id}`)
    const result = parseEnd(input)
    const now = this.now()
    const summary = result.summary?.trim()
    const next: Activity = {
      ...current,
      steps: current.steps.map((step) => settleStep(step, result.result)),
      state: result.result,
      title: summary ? clip(summary, 120) : current.title,
      progress: result.result === 'success' ? 1 : current.progress,
      updatedAt: now,
      endedAt: now
    }
    this.activities.set(id, next)
    this.syncDismissTimer(next)
    this.emit()
    return cloneActivity(next)
  }

  dismiss(id: string): void {
    this.clearTimer(id)
    this.dismissGeneration.delete(id)
    if (!this.activities.delete(id)) return
    this.emit()
  }

  clear(): void {
    for (const id of this.dismissTimers.keys()) this.clearTimer(id)
    this.dismissGeneration.clear()
    if (this.activities.size === 0) return
    this.activities.clear()
    this.emit()
  }

  dispose(): void {
    for (const id of this.dismissTimers.keys()) this.clearTimer(id)
    this.dismissGeneration.clear()
    this.listeners.clear()
  }

  private syncDismissTimer(activity: Activity): void {
    this.clearTimer(activity.id)
    if (activity.state !== 'success') return
    const generation = ++this.nextGeneration
    this.dismissGeneration.set(activity.id, generation)
    const handle = this.schedule(() => {
      if (this.dismissGeneration.get(activity.id) !== generation) return
      this.dismissTimers.delete(activity.id)
      if (this.activities.get(activity.id)?.state !== 'success') return
      this.activities.delete(activity.id)
      this.dismissGeneration.delete(activity.id)
      this.emit()
    }, SUCCESS_DWELL_MS)
    this.dismissTimers.set(activity.id, handle)
  }

  private clearTimer(id: string): void {
    this.dismissTimers.get(id)?.cancel()
    this.dismissTimers.delete(id)
  }

  private emit(): void {
    const snapshot = this.list()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        console.error(error)
      }
    }
  }
}

function resolveDetail(parsed: ParsedActivity, current: Activity | undefined): string | undefined {
  if (parsed.clearDetail) return undefined
  if (parsed.detail !== undefined) return parsed.detail
  return current?.detail
}

function resolveProgress(parsed: ParsedActivity, current: Activity | undefined): number | undefined {
  if (parsed.clearProgress) return undefined
  if (parsed.progress !== undefined) return parsed.progress
  return current?.progress
}

function resolveTasks(parsed: ParsedActivity, current: Activity | undefined): { tasks?: ActivityTask[] } {
  // Background work survives a new turn, so tasks are only replaced explicitly.
  const tasks = parsed.tasks === null ? undefined : parsed.tasks ?? current?.tasks
  return tasks?.length ? { tasks: tasks.map((task) => ({ ...task })) } : {}
}

function settleStep(step: ActivityStep, result: 'success' | 'error'): ActivityStep {
  if (step.status !== 'active' && step.status !== 'waiting') return { ...step }
  return { ...step, status: result === 'success' ? 'done' : 'error' }
}

function cloneActivity(activity: Activity): Activity {
  return {
    ...activity,
    ...(activity.operation ? { operation: { ...activity.operation } } : {}),
    steps: activity.steps.map((step) => ({ ...step })),
    ...(activity.tasks ? { tasks: activity.tasks.map((task) => ({ ...task })) } : {})
  }
}

function clip(value: string, max: number): string {
  const trimmed = value.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max - 1)}…`
}

export function parseActivityInput(input: unknown): ParsedActivity {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ActivityError(400, '请求体必须是对象')
  }
  const body = input as Record<string, unknown>
  if (typeof body.id !== 'string' || !ID_PATTERN.test(body.id)) {
    throw new ActivityError(400, 'id 必须是 1 到 80 位的字母、数字、.、_、: 或 -')
  }
  const parsed: ParsedActivity = { id: body.id, clearDetail: false, clearProgress: false }
  if ('agent' in body && body.agent !== undefined) {
    if (typeof body.agent !== 'string' || !body.agent.trim()) {
      throw new ActivityError(400, 'agent 无效')
    }
    parsed.agent = clip(body.agent, 40)
  }
  if ('state' in body && body.state !== undefined) {
    if (!isActivityState(body.state)) throw new ActivityError(400, 'state 无效')
    parsed.state = body.state
  }
  if ('client' in body && body.client !== undefined) {
    if (body.client === null) parsed.client = null
    else if (typeof body.client === 'string' && body.client.trim()) parsed.client = clip(body.client, 40)
    else throw new ActivityError(400, 'client 无效')
  }
  if ('title' in body && body.title !== undefined) {
    if (typeof body.title !== 'string' || !body.title.trim()) {
      throw new ActivityError(400, 'title 无效')
    }
    parsed.title = clip(body.title, 120)
  }
  if ('detail' in body) {
    if (body.detail === null) parsed.clearDetail = true
    else if (typeof body.detail === 'string') {
      const detail = clip(body.detail, 280)
      if (detail) parsed.detail = detail
      else parsed.clearDetail = true
    } else throw new ActivityError(400, 'detail 无效')
  }
  if ('progress' in body) {
    if (body.progress === null) parsed.clearProgress = true
    else if (typeof body.progress === 'number' && Number.isFinite(body.progress)) {
      if (body.progress < 0 || body.progress > 1) throw new ActivityError(400, 'progress 必须在 0 到 1 之间')
      parsed.progress = body.progress
    } else throw new ActivityError(400, 'progress 无效')
  }
  if ('operation' in body) parsed.operation = body.operation === null ? null : parseOperation(body.operation)
  if ('steps' in body && body.steps !== undefined) parsed.steps = parseSteps(body.steps)
  if ('tasks' in body && body.tasks !== undefined) parsed.tasks = body.tasks === null ? null : parseTasks(body.tasks)
  for (const key of ['startedAt', 'endedAt'] as const) {
    if (body[key] === undefined) continue
    if (typeof body[key] !== 'number' || !Number.isFinite(body[key]) || body[key] < 0 || body[key] > 8.64e15) throw new ActivityError(400, `${key} 必须是有效的毫秒时间戳`)
    parsed[key] = body[key]
  }
  return parsed
}

function parseEnd(input: unknown): { result: 'success' | 'error'; summary?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ActivityError(400, '请求体必须是对象')
  }
  const body = input as Record<string, unknown>
  if (body.result !== 'success' && body.result !== 'error') {
    throw new ActivityError(400, 'result 必须是 success 或 error')
  }
  if ('summary' in body && body.summary !== undefined) {
    if (typeof body.summary !== 'string') throw new ActivityError(400, 'summary 无效')
    return { result: body.result, summary: body.summary }
  }
  return { result: body.result }
}

function parseSteps(value: unknown): ActivityStep[] {
  if (!Array.isArray(value)) throw new ActivityError(400, 'steps 必须是数组')
  if (value.length > 12) throw new ActivityError(400, 'steps 最多 12 条')
  const seen = new Set<string>()
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ActivityError(400, `steps[${index}] 无效`)
    }
    const step = item as Record<string, unknown>
    const id = typeof step.id === 'string' ? step.id.trim() : ''
    if (!STEP_ID_PATTERN.test(id)) throw new ActivityError(400, `steps[${index}].id 无效`)
    if (typeof step.label !== 'string' || !step.label.trim()) {
      throw new ActivityError(400, `steps[${index}].label 无效`)
    }
    if (!isStepStatus(step.status)) throw new ActivityError(400, `steps[${index}].status 无效`)
    if (seen.has(id)) throw new ActivityError(400, `steps[${index}].id 重复`)
    seen.add(id)
    if (step.kind !== undefined && !isOperationKind(step.kind)) throw new ActivityError(400, `steps[${index}].kind 无效`)
    return { id, label: clip(step.label, 80), status: step.status, ...(step.kind ? { kind: step.kind as OperationKind } : {}) }
  })
}

function parseTasks(value: unknown): ActivityTask[] {
  if (!Array.isArray(value)) throw new ActivityError(400, 'tasks 必须是数组')
  if (value.length > 12) throw new ActivityError(400, 'tasks 最多 12 条')
  const seen = new Set<string>()
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ActivityError(400, `tasks[${index}] 无效`)
    const task = item as Record<string, unknown>
    const id = typeof task.id === 'string' ? task.id.trim() : ''
    if (!ID_PATTERN.test(id)) throw new ActivityError(400, `tasks[${index}].id 无效`)
    if (seen.has(id)) throw new ActivityError(400, `tasks[${index}].id 重复`)
    seen.add(id)
    if (task.kind !== 'agent' && task.kind !== 'command') throw new ActivityError(400, `tasks[${index}].kind 无效`)
    if (typeof task.label !== 'string' || !task.label.trim()) throw new ActivityError(400, `tasks[${index}].label 无效`)
    if (typeof task.status !== 'string' || !(TASK_STATUSES as readonly string[]).includes(task.status)) {
      throw new ActivityError(400, `tasks[${index}].status 无效`)
    }
    if (task.detail !== undefined && typeof task.detail !== 'string') throw new ActivityError(400, `tasks[${index}].detail 无效`)
    const detail = typeof task.detail === 'string' ? clip(task.detail, 160) : ''
    return { id, kind: task.kind, label: clip(task.label, 80), status: task.status as TaskStatus, ...(detail ? { detail } : {}) }
  })
}

function isActivityState(value: unknown): value is ActivityState {
  return typeof value === 'string' && (ACTIVITY_STATES as readonly string[]).includes(value)
}

function isStepStatus(value: unknown): value is StepStatus {
  return typeof value === 'string' && (STEP_STATUSES as readonly string[]).includes(value)
}

function isOperationKind(value: unknown): value is OperationKind {
  return typeof value === 'string' && (OPERATION_KINDS as readonly string[]).includes(value)
}

function parseOperation(value: unknown): ActivityOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ActivityError(400, 'operation 无效')
  const body = value as Record<string, unknown>
  if (!isOperationKind(body.kind)) throw new ActivityError(400, 'operation.kind 无效')
  const operation: ActivityOperation = { kind: body.kind }
  for (const key of ['name', 'command', 'shell', 'cwd'] as const) {
    if (body[key] === undefined) continue
    if (typeof body[key] !== 'string') throw new ActivityError(400, `operation.${key} 无效`)
    operation[key] = clip(body[key], key === 'command' ? 4000 : key === 'cwd' ? 400 : 120)
  }
  return operation
}
