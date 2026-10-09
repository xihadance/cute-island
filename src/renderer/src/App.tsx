import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { Activity } from '../../shared/activity'
import { getBridge } from './bridge'
import { Island } from './Island'
import type { IslandApi } from './env'

export function App() {
  const bridgeRef = useRef<IslandApi | null>(null)
  if (!bridgeRef.current) bridgeRef.current = getBridge()
  const bridge = bridgeRef.current
  const [activities, setActivities] = useState<Activity[]>([])
  const [expanded, setExpanded] = useState(false)
  const [pointerNear, setPointerNear] = useState(false)
  const [resting, setResting] = useState(false)
  const expandedRef = useRef(false)
  const hoveringRef = useRef(false)
  expandedRef.current = expanded

  useEffect(() => {
    let sawLiveEvent = false
    const stop = bridge.onActivities((next) => {
      sawLiveEvent = true
      setActivities(next)
    })
    void bridge.getActivities().then((next) => {
      if (!sawLiveEvent) setActivities(next)
    })
    return stop
  }, [bridge])

  const primary = activities[0]
  const others = activities.slice(1)

  useEffect(() => {
    if (!primary) setExpanded(false)
    else if (primary.state === 'error') setExpanded(true)
  }, [primary])

  useEffect(() => {
    if (primary || pointerNear || expanded) {
      setResting(false)
      return
    }
    const timer = window.setTimeout(() => setResting(true), 2200)
    return () => window.clearTimeout(timer)
  }, [primary, pointerNear, expanded])

  useEffect(() => {
    const syncIgnore = (overIsland: boolean): void => {
      hoveringRef.current = overIsland
      bridge.setIgnoreMouse(!(overIsland || expandedRef.current))
    }
    const onMove = (event: MouseEvent): void => {
      setPointerNear(event.clientY <= 64)
      const element = document.elementFromPoint(event.clientX, event.clientY)
      syncIgnore(!!element?.closest('[data-testid="island"]'))
    }
    const onLeave = (event: MouseEvent): void => {
      if (event.relatedTarget) return
      setPointerNear(false)
      syncIgnore(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseout', onLeave)
    syncIgnore(false)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseout', onLeave)
    }
  }, [bridge])

  useEffect(() => {
    bridge.setIgnoreMouse(!(hoveringRef.current || expanded))
  }, [bridge, expanded])

  const toggle = (): void => {
    if (!primary || primary.state === 'error') {
      if (primary?.state === 'error') setExpanded(true)
      return
    }
    setExpanded((value) => !value)
  }

  const collapseFromOutside = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return
    if (primary?.state === 'error') return
    setExpanded(false)
  }

  return (
    <>
      <div className="stage" onMouseDown={collapseFromOutside}>
        <div className="sr-only" aria-live="polite">
          {primary ? `${primary.agent} ${primary.title}` : '空闲'}
        </div>
        <Island
          activity={primary}
          others={others}
          expanded={expanded && !!primary}
          resting={resting && !primary}
          onToggle={toggle}
          onDismiss={() => {
            if (primary) void bridge.dismiss(primary.id)
          }}
        />
      </div>
      {bridge.simulateError && bridge.clear && (
        <div className="dev-panel">
          <button type="button" data-testid="demo" onClick={() => void bridge.playDemo()}>
            播放演示
          </button>
          <button type="button" data-testid="simulate-error" onClick={() => bridge.simulateError?.()}>
            模拟失败
          </button>
          <button
            type="button"
            data-testid="clear"
            onClick={() => {
              bridge.clear?.()
              setExpanded(false)
            }}
          >
            清空
          </button>
        </div>
      )}
    </>
  )
}
