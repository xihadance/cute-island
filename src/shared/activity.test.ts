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

  it('rejects invalid payloads', () => {
    const store = new ActivityStore(() => ({ cancel() {} }))
    expect(() => store.upsert({ id: 'bad id', title: 'x' })).toThrow(/id/)
    expect(() => store.upsert({ id: 'ok', progress: 1.4 })).toThrow(/progress/)
    expect(() => store.upsert({ id: 'ok', state: 'paused' })).toThrow(/state/)
  })

  it('uses the documented dwell', () => {
    expect(SUCCESS_DWELL_MS).toBe(2800)
  })
})

describe('pickPrimary', () => {
  it('returns undefined when nothing is running', () => {
    expect(pickPrimary([])).toBeUndefined()
    const activity = { state: 'waiting' } as Activity
    expect(pickPrimary([activity])?.state).toBe('waiting')
  })
})
