import { describe, expect, it } from 'vitest'
import { ActivityStore } from './activity'
import { AttentionTracker, attentionKind, isPassive, shouldIgnoreMouse } from './island-behavior'

describe('managed island attention', () => {
  it('keeps routine work and generic waiting quiet, but identifies explicit requests and failures', () => {
    const store = new ActivityStore()
    for (const state of ['running', 'thinking', 'waiting', 'success'] as const) {
      expect(attentionKind(store.upsert({ id: state, state }))).toBeUndefined()
    }
    expect(attentionKind(store.upsert({ id: 'approval', state: 'approval' }))).toBe('approval')
    expect(attentionKind(store.upsert({ id: 'failure', state: 'error' }))).toBe('error')
    for (const name of ['AskUserQuestion', 'functions.request_user_input', 'request_user_input_async', 'ask_user']) {
      expect(attentionKind(store.upsert({ id: 'input', state: 'running', operation: { kind: 'tool', name } }))).toBe('input')
    }
    expect(attentionKind(store.upsert({ id: 'input', state: 'success' }))).toBeUndefined()
    expect(attentionKind(store.upsert({ id: 'task', state: 'running', tasks: [{ id: 'child', kind: 'agent', label: '审查', status: 'error' }] }))).toBe('task-error')
    expect(attentionKind(store.upsert({ id: 'task', state: 'running', tasks: [{ id: 'child', kind: 'agent', label: '审查', status: 'active', state: 'approval' }] }))).toBe('task-approval')
    expect(attentionKind(store.upsert({ id: 'task', state: 'running', tasks: [{ id: 'child', kind: 'agent', label: '审查', status: 'done', state: 'approval' }] }))).toBeUndefined()
    store.dispose()
  })

  it('acknowledges one occurrence without hiding other sessions or repeating on metadata refresh', () => {
    const store = new ActivityStore()
    const tracker = new AttentionTracker()
    store.upsert({ id: 'one', state: 'approval', startedAt: 1000, operation: { kind: 'command', command: 'npm install' } })
    store.upsert({ id: 'two', state: 'error' })
    tracker.update(store.list())
    tracker.acknowledge('one')
    store.upsert({ id: 'one', client: 'VS Code', progress: 0.5, detail: '状态刷新' })
    tracker.update(store.list())
    expect(tracker.pendingIds()).toEqual(['two'])
    expect(store.get('one')).toBeDefined()
    store.upsert({ id: 'one', operation: { kind: 'command', command: 'npm publish' } })
    tracker.update(store.list())
    expect(tracker.pendingIds()).toContain('one')
    tracker.acknowledge('one')
    store.upsert({ id: 'one', state: 'running' })
    tracker.update(store.list())
    store.upsert({ id: 'one', state: 'approval' })
    tracker.update(store.list())
    expect(tracker.pendingIds()).toContain('one')
    tracker.acknowledge('one')
    store.upsert({ id: 'one', startedAt: 2000 })
    tracker.update(store.list())
    expect(tracker.pendingIds()).toContain('one')
    store.dispose()
  })

  it('realerts for new failed tasks and removes dismissed sessions', () => {
    const store = new ActivityStore()
    const tracker = new AttentionTracker()
    store.upsert({ id: 'one', tasks: [{ id: 'a', kind: 'command', label: '测试', status: 'error' }] })
    tracker.update(store.list())
    tracker.acknowledge('one')
    store.upsert({ id: 'one', title: '继续工作' })
    tracker.update(store.list())
    expect(tracker.pendingIds()).toEqual([])
    store.upsert({ id: 'one', tasks: [{ id: 'b', kind: 'agent', label: '审查', status: 'error' }] })
    tracker.update(store.list())
    expect(tracker.pendingIds()).toEqual(['one'])
    store.upsert({ id: 'one', tasks: [
      { id: 'b', kind: 'agent', label: '审查', status: 'error' },
      { id: 'c', kind: 'command', label: '测试', status: 'error' }
    ] })
    tracker.update(store.list())
    tracker.acknowledge('one')
    store.upsert({ id: 'one', tasks: [{ id: 'b', kind: 'agent', label: '审查', status: 'error' }] })
    tracker.update(store.list())
    expect(tracker.pendingIds()).toEqual([])
    store.dismiss('one')
    tracker.update(store.list())
    expect(tracker.pendingIds()).toEqual([])
    store.dispose()
  })

  it('passes all quiet managed input through, including stale expanded and dragging state', () => {
    const quiet = { mode: 'managed' as const, attentionIds: [] }
    expect(isPassive(quiet)).toBe(true)
    for (const over of [false, true]) for (const expanded of [false, true]) for (const dragging of [false, true]) {
      expect(shouldIgnoreMouse(quiet, over, expanded, dragging)).toBe(true)
    }
    const alert = { ...quiet, attentionIds: ['approval'] }
    expect(isPassive(alert)).toBe(false)
    expect(shouldIgnoreMouse(alert, true, true, false)).toBe(false)
    expect(shouldIgnoreMouse(alert, false, true, false)).toBe(true)
    const focus = { ...quiet, mode: 'focus' as const }
    expect(shouldIgnoreMouse(focus, true, false, false)).toBe(false)
    expect(shouldIgnoreMouse(focus, false, true, false)).toBe(false)
    expect(shouldIgnoreMouse(focus, false, false, true)).toBe(false)
    expect(shouldIgnoreMouse(focus, false, false, false)).toBe(true)
  })
})
