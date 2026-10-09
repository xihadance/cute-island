export const SUCCESS_DWELL_MS = 2800

export type ActivityState = 'thinking' | 'running' | 'waiting' | 'success' | 'error'
export type StepStatus = 'pending' | 'active' | 'done' | 'error'

export interface ActivityStep {
  id: string
  label: string
  status: StepStatus
}

export interface Activity {
  id: string
  agent: string
  state: ActivityState
  title: string
  detail?: string
  progress?: number
  steps: ActivityStep[]
  startedAt: number
  updatedAt: number
  endedAt?: number
}

export interface ActivityInput {
  id: string
  agent?: string
  state?: ActivityState
  title?: string
  detail?: string | null
  progress?: number | null
  steps?: ActivityStep[]
}

export interface EndInput {
  result: 'success' | 'error'
  summary?: string
}

export const ACTIVITY_STATES: readonly ActivityState[] = [
  'thinking',
  'running',
  'waiting',
  'success',
  'error'
]

export const STATE_LABEL: Record<ActivityState, string> = {
  thinking: '思考中',
  running: '执行中',
  waiting: '等待中',
  success: '已完成',
  error: '失败'
}

const PRIORITY: Record<ActivityState, number> = {
  error: 50,
  running: 40,
  thinking: 30,
  waiting: 20,
  success: 10
}

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/
const STEP_ID_PATTERN = /^[A-Za-z0-9._:-]{1,40}$/
const STEP_STATUSES: readonly StepStatus[] = ['pending', 'active', 'done', 'error']

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
  if (typeof activity.progress === 'number') height += 22
  height += Math.min(activity.steps.length, 4) * 22
  if (otherCount > 0) height += 22 + Math.min(otherCount, 3) * 18
  return Math.min(Math.max(height, 150), 320)
}

interface ParsedActivity {
  id: string
  agent?: string
  state?: ActivityState
  title?: string
  clearDetail: boolean
  detail?: string
  clearProgress: boolean
  progress?: number
  steps?: ActivityStep[]
}

export class ActivityStore {
  private readonly activities = new Map<string, Activity>()
  private readonly listeners = new Set<(activities: Activity[]) => void>()
  private readonly dismissTimers = new Map<string, { cancel: () => void }>()
  private readonly dismissGeneration = new Map<string, number>()

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
    const next: Activity = {
      id: parsed.id,
      agent: parsed.agent ?? current?.agent ?? 'Agent',
      state,
      title: parsed.title ?? current?.title ?? defaultTitle(state),
      detail: resolveDetail(parsed, current),
      progress: resolveProgress(parsed, current),
      steps: parsed.steps ?? current?.steps.map((step) => ({ ...step })) ?? [],
      startedAt: current?.startedAt ?? now,
      updatedAt: now
    }
    const terminal = state === 'success' || state === 'error'
    if (terminal) {
      next.endedAt = current?.state === state && current.endedAt ? current.endedAt : now
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
    this.listeners.clear()
  }

  private syncDismissTimer(activity: Activity): void {
    this.clearTimer(activity.id)
    if (activity.state !== 'success') return
    const generation = (this.dismissGeneration.get(activity.id) ?? 0) + 1
    this.dismissGeneration.set(activity.id, generation)
    const handle = this.schedule(() => {
      this.dismissTimers.delete(activity.id)
      if (this.dismissGeneration.get(activity.id) !== generation) return
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

function settleStep(step: ActivityStep, result: 'success' | 'error'): ActivityStep {
  if (step.status !== 'active') return { ...step }
  return { ...step, status: result === 'success' ? 'done' : 'error' }
}

function cloneActivity(activity: Activity): Activity {
  return {
    ...activity,
    steps: activity.steps.map((step) => ({ ...step }))
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
  if ('steps' in body && body.steps !== undefined) parsed.steps = parseSteps(body.steps)
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
    return { id, label: clip(step.label, 80), status: step.status }
  })
}

function isActivityState(value: unknown): value is ActivityState {
  return typeof value === 'string' && (ACTIVITY_STATES as readonly string[]).includes(value)
}

function isStepStatus(value: unknown): value is StepStatus {
  return typeof value === 'string' && (STEP_STATUSES as readonly string[]).includes(value)
}
