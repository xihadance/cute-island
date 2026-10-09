import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { ActivityError, ActivityStore, type Activity } from '../shared/activity'

export interface StatusServer {
  port: number
  close: () => Promise<void>
}

export function startStatusServer(
  store: ActivityStore,
  options: { port: number; token?: string }
): Promise<StatusServer> {
  const token = options.token?.trim() || undefined
  const sockets = new Set<WebSocket>()
  const httpServer = createServer((req, res) => {
    void handleRequest(req, res, store, token).catch((error: unknown) => {
      if (res.headersSent) return
      const status = error instanceof ActivityError ? error.status : 500
      sendJson(res, status, { error: error instanceof Error ? error.message : '内部错误' })
    })
  })
  const wss = new WebSocketServer({ noServer: true })

  const unsubscribe = store.subscribe((activities) => {
    broadcast(sockets, activities)
  })

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname = '/'
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    } catch {
      socket.destroy()
      return
    }
    if (pathname !== '/v1/events') {
      socket.destroy()
      return
    }
    if (!authorized(req, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws)
      ws.send(JSON.stringify({ type: 'activities', activities: store.list() }))
      ws.on('close', () => sockets.delete(ws))
      ws.on('error', () => sockets.delete(ws))
    })
  })

  return new Promise((resolve, reject) => {
    const fail = (error: Error): void => {
      httpServer.off('error', fail)
      reject(error)
    }
    httpServer.once('error', fail)
    httpServer.listen(options.port, '127.0.0.1', () => {
      httpServer.off('error', fail)
      const address = httpServer.address()
      if (!address || typeof address === 'string') {
        reject(new Error('状态服务没有拿到端口'))
        return
      }
      resolve({
        port: address.port,
        close: () => closeServer(httpServer, wss, sockets, unsubscribe)
      })
    })
  })
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: ActivityStore,
  token: string | undefined
): Promise<void> {
  if (!authorized(req, token)) {
    sendJson(res, 401, { error: '未授权' })
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const parts = url.pathname.split('/').filter(Boolean)
  if (req.method === 'GET' && url.pathname === '/v1/activities') {
    sendJson(res, 200, { activities: store.list() })
    return
  }
  if (req.method === 'POST' && url.pathname === '/v1/activities') {
    const activity = store.upsert(await readJson(req))
    sendJson(res, 200, { activity })
    return
  }
  if (req.method === 'POST' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'activities' && parts[3] === 'end') {
    const activity = store.end(decodeURIComponent(parts[2]), await readJson(req))
    sendJson(res, 200, { activity })
    return
  }
  if (parts[0] === 'v1') {
    sendJson(res, 404, { error: '找不到接口' })
    return
  }
  sendJson(res, 404, { error: '找不到接口' })
}

function authorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true
  const header = req.headers.authorization
  const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
  const extra = headerValue(req.headers['x-island-token'])
  return safeEqual(bearer, token) || safeEqual(extra, token)
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

function safeEqual(provided: string | undefined, expected: string): boolean {
  if (!provided) return false
  const left = Buffer.from(provided)
  const right = Buffer.from(expected)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 1_000_000) throw new ActivityError(413, '请求体过大')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new ActivityError(400, '无效的 JSON')
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

function broadcast(sockets: Set<WebSocket>, activities: Activity[]): void {
  const payload = JSON.stringify({ type: 'activities', activities })
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) socket.send(payload)
  }
}

function closeServer(
  httpServer: HttpServer,
  wss: WebSocketServer,
  sockets: Set<WebSocket>,
  unsubscribe: () => void
): Promise<void> {
  unsubscribe()
  for (const socket of sockets) socket.close()
  wss.close()
  return new Promise((resolve, reject) => {
    httpServer.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}
