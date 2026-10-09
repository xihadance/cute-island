import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, screen } from 'electron'
import path from 'node:path'
import { SessionWatcher } from '../agents/watch'
import { ActivityStore } from '../shared/activity'
import { DEMO_ID, demoFrames, playDemoFrames } from '../shared/demo'
import { startStatusServer, type StatusServer } from './server'
import { TRAY_ICON } from './tray-icon'
import { constrainPosition, positionAfterDrag, type Point } from '../shared/window-position'
import { readWindowPosition, saveWindowPosition } from './window-position'

const WINDOW_WIDTH = 460
const WINDOW_HEIGHT = 560

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let server: StatusServer | null = null
let store: ActivityStore | null = null
let watcher: SessionWatcher | null = null
let demoToken = 0
let preferredPosition: Point | undefined

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-transparent-visuals')
}
if (process.env.CUTE_ISLAND_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
}
if (process.env.CUTE_ISLAND_NO_SANDBOX === '1') {
  app.commandLine.appendSwitch('no-sandbox')
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    reveal()
  })
  app.whenReady().then(boot).catch((error: unknown) => {
    console.error(error)
    app.exit(1)
  })
}

function readPort(): number {
  const raw = process.env.CUTE_ISLAND_PORT ?? '17321'
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`CUTE_ISLAND_PORT 无效: ${raw}`)
  }
  return port
}

async function boot(): Promise<void> {
  if (process.platform === 'win32') app.setAppUserModelId('com.cuteisland.app')
  store = new ActivityStore()
  const port = readPort()
  try {
    server = await startStatusServer(store, {
      port,
      token: process.env.CUTE_ISLAND_TOKEN
    })
  } catch (error) {
    dialog.showErrorBox('Cute Island', `状态服务启动失败（端口 ${port}）。\n${errorText(error)}`)
    app.quit()
    return
  }
  console.log(`Cute Island 正在监听 http://127.0.0.1:${server.port}`)
  if (process.env.CUTE_ISLAND_WATCH !== '0') {
    watcher = new SessionWatcher(store)
    watcher.start()
  }
  preferredPosition = readWindowPosition(positionFile())
  mainWindow = createWindow(store)
  tray = createTray()
  wireIpc(store)
  app.on('before-quit', () => {
    watcher?.stop()
    tray?.destroy()
    store?.dispose()
    void server?.close()
  })
  app.on('activate', () => reveal())
  app.on('window-all-closed', () => {
    app.quit()
  })
}

function createWindow(activityStore: ActivityStore): BrowserWindow {
  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    focusable: false,
    hasShadow: false,
    thickFrame: false,
    backgroundColor: '#00000000',
    type: process.platform === 'darwin' ? 'panel' : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  if (process.platform === 'darwin') win.setWindowButtonVisibility(false)
  placeWindow(win)
  ignoreMouse(win, true)
  const stopTracking = trackPointer(win)
  win.on('closed', () => {
    stopTracking()
    unsubscribe()
    if (mainWindow === win) mainWindow = null
  })
  const unsubscribe = activityStore.subscribe((activities) => {
    if (!win.isDestroyed()) win.webContents.send('island:activities', activities)
  })
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.showInactive()
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  return win
}

function defaultPosition(): Point {
  const { workArea } = screen.getPrimaryDisplay()
  return {
    x: Math.round(workArea.x + (workArea.width - WINDOW_WIDTH) / 2),
    y: workArea.y + 4
  }
}

function positionFile(): string {
  return path.join(app.getPath('userData'), 'window-position.json')
}

function placeWindow(win: BrowserWindow, content = { x: 167, y: 8, width: 126, height: 36 }): void {
  const desired = preferredPosition ?? defaultPosition()
  const display = screen.getDisplayNearestPoint({ x: desired.x + WINDOW_WIDTH / 2, y: desired.y + content.y })
  const next = constrainPosition(desired, content, display.workArea)
  const current = win.getBounds()
  if (current.x !== next.x || current.y !== next.y) win.setPosition(next.x, next.y)
}

