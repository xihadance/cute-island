import { describe, expect, it } from 'vitest'
import { ActivityStore } from '../shared/activity'
import { AttentionTracker, attentionKind } from '../shared/island-behavior'
import { createReducer, mergeChildTasks } from './reduce'
import type { ChildSession } from './reduce'

function child(terminal: boolean, at: number): ChildSession {
  return { live: true, link: { parentSessionId: 'parent', taskId: 'child', label: '检查' }, view: {
    id: 'codex-child', kind: 'codex', agent: 'Codex', state: terminal ? 'error' : 'thinking',
    title: terminal ? '执行失败' : '检查中', startedAt: 1000, endedAt: terminal ? at : undefined,
    terminal, steps: [], tasks: []
  } }
}

describe('child attention across parent turns', () => {
  it('retires a child failure on the next parent turn even when only the child records its completion', () => {
    const reducer = createReducer()
    const store = new ActivityStore()
    const tracker = new AttentionTracker()
    reducer.push([{ kind: 'user', title: '检查', at: 1000 }, { kind: 'task_start', taskId: 'child', task: 'agent', label: '检查', at: 1000 }])
    const publish = () => {
      const view = mergeChildTasks(reducer.snapshot(), [child(true, 2000)])
      const activity = store.upsert({ id: 'parent', ...view, operation: view.operation ?? null, tasks: view.tasks.length ? view.tasks : null })
      tracker.update(store.list())
      return activity
    }
    expect(attentionKind(publish())).toBe('task-error')
    tracker.acknowledge('parent')
    reducer.push([{ kind: 'user', title: '继续', at: 3000 }])
    expect(publish().tasks).toBeUndefined()
    expect(tracker.pendingIds()).toEqual([])
    reducer.push([{ kind: 'thinking', title: '当前工作', at: 4000 }])
    expect(attentionKind(publish())).toBeUndefined()
    store.dispose()
  })

  it('keeps work spanning turns and still alerts when it fails during the current turn', () => {
    const reducer = createReducer()
    reducer.push([{ kind: 'user', title: '检查', at: 1000 }, { kind: 'task_start', taskId: 'child', task: 'agent', label: '检查', at: 1000 },
      { kind: 'user', title: '继续', at: 3000 }])
    expect(mergeChildTasks(reducer.snapshot(), [child(false, 0)]).tasks[0].status).toBe('active')
    const view = mergeChildTasks(reducer.snapshot(), [child(true, 4000)])
    const store = new ActivityStore()
    expect(attentionKind(store.upsert({ id: 'parent', ...view, operation: view.operation ?? null }))).toBe('task-error')
    expect(view.tasks[0]).toMatchObject({ status: 'error', endedAt: 4000 })
    store.dispose()
  })

  it('does not apply a previous child failure to a reused task waiting for new log records', () => {
    const reducer = createReducer()
    reducer.push([{ kind: 'user', title: '重试', at: 3000 }, { kind: 'task_start', taskId: 'child', task: 'agent', label: '重新检查', at: 3000 }])
    expect(mergeChildTasks(reducer.snapshot(), [child(true, 2000)]).tasks[0])
      .toMatchObject({ status: 'active', startedAt: 3000 })
    expect(mergeChildTasks(reducer.snapshot(), [child(true, 4000)]).tasks[0])
      .toMatchObject({ status: 'error', startedAt: 3000, endedAt: 4000 })
  })

  it('keeps an unresolved failure when its end time is unknown', () => {
    const reducer = createReducer()
    reducer.push([{ kind: 'user', title: '检查', at: 1000 }, { kind: 'task_start', taskId: 'child', task: 'agent', label: '检查', at: 1000 },
      { kind: 'user', title: '继续', at: 3000 }])
    const unresolved = child(true, 2000)
    unresolved.view.endedAt = undefined
    expect(mergeChildTasks(reducer.snapshot(), [unresolved]).tasks[0].status).toBe('error')
  })
})
