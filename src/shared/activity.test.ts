import { describe, expect, it } from 'vitest'
import {
  ActivityStore,
  SUCCESS_DWELL_MS,
  pickPrimary,
  type Activity
} from './activity'

function schedulerOf(pending: Array<{ fn: () => void; cancelled: boolean }>) {
  return (fn: () => void) => {
    const handle = {
      fn,
      cancelled: false,
      cancel() {
        handle.cancelled = true
      }
    }
    pending.push(handle)
    return handle
  }
}

describe('ActivityStore', () => {
  it('preserves recorded execution times across metadata updates and explicitly starts a new round', () => {
    let now = 100_000
    const store = new ActivityStore(() => ({ cancel() {} }), () => now)
    store.upsert({ id: 'timed', state: 'running', startedAt: 10_000 })
    now += 5000
    expect(store.upsert({ id: 'timed', client: 'VS Code' }).startedAt).toBe(10_000)
    expect(store.upsert({ id: 'timed', state: 'success', endedAt: 90_000 })).toMatchObject({ startedAt: 10_000, endedAt: 90_000 })
    expect(store.upsert({ id: 'timed', title: '更新显示' }).endedAt).toBe(90_000)
    const next = store.upsert({ id: 'timed', state: 'running', startedAt: 101_000 })
    expect(next.startedAt).toBe(101_000)
    expect(next.endedAt).toBeUndefined()
    for (const value of [-1, Infinity, NaN, 'today', null]) {
      expect(() => store.upsert({ id: 'timed', startedAt: value })).toThrow('startedAt')
      expect(() => store.upsert({ id: 'timed', endedAt: value })).toThrow('endedAt')
    }
  })

  it('validates client labels, preserves them across turns, and supports explicit clearing', () => {
    const store = new ActivityStore(() => ({ cancel() {} }))
    expect(store.upsert({ id: 'client', client: ' VS Code ' }).client).toBe('VS Code')
    store.end('client', { result: 'success' })
    expect(store.upsert({ id: 'client', state: 'running' }).client).toBe('VS Code')
    expect(store.upsert({ id: 'client', client: null }).client).toBeUndefined()
    for (const client of ['', '  ', 1, {}, []]) expect(() => store.upsert({ id: 'client', client })).toThrow('client 无效')
    expect(store.upsert({ id: 'client', client: 'a'.repeat(80) }).client).toHaveLength(40)
  })

  it('keeps approvals until an explicit update, prioritizes them, and isolates operation snapshots', () => {
    const pending: Array<{ fn: () => void; cancelled: boolean }> = []
    const store = new ActivityStore(schedulerOf(pending))
    store.upsert({ id: 'run', state: 'running' })
    store.upsert({ id: 'approval', state: 'approval', operation: { kind: 'command', command: 'npm install' },
      steps: [{ id: 'install', label: '安装依赖', status: 'waiting', kind: 'command' }] })
    expect(store.list()[0].id).toBe('approval')
    expect(pending).toHaveLength(0)
    store.get('approval')!.operation!.command = 'changed'
    expect(store.get('approval')?.operation?.command).toBe('npm install')
    store.upsert({ id: 'approval', state: 'running', operation: null })
    expect(store.get('approval')?.operation).toBeUndefined()
    expect(store.end('approval', { result: 'success' }).steps[0].status).toBe('done')
    expect(pending).toHaveLength(1)
  })

  it('validates operation metadata and resets it on a new turn', () => {
    const store = new ActivityStore(() => ({ cancel() {} }))
    expect(() => store.upsert({ id: 'x', operation: { kind: 'invalid' } })).toThrow('operation.kind')
    expect(() => store.upsert({ id: 'x', operation: { kind: 'command', command: 123 } })).toThrow('operation.command')
    store.upsert({ id: 'x', state: 'success', operation: { kind: 'mcp', name: 'context7 / query_docs' } })
    expect(store.upsert({ id: 'x', state: 'thinking' }).operation).toBeUndefined()
  })

  it('merges updates and keeps the original start time', () => {
    let clock = 1_000
    const store = new ActivityStore(
      () => ({ cancel() {} }),
      () => clock
    )
    store.upsert({
      id: 'run-1',
      agent: 'Cursor',
      state: 'thinking',
      title: '正在理解任务',
      detail: '看结构'
    })
    clock = 2_500
    const next = store.upsert({
      id: 'run-1',
      state: 'running',
      title: '正在修改登录页',
      progress: 0.4
    })
    expect(next.agent).toBe('Cursor')
    expect(next.startedAt).toBe(1_000)
    expect(next.updatedAt).toBe(2_500)
    expect(next.detail).toBe('看结构')
    expect(next.progress).toBe(0.4)
    expect(next.endedAt).toBeUndefined()
  })

  it('orders activities by error, running, thinking, waiting, then success', () => {
    const store = new ActivityStore(() => ({ cancel() {} }))
    store.upsert({ id: 'thinking', agent: 'A', state: 'thinking', title: '思考' })
    store.upsert({ id: 'waiting', agent: 'A', state: 'waiting', title: '等待' })
    store.upsert({ id: 'running', agent: 'A', state: 'running', title: '执行' })
    store.upsert({ id: 'success', agent: 'A', state: 'success', title: '完成' })
    store.upsert({ id: 'error', agent: 'A', state: 'error', title: '失败' })
    expect(store.list().map((item) => item.state)).toEqual([
      'error',
      'running',
      'thinking',
      'waiting',
      'success'
    ])
    expect(pickPrimary(store.list())?.id).toBe('error')
  })

  it('removes a successful activity only after the dwell, and keeps errors', () => {
    const pending: Array<{ fn: () => void; cancelled: boolean }> = []
    const store = new ActivityStore(schedulerOf(pending))
    store.upsert({ id: 'ok', agent: 'Cursor', state: 'success', title: '登录页已更新' })
    store.upsert({ id: 'bad', agent: 'Cursor', state: 'error', title: '无法写入文件' })
    expect(pending).toHaveLength(1)
    expect(pending[0]?.cancelled).toBe(false)
    expect(store.list().map((item) => item.id)).toEqual(['bad', 'ok'])
    pending[0]?.fn()
    expect(store.list().map((item) => item.id)).toEqual(['bad'])
  })

  it('ignores a superseded success timer', () => {
    const pending: Array<{ fn: () => void; cancelled: boolean }> = []
    const store = new ActivityStore(schedulerOf(pending))
    store.upsert({ id: 'ok', agent: 'Cursor', state: 'success', title: '第一次' })
    store.upsert({ id: 'ok', title: '第二次' })
    expect(pending[0]?.cancelled).toBe(true)
    expect(pending[1]?.cancelled).toBe(false)
    pending[0]?.fn()
    expect(store.get('ok')?.title).toBe('第二次')
    pending[1]?.fn()
    expect(store.get('ok')).toBeUndefined()
  })

  it('ends an activity and settles the active step', () => {
    let clock = 10
    const store = new ActivityStore(
      () => ({ cancel() {} }),
      () => clock
    )
    store.upsert({
      id: 'run-1',
      agent: 'Cursor',
      state: 'running',
      title: '正在修改登录页',
      steps: [{ id: 'edit', label: '修改登录页', status: 'active' }]
    })
    clock = 20
    const done = store.end('run-1', { result: 'success', summary: '登录页已更新' })
    expect(done.state).toBe('success')
    expect(done.title).toBe('登录页已更新')
    expect(done.progress).toBe(1)
    expect(done.steps[0]?.status).toBe('done')
    expect(done.endedAt).toBe(20)
    expect(() => store.end('missing', { result: 'error' })).toThrow(/找不到活动/)
  })

  it('does not let a cancelled timer dismiss a recreated activity with the same id', () => {
    const pending: Array<{ fn: () => void; cancelled: boolean }> = []
    const store = new ActivityStore(schedulerOf(pending))
    store.upsert({ id: 'reused', state: 'success' })
    store.dismiss('reused')
    store.upsert({ id: 'reused', state: 'success', title: '新的完成状态' })
    pending[0].fn()
    expect(store.get('reused')?.title).toBe('新的完成状态')
    store.dispose()
    expect(pending[1].cancelled).toBe(true)
  })

  it('resets elapsed time and stale progress when a completed session starts another turn', () => {
    let now = 100
    const store = new ActivityStore(() => ({ cancel() {} }), () => now)
    store.upsert({ id: 'reused', state: 'running', steps: [{ id: 'old', label: '上轮步骤', status: 'active' }] })
    store.end('reused', { result: 'success' })
    now = 200
    const next = store.upsert({ id: 'reused', state: 'thinking' })
    expect(next).toMatchObject({ startedAt: 200, steps: [], progress: undefined })
    expect(next.endedAt).toBeUndefined()
  })

  it('rejects invalid payloads', () => {
    const store = new ActivityStore(() => ({ cancel() {} }))
    expect(() => store.upsert({ id: 'bad id', title: 'x' })).toThrow(/id/)
    expect(() => store.upsert({ id: 'ok', progress: 1.4 })).toThrow(/progress/)
    expect(() => store.upsert({ id: 'ok', state: 'paused' })).toThrow(/state/)
  })

  it('uses the documented dwell', () => {
    expect(SUCCESS_DWELL_MS).toBe(2800)
  })

  it('keeps background tasks across turns until replaced or cleared, and validates them', () => {
    const store = new ActivityStore(() => ({ cancel() {} }))
    const task = { id: 'cell-3', kind: 'command', label: 'npm test', status: 'active' }
    store.upsert({ id: 'bg', state: 'running', tasks: [task] })
    store.end('bg', { result: 'success' })
    expect(store.upsert({ id: 'bg', state: 'thinking' }).tasks).toEqual([task])
    store.get('bg')!.tasks![0].label = 'changed'
    expect(store.get('bg')?.tasks?.[0].label).toBe('npm test')
    expect(store.upsert({ id: 'bg', tasks: null }).tasks).toBeUndefined()
    expect(() => store.upsert({ id: 'bg', tasks: [{ ...task, status: 'paused' }] })).toThrow(/tasks\[0\]\.status/)
    expect(() => store.upsert({ id: 'bg', tasks: [task, task] })).toThrow(/重复/)
    expect(() => store.upsert({ id: 'bg', tasks: [{ ...task, kind: 'shell' }] })).toThrow(/kind/)
  })
})

describe('pickPrimary', () => {
  it('returns undefined when nothing is running', () => {
    expect(pickPrimary([])).toBeUndefined()
    const activity = { state: 'waiting' } as Activity
    expect(pickPrimary([activity])?.state).toBe('waiting')
  })
})
