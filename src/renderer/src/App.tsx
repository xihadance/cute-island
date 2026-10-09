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
  const [selectedId, setSelectedId] = useState<string | null>(null)
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
  const stacked = activities.length > 1
  const errorId = activities.find((item) => item.state === 'error')?.id

  useEffect(() => {
    if (!primary) {
      setExpanded(false)
      setSelectedId(null)
      return
    }
    if (stacked) {
      setExpanded(false)
      return
    }
    setSelectedId(null)
    if (primary.state === 'error') setExpanded(true)
  }, [primary, stacked])

  useEffect(() => {
    if (stacked && errorId) setSelectedId(errorId)
  }, [stacked, errorId])

  useEffect(() => {
    if (primary || pointerNear || expanded) {
      setResting(false)
      return
    }
    const timer = window.setTimeout(() => setResting(true), 2200)
    return () => window.clearTimeout(timer)
  }, [primary, pointerNear, expanded])

  useEffect(() => {
    if (bridge.onPointer) {
      return bridge.onPointer((sample) => {
        setPointerNear(sample.overWindow && sample.y <= 72)
      })
    }
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
    if (bridge.onPointer) return
    bridge.setIgnoreMouse(!(hoveringRef.current || expanded))
  }, [bridge, expanded])

  useEffect(() => {
    if (!bridge.setInteraction) return
    let frame = 0
    let last = ''
    const tick = (): void => {
      const element = document.querySelector('[data-testid="island"]')
      if (element) {
        const rect = element.getBoundingClientRect()
        const next = `${expanded}:${Math.round(rect.x)}:${Math.round(rect.y)}:${Math.round(rect.width)}:${Math.round(rect.height)}`
        if (next !== last) {
          last = next
          bridge.setInteraction?.({
            expanded,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height
          })
        }
      }
      frame = window.requestAnimationFrame(tick)
    }
    tick()
    return () => window.cancelAnimationFrame(frame)
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
          {activities.length > 0 ? activities.map((item) => `${item.agent} ${item.title}`).join('，') : '空闲'}
        </div>
        <Island
          activities={activities}
          expanded={expanded && !!primary && !stacked}
          selectedId={selectedId}
          resting={resting && !primary}
          onToggle={toggle}
          onSelect={setSelectedId}
          onDismiss={(id) => {
            void bridge.dismiss(id)
            setSelectedId((current) => (current === id ? null : current))
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
          <button type="button" data-testid="simulate-agents" onClick={() => bridge.simulateAgents?.()}>
            多个 agent
          </button>
          <button type="button" data-testid="simulate-sessions" onClick={() => bridge.simulateSessions?.()}>
            同 agent 多会话
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
