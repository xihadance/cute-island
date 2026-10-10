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
  const { app, screen, BrowserWindow, Menu, ipcMain } = require('electron')
  await app.whenReady()
  let cursor = { x: -10000, y: -10000 }
  let reset
  let dragPhase = 'idle'
  let dragSequence = 0
  let ignoreMouse = true
  let modeMenu = []
  const setIgnoreMouse = BrowserWindow.prototype.setIgnoreMouseEvents
  BrowserWindow.prototype.setIgnoreMouseEvents = function (ignore, ...args) {
    ignoreMouse = ignore
    return setIgnoreMouse.call(this, ignore, ...args)
  }
  ipcMain.on('island:drag', (_event, phase) => { dragPhase = phase; dragSequence++ })
  screen.getCursorScreenPoint = () => cursor
  const buildMenu = Menu.buildFromTemplate.bind(Menu)
  Menu.buildFromTemplate = template => {
    reset = template.find(item => item.label === '恢复顶部居中')?.click ?? reset
    if (template.some(item => item.label === '托管模式')) modeMenu = template
    return buildMenu(template)
  }
  const server = require('node:http').createServer(async (request, response) => {
    if (request.method === 'POST') {
      if (request.url === '/reset') reset?.()
      else if (request.url === '/mode/managed') modeMenu.find(item => item.label === '托管模式')?.click()
      else if (request.url === '/mode/focus') modeMenu.find(item => item.label === '关注模式')?.click()
      else { let body = ''; for await (const part of request) body += part; cursor = JSON.parse(body) }
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ bounds: BrowserWindow.getAllWindows()[0]?.getBounds(), area: screen.getPrimaryDisplay().workArea,
      dragPhase, dragSequence, ignoreMouse, mode: modeMenu.find(item => item.checked)?.label }))
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
      const { bounds, dragSequence } = await getWindow()
      const global = { x: bounds.x + local.x, y: bounds.y + local.y }
      await setCursor(global)
      await mouse('mouseMoved', local)
      await mouse('mousePressed', local, 1)
      // Wait for the main process to sample the origin before moving its fake cursor.
      // Selection surfaces intentionally do not start a window drag.
      if (selector !== '.command-code') await until(async () => {
        const state = await getWindow()
        return state.dragSequence > dragSequence && state.dragPhase === 'start'
      })
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
    const taskStart = Date.now() - 45_000
    await push({ id: 'drag', agent: 'Codex', client: 'Windows Terminal', startedAt: roundStart, state: 'running', title: '拖动与透明度验证', operation: { kind: 'command', command: 'npm run typecheck', shell: 'cmd' },
      tasks: [{ id: 'child', kind: 'agent', label: '检查代码', status: 'active', state: 'thinking', detail: '读取组件', startedAt: taskStart },
        { id: 'command', kind: 'command', label: '类型检查', status: 'done', startedAt: taskStart, endedAt: taskStart + 42_000 }] })
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
    const taskDuration = id => evaluate(`document.querySelector('[data-task="${id}"] [data-testid="task-execution-duration"]').textContent`)
    assert.equal(await evaluate('document.querySelector("[data-task=child] [data-testid=task-status]").textContent'), '思考中')
    assert.equal(await evaluate('document.querySelector("[data-task=command] [data-testid=task-status]").textContent'), '已完成')
    assert.equal(await taskDuration('command'), '00:42')
    const firstTaskTime = await taskDuration('child')
    await until(async () => await taskDuration('child') !== firstTaskTime)
    assert.equal(await taskDuration('command'), '00:42', 'Completed task time stays frozen while other children run')
    await screenshot('subagent-status-time')
    await push({ id: 'drag', tasks: [
      { id: 'child', kind: 'agent', label: '检查代码', status: 'active', state: 'running', detail: '正在运行测试' },
      { id: 'command', kind: 'command', label: '类型检查', status: 'done' }
    ] })
    assert.equal((await evaluate('window.island.getActivities()')).find(item => item.id === 'drag').tasks[0].startedAt, taskStart,
      'Task detail and state updates keep the original execution start')
    assert.equal(await evaluate('document.querySelector("[data-task=child] [data-testid=task-status]").textContent'), '执行中')
    await push({ id: 'drag', tasks: [{ id: 'child', kind: 'agent', label: '检查代码', status: 'done', endedAt: taskStart + 44_000 }] })
    assert.equal(await taskDuration('child'), '00:44')
    await delay(1100)
    assert.equal(await taskDuration('child'), '00:44', 'A child execution freezes at its recorded end')
    await push({ id: 'drag', tasks: [
      { id: 'legacy', kind: 'agent', label: '没有完整时间记录的长名称子 Agent', status: 'stopped' },
      { id: 'missing-end', kind: 'agent', label: '未记录结束时间', status: 'done', startedAt: taskStart }
    ] })
    assert.equal(await taskDuration('legacy'), '未记录')
    assert.equal(await taskDuration('missing-end'), '未记录', 'A finished task with no end timestamp must not keep counting')
    assert.ok(await evaluate('Array.from(document.querySelectorAll(".tasks li")).every(row => row.scrollWidth <= row.clientWidth)'),
      'Task name, status and duration stay within the row')
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
    const { area } = await getWindow()
    const globalRect = async () => {
      const r = await rect('.island')
      const { bounds } = await getWindow()
      return { ...r, x: r.x + bounds.x, y: r.y + bounds.y }
    }
    const dragTo = async destination => {
      const current = center(await globalRect())
      await drag('.island', { x: destination.x - current.x, y: destination.y - current.y })
      await delay(300)
    }
    for (const edge of ['top', 'left', 'right', 'bottom']) {
      const r = await rect('.island')
      const target = { x: area.x + area.width / 2, y: area.y + area.height / 2 }
      if (edge === 'top') target.y = area.y + r.height / 2 + 8
      if (edge === 'bottom') target.y = area.y + area.height - r.height / 2 - 8
      if (edge === 'left') target.x = area.x + r.width / 2 + 8
      if (edge === 'right') target.x = area.x + area.width - r.width / 2 - 8
      await dragTo(target)
      assert.equal(await mode(), 'docked', `${edge} drop collapses the capsule without a click`)
      assert.equal(await evaluate('document.querySelector(".island").dataset.dockEdge'), edge)
      const handle = await globalRect()
      assert.ok(handle.width <= 73 && handle.height <= 73, 'Docked content leaves only a small handle')
      const distance = edge === 'top' ? handle.y - area.y : edge === 'left' ? handle.x - area.x :
        edge === 'right' ? area.x + area.width - handle.x - handle.width : area.y + area.height - handle.y - handle.height
      assert.ok(Math.abs(distance) <= 1, `${edge} handle is flush with the work area: ${distance}`)
      await setCursor(center(handle))
      await delay(250)
      assert.equal(await mode(), 'docked', 'Hover does not open the handle')
      await screenshot(`dock-${edge}`)
      await push({ id: 'drag', title: `边缘收纳 ${edge}` })
      assert.equal(await mode(), 'docked', 'Activity updates preserve explicit edge collapse')
      await click('.island')
      assert.equal(await mode(), 'expanded', 'One click reveals activity details')
      const open = await globalRect()
      assert.ok(open.x >= area.x && open.y >= area.y && open.x + open.width <= area.x + area.width + 1 &&
        open.y + open.height <= area.y + area.height + 1, 'Details open inward and stay visible')
      await screenshot(`dock-${edge}-expanded`)
      await click('.expanded-head')
      assert.equal(await mode(), 'docked', 'Clicking the capsule again restores the handle')
      if (edge === 'top') {
        await dragTo({ x: area.x + area.width / 2, y: area.y + area.height - 16 })
        assert.equal(await mode(), 'docked')
        const movedHandle = await globalRect()
        assert.ok(Math.abs(movedHandle.y + movedHandle.height - area.y - area.height) <= 1,
          'Moving a handle to the opposite edge docks even without a size change')
      }
      if (edge !== 'bottom') {
        await dragTo({ x: area.x + area.width / 2, y: area.y + area.height / 2 })
        assert.notEqual(await mode(), 'docked', 'Dragging the handle away undocks it')
        assert.equal(await evaluate('document.querySelector(".island").dataset.dockEdge ?? null'), null)
        if (await mode() === 'expanded') await click('.expanded-head')
      }
    }
    await push({ id: 'stack-dock', agent: 'Gemini', state: 'running', title: '收纳时新增会话' })
    assert.equal(await mode(), 'docked', 'A new session does not expand a docked island')
    await click('.island')
    assert.equal(await mode(), 'stack')
    await click('[data-session=drag] .session-line')
    assert.equal(await evaluate('document.querySelectorAll(".session-row.open").length'), 1)
    await evaluate('document.querySelector(".session-line").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))')
    await delay(500)
    assert.equal(await mode(), 'docked', 'Escape also works from a session control')
    await evaluate('window.island.dismiss("stack-dock")')
    await push({ id: 'drag', state: 'approval' })
    assert.equal(await mode(), 'docked', 'Approval changes the handle status without forcing it open')
    await click('.island')
    assert.equal(await mode(), 'expanded')
    await mouse('mousePressed', { x: 0, y: 550 }, 1)
    await mouse('mouseReleased', { x: 0, y: 550 })
    await delay(500)
    assert.equal(await mode(), 'docked', 'Clicking outside re-docks the island')
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await click('.island')
    assert.equal(await mode(), 'expanded', 'Reduced motion retains click-to-expand')
    await evaluate('document.querySelector(".island").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))')
    await delay(200)
    assert.equal(await mode(), 'docked', 'Escape restores the handle')
    await evaluate('document.querySelector(".island").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))')
    await delay(200)
    assert.equal(await mode(), 'expanded', 'Keyboard activation opens the handle')
    await click('.expanded-head')
    await evaluate('window.island.dismiss("drag")')
    await delay(200)
    assert.equal(await mode(), 'docked', 'An empty island stays docked')
    await click('.island')
    assert.equal(await mode(), 'idle', 'An empty handle still opens')
    await click('.island')
    assert.equal(await mode(), 'docked')

    const setMode = async value => {
      await fetch(`http://127.0.0.1:${fixturePort}/mode/${value}`, { method: 'POST' })
      await until(async () => await evaluate('document.querySelector(".island").dataset.behavior') === value)
      await delay(300)
    }
    await setMode('managed')
    assert.equal((await getWindow()).mode, '托管模式', 'The tray reflects the active mode')
    await push({ id: 'routine', agent: 'Gemini', state: 'running', title: '无需打扰的正常会话' })
    assert.equal(await mode(), 'docked')
    await click('.island')
    assert.equal(await mode(), 'docked', 'Quiet managed content cannot be clicked')
    assert.equal((await getWindow()).ignoreMouse, true, 'Hover and click keep native mouse passthrough enabled')
    assert.ok(await opacity() < 0.3, 'Managed hover stays more transparent than focus mode')
    const passiveBounds = pointOf((await getWindow()).bounds)
    await evaluate('window.island.setIgnoreMouse(false); window.island.dragWindow("start"); window.island.dragWindow("move"); window.island.dragWindow("end")')
    await delay(100)
    assert.equal((await getWindow()).ignoreMouse, true, 'Renderer requests cannot disable passive mouse passthrough')
    assert.deepEqual(pointOf((await getWindow()).bounds), passiveBounds, 'Passive drag requests cannot move the native window')
    await screenshot('managed-passive')

    await push({ id: 'needs-action', agent: 'Codex', state: 'approval', title: '安装依赖需要审批', operation: { kind: 'command', command: 'npm install' } })
    assert.equal(await mode(), 'expanded', 'A managed alert temporarily opens the edge handle')
    assert.equal(await opacity(), 1)
    assert.equal(await evaluate('document.querySelector(".island").textContent.includes("无需打扰的正常会话")'), false,
      'Only actionable sessions are shown during a managed alert')
    await click('.managed-notice strong')
    assert.equal((await getWindow()).ignoreMouse, false, 'The alert itself accepts clicks')
    const alertBounds = (await getWindow()).bounds
    await setCursor({ x: alertBounds.x, y: alertBounds.y + 500 })
    assert.equal((await getWindow()).ignoreMouse, true, 'Transparent space remains click-through during alerts')
    await screenshot('managed-approval')
    await click('[data-testid=acknowledge-attention]')
    assert.equal(await mode(), 'docked')
    assert.equal((await getWindow()).ignoreMouse, true)
    assert.ok((await evaluate('window.island.getActivities()')).some(item => item.id === 'needs-action'), 'Acknowledging retains the session')
    await push({ id: 'needs-action', client: 'VS Code', progress: 0.5 })
    assert.equal(await mode(), 'docked', 'Metadata updates do not replay an acknowledged alert')
    await push({ id: 'needs-action', operation: { kind: 'command', command: 'npm publish' } })
    assert.equal(await mode(), 'expanded', 'A different approval request alerts again')
    await push({ id: 'needs-action', state: 'running' })
    assert.equal(await mode(), 'docked', 'Resolving the request restores passive edge docking')

    await push({ id: 'human-input', agent: 'Claude Code', state: 'running', title: '请选择实现方案', operation: { kind: 'tool', name: 'AskUserQuestion' } })
    assert.equal(await mode(), 'expanded', 'A recorded human-input request needs attention')
    await push({ id: 'failure', agent: 'Cursor', state: 'error', title: '会话执行失败' })
    assert.equal(await mode(), 'stack')
    assert.equal(await evaluate('document.querySelectorAll(".session-row").length'), 2, 'Normal sessions stay out of the actionable list')
    await screenshot('managed-sessions')
    await click('[data-testid=acknowledge-attention]')
    assert.equal(await mode(), 'expanded', 'Acknowledging one alert keeps the other visible')
    await click('[data-testid=acknowledge-attention]')
    assert.equal(await mode(), 'docked')
    await push({ id: 'routine', tasks: [{ id: 'child-error', kind: 'agent', label: '子 Agent 审查失败', status: 'error' }] })
    assert.equal(await mode(), 'expanded', 'A failed background task alerts even when its parent is running')
    await click('[data-testid=acknowledge-attention]')
    await push({ id: 'routine', tasks: [{ id: 'child-approval', kind: 'agent', label: '子 Agent 安装依赖', status: 'active', state: 'approval', startedAt: Date.now() - 5000 }] })
    assert.equal(await mode(), 'expanded', 'An approval inside a child session alerts the managed parent')
    assert.equal(await evaluate('document.querySelector(".managed-notice strong").textContent'), '子 Agent 需要审批')
    assert.equal(await evaluate('document.querySelector("[data-task=child-approval] [data-testid=task-status]").textContent'), '需要审批')
    await screenshot('subagent-approval')
    await click('[data-testid=acknowledge-attention]')
    await setMode('focus')
    assert.equal((await getWindow()).mode, '关注模式')
    await click('.island')
    assert.equal(await mode(), 'stack', 'Focus mode restores the existing click-to-open session list')
    assert.equal(await evaluate('document.querySelectorAll(".session-row").length'), 4)
    await setMode('managed')
    assert.equal(await evaluate('document.querySelector(".island").dataset.passive'), 'true')
    assert.equal((await getWindow()).ignoreMouse, true, 'Switching from expanded focus immediately releases desktop input')
    for (const id of ['routine', 'needs-action', 'human-input', 'failure']) await evaluate(`window.island.dismiss(${JSON.stringify(id)})`)
    // Restore the same edge anchor after the focus-mode interaction above.
    await setMode('focus')
    await evaluate('window.island.setDockExpanded(false)')
    await setMode('managed')
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(profile, 'preferences.json'), 'utf8')), { mode: 'managed' })
    await send('Page.reload')
    await until(async () => (await mode()) === 'docked')
    await delay(500)
    saved = JSON.parse(await fs.readFile(path.join(profile, 'window-position.json'), 'utf8'))
    assert.equal(saved.dock.edge, 'bottom')
    const savedBounds = pointOf((await getWindow()).bounds)
    assert.deepEqual(errors, [])
    socket.terminate(); socket = undefined
    const exited = once(child, 'exit'); child.kill(); await exited
    start()
    await until(async () => (await getWindow()).bounds)
    await delay(500)
    assert.deepEqual(pointOf((await getWindow()).bounds), savedBounds, 'Restart restores the saved edge handle')
    assert.equal((await getWindow()).mode, '托管模式', 'Restart restores the selected mode in the tray')
    assert.equal((await getWindow()).ignoreMouse, true, 'Managed startup remains click-through')
    await fetch(`http://127.0.0.1:${fixturePort}/reset`, { method: 'POST' })
    await delay(600)
    const reset = (await getWindow()).bounds
    assert.equal(reset.x, Math.round(area.x + (area.width - reset.width) / 2))
    assert.equal(reset.y, area.y + 4)
    console.log(JSON.stringify({ result: 'passed', executionTime: true, clientLabels: true, taskDisplay: true, taskTiming: true, childApproval: true, nativeDrag: true, clickVsDrag: true, commandSelection: true, transparency: true, fourEdgeDocking: true, undocking: true, edgeExpansion: true, keyboard: true, reducedMotion: true, managedPassthrough: true, managedAlerts: true, alertAcknowledgment: true, trayModes: true, modePersistence: true, restartPersistence: true, trayReset: true, rendererErrors: errors }))
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
