import { afterEach, describe, expect, it } from 'vitest'
import { ActivityStore } from './shared/activity'
import { runCli } from './cli'
import { startStatusServer, type StatusServer } from './main/server'

const servers: StatusServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

describe('runCli', () => {
  it('pushes and ends an activity against the local server', async () => {
    const store = new ActivityStore(() => ({ cancel() {} }))
    const server = await startStatusServer(store, { port: 0, token: 'secret' })
    servers.push(server)
    const logs: string[] = []
    const env = { CUTE_ISLAND_PORT: String(server.port), CUTE_ISLAND_TOKEN: 'secret' }
    const pushed = await runCli(
      ['push', '--agent', 'Cursor', '--state', 'running', '--title', '正在修改登录页', '--progress', '0.25'],
      { env, stdout: (line) => logs.push(line), stderr: (line) => logs.push(line) }
    )
    expect(pushed).toBe(0)
    expect(store.get('default')).toMatchObject({
      agent: 'Cursor',
      state: 'running',
      title: '正在修改登录页',
      progress: 0.25
    })
    const ended = await runCli(['end', '--result', 'error', '--summary', '无法写入文件'], {
      env,
      stdout: (line) => logs.push(line)
    })
    expect(ended).toBe(0)
    expect(store.get('default')?.state).toBe('error')
    expect(store.get('default')?.title).toBe('无法写入文件')
  })

  it('plays the demo in order through the status API', async () => {
    const store = new ActivityStore(() => ({ cancel() {} }))
    const server = await startStatusServer(store, { port: 0 })
    servers.push(server)
    const code = await runCli(['demo'], {
      env: { CUTE_ISLAND_PORT: String(server.port) },
      sleep: async () => {},
      stdout() {}
    })
    expect(code).toBe(0)
    expect(store.get('demo')).toMatchObject({ state: 'success', title: '登录页已更新' })
  })

  it('reports that the island is not running', async () => {
    const errors: string[] = []
    const code = await runCli(['push', '--title', '你好'], {
      env: { CUTE_ISLAND_PORT: '1' },
      stderr: (line) => errors.push(line),
      fetchImpl: async () => {
        throw new Error('offline')
      }
    })
    expect(code).toBe(1)
    expect(errors.join('\n')).toMatch(/连不上灵动岛/)
  })
})