function createTray(): Tray {
  const icon = nativeImage.createFromDataURL(TRAY_ICON)
  if (process.platform === 'darwin') icon.setTemplateImage(true)
  const next = new Tray(icon)
  next.setToolTip('Cute Island')
  const menu = Menu.buildFromTemplate([
    { label: '显示灵动岛', click: () => reveal() },
    { label: '隐藏灵动岛', click: () => mainWindow?.hide() },
    { label: '恢复顶部居中', click: () => {
      preferredPosition = defaultPosition()
      saveWindowPosition(positionFile(), preferredPosition)
      if (mainWindow && !mainWindow.isDestroyed()) placeWindow(mainWindow)
      reveal()
    } },
    { label: '播放演示', click: () => void playDemo() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ])
  next.setContextMenu(menu)
  next.on('click', () => reveal())
  return next
}

function ignoreMouse(win: BrowserWindow, ignore: boolean): void {
  if (win.isDestroyed()) return
  // Passing { forward: true } installs a global mouse hook. On Windows that hook
  // runs on this process, so any pause here makes the cursor stutter everywhere.
  win.setIgnoreMouseEvents(ignore)
}

function reveal(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.showInactive()
}

interface Interaction {
  expanded: boolean
  x: number
  y: number
  width: number
  height: number
}

function trackPointer(win: BrowserWindow): () => void {
  let interaction: Interaction = { expanded: false, x: 0, y: 0, width: 0, height: 0 }
  let ignoring = true
  let lastPointer = ''
  let drag: { start: Point; origin: Point; active: boolean } | undefined
  const applyDrag = (): void => {
    if (!drag?.active || win.isDestroyed()) return
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const position = constrainPosition(positionAfterDrag(drag.origin, drag.start, cursor), interaction, display.workArea)
    const current = win.getBounds()
    if (current.x !== position.x || current.y !== position.y) win.setPosition(position.x, position.y)
  }
  const endDrag = (): void => {
    if (drag?.active && !win.isDestroyed()) {
      applyDrag()
      const { x, y } = win.getBounds()
      preferredPosition = { x, y }
      saveWindowPosition(positionFile(), preferredPosition)
    }
    drag = undefined
  }
  const onDrag = (event: Electron.IpcMainEvent, phase: unknown): void => {
    if (win.isDestroyed() || event.sender !== win.webContents) return
    if (phase === 'start') {
      const { x, y } = win.getBounds()
      drag = { start: screen.getCursorScreenPoint(), origin: { x, y }, active: false }
      ignoring = false
      ignoreMouse(win, false)
    } else if (phase === 'move' && drag) {
      drag.active = true
      applyDrag()
    } else if (phase === 'end') endDrag()
  }
  const onInteraction = (_event: Electron.IpcMainEvent, payload: unknown): void => {
    if (!isInteraction(payload) || win.isDestroyed() || _event.sender !== win.webContents) return
    interaction = payload
    if (!drag && interaction.width > 0) placeWindow(win, interaction)
  }
  const reposition = (): void => {
    if (!win.isDestroyed() && !drag) placeWindow(win, interaction)
  }
  ipcMain.on('island:drag', onDrag)
  ipcMain.on('island:interaction', onInteraction)
  screen.on('display-metrics-changed', reposition)
  screen.on('display-added', reposition)
  screen.on('display-removed', reposition)
  win.on('hide', endDrag)
  win.webContents.on('render-process-gone', endDrag)
  const timer = setInterval(() => {
    if (win.isDestroyed() || !win.isVisible()) return
    applyDrag()
    const point = screen.getCursorScreenPoint()
    const bounds = win.getBounds()
    const localX = point.x - bounds.x
    const localY = point.y - bounds.y
    const overWindow = localX >= 0 && localY >= 0 && localX <= bounds.width && localY <= bounds.height
    const overIsland =
      interaction.width > 0 &&
      localX >= interaction.x &&
      localY >= interaction.y &&
      localX <= interaction.x + interaction.width &&
      localY <= interaction.y + interaction.height
    const ignore = drag || interaction.expanded ? false : !overIsland
    if (ignore !== ignoring) {
      ignoring = ignore
      ignoreMouse(win, ignore)
    }
    // The renderer only uses proximity to the top edge, not every global movement.
    const nearTop = overWindow && localY <= 72
    const pointerKey = `${nearTop}:${overIsland}`
    if (pointerKey === lastPointer || win.webContents.isDestroyed()) return
    lastPointer = pointerKey
    win.webContents.send('island:pointer', { x: localX, y: localY, overWindow, overIsland })
  }, 32)
  return () => {
    clearInterval(timer)
    ipcMain.removeListener('island:drag', onDrag)
    ipcMain.removeListener('island:interaction', onInteraction)
    screen.off('display-metrics-changed', reposition)
    screen.off('display-added', reposition)
    screen.off('display-removed', reposition)
  }
}

function isInteraction(value: unknown): value is Interaction {
  if (!value || typeof value !== 'object') return false
  const hit = value as Partial<Interaction>
  return (
    typeof hit.expanded === 'boolean' &&
    Number.isFinite(hit.x) && Number.isFinite(hit.y) &&
    typeof hit.width === 'number' && Number.isFinite(hit.width) && hit.width >= 0 &&
    typeof hit.height === 'number' && Number.isFinite(hit.height) && hit.height >= 0
  )
}

function wireIpc(activityStore: ActivityStore): void {
  ipcMain.on('island:set-ignore-mouse', (event, ignore: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    if (ignore === true || ignore === false) ignoreMouse(win, ignore)
  })
  ipcMain.handle('island:get-activities', () => activityStore.list())
  ipcMain.handle('island:dismiss', (_event, id: unknown) => {
    if (typeof id === 'string') activityStore.dismiss(id)
  })
  ipcMain.handle('island:play-demo', () => {
    void playDemo()
  })
}

async function playDemo(): Promise<void> {
  if (!store) return
  const token = ++demoToken
  store.dismiss(DEMO_ID)
  await playDemoFrames(
    demoFrames,
    (frame) => {
      if (!store) return
      if (frame.upsert) store.upsert(frame.upsert)
      if (frame.end) {
        try {
          store.end(frame.end.id, frame.end)
        } catch {
          // The activity can disappear if a newer demo replaced it.
        }
      }
    },
    () => token !== demoToken
  )
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误'
}
