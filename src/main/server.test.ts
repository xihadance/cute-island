import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { ActivityStore } from '../shared/activity'
import { startStatusServer, type StatusServer } from './server'

const servers: StatusServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

describe('status server', () => {
  it('creates, updates, and ends an activity', async () => {
    const store = new ActivityStore(() => ({ cancel() {} }))
    const server = await startStatusServer(store, { port: 0 })
    servers.push(server)
    const created = await post(server.port, '/v1/activities', {
      id: 'run-1',
      agent: 'Cursor',
      state: 'thinking',
      title: '正在理解任务'
    })
    expect(created.status).toBe(200)
    expect(created.json.activity.state).toBe('thinking')

    const updated = await post(server.port, '/v1/activities', {
      id: 'run-1',
      state: 'running',
      title: '正在修改登录页',
      progress: 0.5
    })
    expect(updated.json.activity).toMatchObject({
      agent: 'Cursor',
      state: 'running',
      title: '正在修改登录页',
      progress: 0.5
    })

    const ended = await post(server.port, '/v1/activities/run-1/end', {
      result: 'success',
      summary: '登录页已更新'
    })
    expect(ended.status).toBe(200)
    expect(ended.json.activity.state).toBe('success')
    expect(ended.json.activity.title).toBe('登录页已更新')

    const listed = await fetch(`http://127.0.0.1:${server.port}/v1/activities`)
    const body = (await listed.json()) as { activities: Array<{ id: string }> }
    expect(body.activities.map((item) => item.id)).toEqual(['run-1'])
  })

  it('rejects a bad token and a missing activity', async () => {
    const store = new ActivityStore(() => ({ cancel() {} }))
    const server = await startStatusServer(store, { port: 0, token: 'secret' })
    servers.push(server)
    const denied = await post(server.port, '/v1/activities', { id: 'run-1', title: 'x' })
    expect(denied.status).toBe(401)
    const allowed = await post(server.port, '/v1/activities', { id: 'run-1', title: '正在执行' }, 'secret')
    expect(allowed.status).toBe(200)
    const missing = await post(server.port, '/v1/activities/nope/end', { result: 'error' }, 'secret')
    expect(missing.status).toBe(404)
  })

  it('pushes activity snapshots over the websocket', async () => {
    const store = new ActivityStore(() => ({ cancel() {} }))
    const server = await startStatusServer(store, { port: 0 })
    servers.push(server)
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/v1/events`)
    try {
      const messages = collectMessages(socket)
      const first = JSON.parse(await messages.next()) as { activities: unknown[] }
      expect(first.activities).toEqual([])
      await post(server.port, '/v1/activities', {
        id: 'run-1',
        agent: 'Cursor',
        state: 'running',
        title: '正在修改登录页'
      })
      const second = JSON.parse(await messages.next()) as { activities: Array<{ title: string }> }
      expect(second.activities[0]?.title).toBe('正在修改登录页')
    } finally {
      socket.close()
    }
  })

  it('reports malformed URL ids as a client error', async () => {
    const server = await startStatusServer(new ActivityStore(), { port: 0 })
    servers.push(server)
    expect((await post(server.port, '/v1/activities/%ZZ/end', { result: 'success' })).status).toBe(400)
  })

  it('releases a failed startup subscription and closes idempotently', async () => {
    const store = new ActivityStore()
    const server = await startStatusServer(store, { port: 0 })
    servers.push(server)
    const unsubscribe = vi.fn()
    vi.spyOn(store, 'subscribe').mockReturnValue(unsubscribe)
    await expect(startStatusServer(store, { port: server.port })).rejects.toThrow()
    expect(unsubscribe).toHaveBeenCalledOnce()
    await Promise.all([server.close(), server.close()])
  })
})

async function post(
  port: number,
  pathname: string,
  body: unknown,
  token?: string
): Promise<{ status: number; json: { activity: Record<string, unknown>; error?: string } }> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  })
  return {
    status: response.status,
    json: (await response.json()) as { activity: Record<string, unknown>; error?: string }
  }
}

function collectMessages(socket: WebSocket): { next: () => Promise<string> } {
  const pending: string[] = []
  const waiters: Array<(value: string) => void> = []
  socket.on('message', (data) => {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
    const waiter = waiters.shift()
    if (waiter) waiter(text)
    else pending.push(text)
  })
  return {
    next: () => {
      const queued = pending.shift()
      if (queued !== undefined) return Promise.resolve(queued)
      return new Promise((resolve) => waiters.push(resolve))
    }
  }
}
