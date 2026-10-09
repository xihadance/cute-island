import { useEffect, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { constrainPosition, DRAG_THRESHOLD, isPoint, positionAfterDrag, type Point } from '../../shared/window-position'
import type { IslandApi } from './env'

const POSITION_KEY = 'cute-island-position'

function readPreviewPosition(): Point {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(POSITION_KEY) ?? 'null')
    if (isPoint(saved)) return saved
  } catch { /* Storage may be unavailable in an embedded preview. */ }
  return { x: 0, y: 0 }
}

export function useIslandDrag(bridge: IslandApi) {
  const [offset, setOffset] = useState<Point>(() => bridge.dragWindow ? { x: 0, y: 0 } : readPreviewPosition())
  const [dragging, setDragging] = useState(false)
  const preferred = useRef(offset)
  const current = useRef(offset)
  const gesture = useRef<{ id: number; start: Point; origin: Point; element: HTMLElement; moved: boolean } | null>(null)
  const suppressClick = useRef(false)

  useEffect(() => {
    const fitPreview = (position: Point): Point => {
      const element = document.querySelector<HTMLElement>('[data-testid="island"]')
      if (!element) return position
      const rect = element.getBoundingClientRect()
      return constrainPosition(position,
        { x: (window.innerWidth - rect.width) / 2, y: 8, width: rect.width, height: rect.height },
        { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight })
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
        preferred.current = current.current
        try { localStorage.setItem(POSITION_KEY, JSON.stringify(preferred.current)) } catch { /* Optional preview persistence. */ }
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
  }, [bridge])

  return {
    offset, dragging,
    onPointerDownCapture(event: ReactPointerEvent<HTMLDivElement>) {
      if (event.button !== 0 || !event.isPrimary || gesture.current) return
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
