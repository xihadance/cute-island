import { useEffect, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { constrainPosition, dockAfterDrag, dockedPosition, DRAG_THRESHOLD, isEdgeDock, isPoint, positionAfterDrag, type DockState, type Point, type WindowPosition } from '../../shared/window-position'
import type { IslandApi } from './env'

const POSITION_KEY = 'cute-island-position'

function readPreviewPosition(): WindowPosition {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(POSITION_KEY) ?? 'null')
    if (isPoint(saved)) return { x: saved.x, y: saved.y, ...('dock' in saved && isEdgeDock(saved.dock) ? { dock: saved.dock } : {}) }
  } catch { /* Storage may be unavailable in an embedded preview. */ }
  return { x: 0, y: 0 }
}

export function useIslandDrag(bridge: IslandApi, enabled = true, revealDock = false) {
  const [initial] = useState<WindowPosition>(() => bridge.dragWindow ? { x: 0, y: 0 } : readPreviewPosition())
  const [offset, setOffset] = useState<Point>(initial)
  const [dragging, setDragging] = useState(false)
  const [dock, setDock] = useState<DockState>({ edge: initial.dock?.edge ?? null, collapsed: !!initial.dock })
  const dockRef = useRef(dock)
  const preferred = useRef(initial)
  const current = useRef(offset)
  const gesture = useRef<{ id: number; start: Point; origin: Point; element: HTMLElement; moved: boolean } | null>(null)
  const suppressClick = useRef(false)

  useEffect(() => {
    let active = true
    let received = false
    const stop = bridge.onDock?.((next) => {
      received = true
      dockRef.current = next
      setDock(next)
    })
    void bridge.getDock?.().then((next) => {
      if (active && !received) { dockRef.current = next; setDock(next) }
    }).catch(console.error)
    return () => { active = false; stop?.() }
  }, [bridge])

  useEffect(() => {
    const previewArea = () => ({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight })
    const previewContent = () => {
      const rect = document.querySelector<HTMLElement>('[data-testid="island"]')?.getBoundingClientRect()
      return rect ? { x: (window.innerWidth - rect.width) / 2, y: 8, width: rect.width, height: rect.height } : undefined
    }
    const fitPreview = (position: Point): Point => {
      const content = previewContent()
      if (!content) return position
      const anchor = preferred.current.dock
      return anchor && !gesture.current
        ? dockedPosition(anchor, content, previewArea(), dockRef.current.collapsed && !revealDock)
        : constrainPosition(position, content, previewArea())
    }
    const applyOffset = (position: Point): void => {
      current.current = position
      setOffset((previous) => previous.x === position.x && previous.y === position.y ? previous : position)
    }
    const move = (event: PointerEvent): void => {
      const active = gesture.current
      if (!active || event.pointerId !== active.id) return
      if (event.buttons === 0) { finish(); return }
      const cursor = { x: event.screenX, y: event.screenY }
      if (!active.moved && Math.hypot(cursor.x - active.start.x, cursor.y - active.start.y) < DRAG_THRESHOLD) return
      if (!active.moved) {
        active.moved = true
        suppressClick.current = true
        setDragging(true)
        active.element.setPointerCapture(event.pointerId)
      }
      if (bridge.dragWindow) bridge.dragWindow('move')
      else applyOffset(fitPreview(positionAfterDrag(active.origin, active.start, cursor)))
    }
    const finish = (): void => {
      const active = gesture.current
      if (!active) return
      gesture.current = null
      bridge.dragWindow?.('end')
      if (active.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id)
      if (active.moved && !bridge.dragWindow) {
        const content = previewContent()
        const anchor = content ? dockAfterDrag(current.current, content, previewArea()) : undefined
        preferred.current = { ...current.current, ...(anchor ? { dock: anchor } : {}) }
        const next = { edge: anchor?.edge ?? null, collapsed: !!anchor }
        dockRef.current = next
        setDock(next)
        try { localStorage.setItem(POSITION_KEY, JSON.stringify(preferred.current)) } catch { /* Optional preview persistence. */ }
        applyOffset(fitPreview(preferred.current))
      }
      setDragging(false)
    }
    const finishPointer = (event: PointerEvent): void => {
      if (event.pointerId === gesture.current?.id) finish()
    }
    const fit = (): void => {
      if (!bridge.dragWindow && !gesture.current) applyOffset(fitPreview(preferred.current))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finishPointer)
    window.addEventListener('pointercancel', finishPointer)
    window.addEventListener('lostpointercapture', finishPointer)
    window.addEventListener('blur', finish)
    window.addEventListener('resize', fit)
    const observer = new ResizeObserver(fit)
    const element = document.querySelector('[data-testid="island"]')
    if (element && !bridge.dragWindow) observer.observe(element)
    fit()
    return () => {
      finish()
      observer.disconnect()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finishPointer)
      window.removeEventListener('pointercancel', finishPointer)
      window.removeEventListener('lostpointercapture', finishPointer)
      window.removeEventListener('blur', finish)
      window.removeEventListener('resize', fit)
    }
  }, [bridge, enabled, revealDock])

  return {
    offset, dragging, dock,
    setDockExpanded(expanded: boolean) {
      if (!dockRef.current.edge) return
      const next = { ...dockRef.current, collapsed: !expanded }
      dockRef.current = next
      setDock(next)
      bridge.setDockExpanded?.(expanded)
    },
    onPointerDownCapture(event: ReactPointerEvent<HTMLDivElement>) {
      if (!enabled || event.button !== 0 || !event.isPrimary || gesture.current) return
      const target = event.target as HTMLElement
      // Keep buttons, command selection and scrollbars available for their own gestures.
      if (target.closest('button:not(.session-line), a, input, textarea, select, .operation-detail, .session-detail')) return
      suppressClick.current = false
      gesture.current = { id: event.pointerId, start: { x: event.screenX, y: event.screenY }, origin: current.current, element: event.currentTarget, moved: false }
      bridge.dragWindow?.('start')
    },
    onClickCapture(event: MouseEvent<HTMLDivElement>) {
      if (!suppressClick.current) return
      suppressClick.current = false
      event.preventDefault()
      event.stopPropagation()
    }
  }
}
