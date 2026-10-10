// npm run build && node scripts/smoke-interaction.cjs
// Exercises the real Electron/preload/renderer path with a deterministic cursor.
// The fixture never moves the user's mouse and uses an isolated application profile.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const WebSocket = require('ws')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function fixture() {
  const { app, screen, BrowserWindow, Menu } = require('electron')
  await app.whenReady()
  let cursor = { x: -10000, y: -10000 }
  let reset
  screen.getCursorScreenPoint = () => cursor
  const buildMenu = Menu.buildFromTemplate.bind(Menu)
  Menu.buildFromTemplate = template => {
    reset = template.find(item => item.label === '恢复顶部居中')?.click ?? reset
    return buildMenu(template)
  }
  const server = require('node:http').createServer(async (request, response) => {
    if (request.method === 'POST') {
      if (request.url === '/reset') reset?.()
      else { let body = ''; for await (const part of request) body += part; cursor = JSON.parse(body) }
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ bounds: BrowserWindow.getAllWindows()[0]?.getBounds(), area: screen.getPrimaryDisplay().workArea }))
  }).listen(Number(process.env.ISLAND_FIXTURE_PORT), '127.0.0.1')
  app.on('will-quit', () => server.close())
  require('../out/main/index.js')
}

async function freePort() {
  const server = net.createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function until(check) {
  let last
  for (let i = 0; i < 100; i++) {
    try { const result = await check(); if (result) return result } catch (error) { last = error }
    await delay(100)
  }
  throw new Error(`Timed out: ${last?.message ?? 'condition unmet'}`)
}

async function smoke() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'island-interaction-'))
  const executable = require('electron')
  const [port, debugPort, fixturePort] = await Promise.all([freePort(), freePort(), freePort()])
  let child, socket, logs = ''
  const errors = []
  const start = () => {
    child = spawn(executable, [__filename, `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
        CUTE_ISLAND_PORT: String(port), ISLAND_FIXTURE_PORT: String(fixturePort), CUTE_ISLAND_WATCH: '0', CUTE_ISLAND_TOKEN: '', ELECTRON_RENDERER_URL: '' }
    })
    child.stderr.on('data', data => { logs += data })
    child.stdout.on('data', data => { logs += data })
  }
  const getWindow = async () => (await fetch(`http://127.0.0.1:${fixturePort}`)).json()
  const setCursor = async cursor => { await fetch(`http://127.0.0.1:${fixturePort}`, { method: 'POST', body: JSON.stringify(cursor) }); await delay(60) }
  const push = async body => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/activities`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal(response.status, 200)
    await delay(400)
  }
  const pointOf = bounds => ({ x: bounds.x, y: bounds.y })
  try {
    start()
    const page = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find(page => page.type === 'page'))
    socket = new WebSocket(page.webSocketDebuggerUrl)
    await once(socket, 'open')
    let next = 0
    const pending = new Map()
    socket.on('message', raw => {
      const message = JSON.parse(String(raw))
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
      const request = pending.get(message.id)
      if (request) { pending.delete(message.id); message.error ? request.reject(message.error) : request.resolve(message.result) }
    })
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++next; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }))
    })
    const evaluate = async expression => {
      const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails))
      return response.result.value
    }
    await send('Runtime.enable')
    await until(() => evaluate('!!window.island?.dragWindow && !!document.querySelector(".island")'))
    const opacity = () => evaluate('Number(getComputedStyle(document.querySelector(".island")).opacity)')
    const mode = () => evaluate('document.querySelector(".island").dataset.mode')
    const rect = selector => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height } })()`)
    const mouse = (type, point, buttons = 0) => send('Input.dispatchMouseEvent', { type, ...point, button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: 1 })
    const center = r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })
    const click = async selector => {
      const local = center(await rect(selector))
      const { bounds } = await getWindow()
      await setCursor({ x: bounds.x + local.x, y: bounds.y + local.y })
      await mouse('mouseMoved', local)
      await mouse('mousePressed', local, 1)
      await mouse('mouseReleased', local)
      await delay(400)
    }
    const drag = async (selector, delta) => {
      const local = center(await rect(selector))
      const { bounds } = await getWindow()
      const global = { x: bounds.x + local.x, y: bounds.y + local.y }
      await setCursor(global)
      await mouse('mouseMoved', local)
      await mouse('mousePressed', local, 1)
      await delay(60)
      await setCursor({ x: global.x + delta.x, y: global.y + delta.y })
      await mouse('mouseMoved', { x: local.x + Math.sign(delta.x) * 15, y: local.y + Math.sign(delta.y) * 15 }, 1)
      await delay(180)
      await mouse('mouseReleased', local)
      await delay(300)
      return bounds
    }
    const screenshot = async name => {
      await fs.mkdir('output/playwright', { recursive: true })
      const result = await send('Page.captureScreenshot', { format: 'png' })
      await fs.writeFile(`output/playwright/${name}.png`, Buffer.from(result.data, 'base64'))
    }
    const roundStart = Date.now() - 65_000
    await push({ id: 'drag', agent: 'Codex', client: 'Windows Terminal', startedAt: roundStart, state: 'running', title: '拖动与透明度验证', operation: { kind: 'command', command: 'npm run typecheck', shell: 'cmd' },
      tasks: [{ id: 'child', kind: 'agent', label: '检查代码', status: 'active', detail: '读取组件' },
        { id: 'command', kind: 'command', label: '类型检查', status: 'done' }] })
    assert.equal(await evaluate('document.querySelector(".task-badge").textContent.trim()'), '1')
    assert.equal(await evaluate('document.querySelector(".client-label").textContent'), 'Windows Terminal')
    const duration = () => evaluate('document.querySelector("[data-testid=execution-duration]").textContent')
    const initialDuration = await duration()
    assert.match(initialDuration, /^01:0[5-9]$/, 'Restores the recorded round start')
    await until(async () => (await duration()) !== initialDuration)
    await push({ id: 'drag', client: 'Windows Terminal' })
    assert.match(await duration(), /^01:/, 'Metadata updates do not restart timing')
    await until(async () => (await opacity()) < 0.7)
    await screenshot('drag-translucent')
    const original = pointOf((await getWindow()).bounds)
    const hoverPoint = center(await rect('.island'))
    await setCursor({ x: original.x + hoverPoint.x, y: original.y + hoverPoint.y })
    await mouse('mouseMoved', hoverPoint)
    await until(async () => (await opacity()) === 1)
    assert.equal(await mode(), 'compact', 'Hover solidifies without expanding')
    await setCursor({ x: -10000, y: -10000 })
    await mouse('mouseMoved', { x: 0, y: 550 })
    await until(async () => (await opacity()) < 0.7)
    await click('.island')
    assert.equal(await mode(), 'expanded', 'A light click expands the capsule')
    assert.equal(await evaluate('document.querySelector(".client-label").textContent'), 'Windows Terminal')
    assert.equal(await evaluate('document.querySelectorAll(".tasks li").length'), 2)
    assert.equal(await evaluate('document.querySelectorAll(".tasks li[data-status=active]").length'), 1)
    assert.deepEqual(pointOf((await getWindow()).bounds), original, 'A click does not move the window')
    await setCursor({ x: -10000, y: -10000 })
    await mouse('mouseMoved', { x: 0, y: 550 })
    assert.equal(await opacity(), 1, 'Expanded content stays solid after leaving')
    await screenshot('drag-solid')
    await push({ id: 'drag', tasks: null })
    assert.equal(await evaluate('document.querySelectorAll(".tasks, .task-badge").length'), 0)
    const beforeSelection = pointOf((await getWindow()).bounds)
    await drag('.command-code', { x: 70, y: 60 })
    assert.deepEqual(pointOf((await getWindow()).bounds), beforeSelection, 'Command selection does not move the window')
    await click('.expanded-head')
    assert.equal(await mode(), 'compact')
    await evaluate('document.activeElement.blur()')
    await setCursor({ x: -10000, y: -10000 })
    await mouse('mouseMoved', { x: 0, y: 550 })
    await until(async () => (await opacity()) < 0.7)
    const before = await drag('.compact', { x: 80, y: 110 })
    assert.deepEqual(pointOf((await getWindow()).bounds), { x: before.x + 80, y: before.y + 110 })
    assert.equal(await mode(), 'compact', 'Dropping does not trigger click-to-expand')
    let saved = JSON.parse(await fs.readFile(path.join(profile, 'window-position.json'), 'utf8'))
    assert.deepEqual(saved, pointOf((await getWindow()).bounds))
    await push({ id: 'second', agent: 'Gemini', state: 'thinking', title: '第二个会话' })
    assert.equal(await evaluate('document.querySelector("[data-session=second] .client-label").textContent'), '未知客户端')
    await push({ id: 'second', client: 'VS Code' })
    assert.equal(await evaluate('document.querySelector("[data-session=second] .client-label").textContent'), 'VS Code')
    assert.equal(await evaluate('document.querySelector("[data-session=drag] .client-label").textContent'), 'Windows Terminal')
    await screenshot('client-sessions')
    await push({ id: 'second', client: 'A custom client with a very long name that is truncated' })
    assert.ok(await evaluate('Array.from(document.querySelectorAll(".session-line")).every(row => row.scrollWidth <= row.clientWidth)'), 'Long client labels stay inside session rows')
    await push({ id: 'second', client: 'VS Code' })
    await drag('[data-session=drag] .session-line', { x: -30, y: 40 })
    assert.equal(await evaluate('document.querySelectorAll(".session-row.open").length'), 0, 'Dragging a session does not select it')
    await click('[data-session=drag] .session-line')
    assert.equal(await evaluate('document.querySelectorAll(".session-row.open").length'), 1)
    await push({ id: 'second', state: 'error', startedAt: roundStart, endedAt: roundStart + 42_000 })
    const secondDuration = () => evaluate('document.querySelector("[data-session=second] [data-testid=execution-duration]").textContent')
    assert.equal(await secondDuration(), '00:42')
    await delay(1100)
    assert.equal(await secondDuration(), '00:42', 'Finished execution time stays frozen')
    await push({ id: 'second', state: 'running', startedAt: Date.now() - 5000 })
    assert.match(await secondDuration(), /^00:0[5-9]$/, 'A new round restarts execution timing')
    await evaluate('window.island.dismiss("second")')
    await delay(400)
    const { bounds, area } = await getWindow()
    await drag('.compact', { x: 0, y: area.y + area.height - bounds.y - 30 })
    saved = JSON.parse(await fs.readFile(path.join(profile, 'window-position.json'), 'utf8'))
    await click('.compact')
    const expandedWindow = (await getWindow()).bounds
    const expandedRect = await rect('.island')
    assert.ok(expandedWindow.y + expandedRect.y + expandedRect.height <= area.y + area.height - 7, 'Expansion stays inside the work area')
    await click('.expanded-head')
    assert.deepEqual(pointOf((await getWindow()).bounds), saved, 'Collapse restores the chosen anchor')
    assert.deepEqual(errors, [])
    socket.terminate(); socket = undefined
    const exited = once(child, 'exit'); child.kill(); await exited
    start()
    await until(async () => (await getWindow()).bounds)
    await delay(500)
    assert.deepEqual(pointOf((await getWindow()).bounds), saved, 'Restart restores the saved position')
    await fetch(`http://127.0.0.1:${fixturePort}/reset`, { method: 'POST' })
    const reset = (await getWindow()).bounds
    assert.equal(reset.x, Math.round(area.x + (area.width - reset.width) / 2))
    assert.equal(reset.y, area.y + 4)
    console.log(JSON.stringify({ result: 'passed', executionTime: true, clientLabels: true, taskDisplay: true, nativeDrag: true, clickVsDrag: true, commandSelection: true, transparency: true, edgeExpansion: true, restartPersistence: true, trayReset: true, rendererErrors: errors }))
  } catch (error) {
    console.error(logs.slice(-2000)); throw error
  } finally {
    socket?.terminate()
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited }
    await delay(700)
    assert.equal(path.dirname(profile), path.resolve(os.tmpdir()))
    assert.ok(path.basename(profile).startsWith('island-interaction-'))
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
}

(process.versions.electron ? fixture() : smoke()).catch(error => { console.error(error); process.exitCode = 1 })
