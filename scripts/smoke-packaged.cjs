// Exercises the actual packaged Electron app, preload bridge and local API.
// Usage: node scripts/smoke-packaged.cjs "release/win-unpacked/Cute Island.exe" [--baseline]
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')
const WebSocket = require('ws')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function freePort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}
async function until(check, timeout = 30_000) {
  const deadline = Date.now() + timeout
  let error
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value } catch (caught) { error = caught }
    await delay(100)
  }
  throw new Error(`Timed out waiting for packaged app: ${error?.message ?? 'condition unmet'}`)
}
function connect(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let sequence = 0
  const errors = []
  socket.on('message', (raw) => {
    const data = JSON.parse(String(raw))
    if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.text)
    const waiting = pending.get(data.id)
    if (!waiting) return
    pending.delete(data.id)
    data.error ? waiting.reject(new Error(data.error.message)) : waiting.resolve(data.result)
  })
  return {
    socket, errors,
    async send(method, params = {}) {
      if (socket.readyState === WebSocket.CONNECTING) await once(socket, 'open')
      return new Promise((resolve, reject) => {
        const id = ++sequence
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
    }
  }
}

async function main() {
  const executable = path.resolve(process.argv[2] ?? 'release/win-unpacked/Cute Island.exe')
  const baseline = process.argv.includes('--baseline')
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cute-island-smoke-'))
  const [port, debugPort] = await Promise.all([freePort(), freePort()])
  const claude = path.join(temporary, '.claude')
  const transcript = path.join(claude, 'projects', 'fixture', 'before-start.jsonl')
  const agentScript = path.join(temporary, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
  await fs.mkdir(path.dirname(agentScript), { recursive: true })
  await fs.writeFile(agentScript, 'setInterval(() => {}, 1000)')
  await fs.mkdir(path.dirname(transcript), { recursive: true })
  await fs.writeFile(transcript, JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'slow', name: 'Bash', input: { description: '启动前的长任务' } }
  ] } }) + '\n')
  const old = new Date(Date.now() - 20 * 60_000)
  await fs.utimes(transcript, old, old)
  const agent = spawn(process.execPath, [agentScript], { windowsHide: true, stdio: 'ignore' })
  const app = spawn(executable, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(temporary, 'profile')}`], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CUTE_ISLAND_PORT: String(port), CUTE_ISLAND_WATCH: '1', CUTE_ISLAND_TOKEN: '',
      CLAUDE_CONFIG_DIR: claude, CODEX_HOME: path.join(temporary, '.codex'),
      GEMINI_CLI_HOME: path.join(temporary, '.gemini'), CURSOR_HOME: path.join(temporary, '.cursor') }
  })
  let logs = ''
  app.stderr.on('data', (data) => { logs += data })
  app.stdout.on('data', (data) => { logs += data })
  app.on('error', (error) => { logs += error.message })
  let cdp
  try {
    const page = await until(async () => {
      const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()
      return pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
    })
    cdp = connect(page.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    const evaluate = async (expression) => {
      const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
      return result.result.value
    }
    await until(() => evaluate('!!window.island && !!document.querySelector("[data-testid=island]")'))
    const list = async () => (await (await fetch(`http://127.0.0.1:${port}/v1/activities`)).json()).activities
    const post = async (pathname, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
      })
      assert.equal(response.status, 200)
    }
    let recovered = false
    if (!baseline) {
      await until(async () => (await list()).some((item) => item.id === 'claude-before-start' && item.state === 'running'))
      recovered = true
    }
    await evaluate('window.island.dismiss("claude-before-start")')
    await delay(3500)
    const idleLayoutReads = await evaluate(`new Promise(resolve => {
      const original = Element.prototype.getBoundingClientRect;
      let count = 0;
      Element.prototype.getBoundingClientRect = function() { count++; return original.call(this) };
      setTimeout(() => { Element.prototype.getBoundingClientRect = original; resolve(count) }, 1500);
    })`)
    await post('/v1/activities', { id: 'smoke', agent: 'Codex', state: 'running', title: '打包验证', detail: '验证 IPC 和 HTTP', progress: 0.4 })
    await until(() => evaluate('document.querySelector("[data-testid=island]")?.dataset.mode === "compact"'))
    await evaluate('document.querySelector("[data-testid=island]").click()')
    await until(() => evaluate('document.querySelector("[data-testid=island]")?.dataset.mode === "expanded"'))
    await post('/v1/activities', { id: 'second', agent: 'Gemini', state: 'error', title: '可关闭的错误' })
    await until(() => evaluate('document.querySelectorAll("[data-testid=session-row]").length === 2'))
    await delay(800)
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    await fs.mkdir('release', { recursive: true })
    await fs.writeFile(`release/smoke-${baseline ? 'baseline' : 'optimized'}.png`, Buffer.from(screenshot.data, 'base64'))
    await evaluate('window.island.dismiss("second")')
    await post('/v1/activities/smoke/end', { result: 'success', summary: '验证完成' })
    await until(async () => (await list()).length === 0)
    assert.deepEqual(cdp.errors, [])
    if (!baseline) assert.equal(idleLayoutReads, 0, 'Idle UI should not poll layout')
    console.log(JSON.stringify({ baseline, recoveredBeforeStartup: recovered, idleLayoutReadsIn1500ms: idleLayoutReads, api: 'passed', preload: 'passed', interactions: 'passed', rendererErrors: cdp.errors }))
  } catch (error) {
    console.error(logs.slice(-3000))
    throw error
  } finally {
    // Only terminate processes started by this script; leave existing app instances alone.
    if (cdp) { cdp.socket.terminate() }
    app.kill()
    agent.kill()
    await delay(700)
    // Chromium may retain a handle briefly during process shutdown.
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()))
    assert.ok(path.basename(temporary).startsWith('cute-island-smoke-'))
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
