import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { STATE_LABEL, type Activity } from '../../shared/activity'
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
  const [hovered, setHovered] = useState(false)
  const [resting, setResting] = useState(false)
  const expandedRef = useRef(false)
  const hoveringRef = useRef(false)
  const interacting = expanded || selectedId !== null
  expandedRef.current = interacting

  useEffect(() => {
    let sawLiveEvent = false
    let active = true
    const stop = bridge.onActivities((next) => {
      sawLiveEvent = true
      setActivities(next)
    })
    void bridge.getActivities().then((next) => {
      if (active && !sawLiveEvent) setActivities(next)
    }).catch(console.error)
    return () => { active = false; stop() }
  }, [bridge])

  const primary = activities[0]
  const stacked = activities.length > 1
  const attentionId = activities.find((item) => item.state === 'error' || item.state === 'approval')?.id

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
    if (primary.state === 'error' || primary.state === 'approval') setExpanded(true)
  }, [primary, stacked])

  useEffect(() => {
    if (stacked && attentionId) setSelectedId(attentionId)
  }, [stacked, attentionId])

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
        setHovered(sample.overIsland)
      })
    }
    const syncIgnore = (overIsland: boolean): void => {
      hoveringRef.current = overIsland
      setHovered(overIsland)
      bridge.setIgnoreMouse(!(overIsland || expandedRef.current))
    }
    const onMove = (event: MouseEvent): void => {
      const element = document.elementFromPoint(event.clientX, event.clientY)
      const overIsland = !!element?.closest('[data-testid="island"]')
      setPointerNear(overIsland)
      syncIgnore(overIsland)
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
    bridge.setIgnoreMouse(!(hoveringRef.current || interacting))
  }, [bridge, interacting])

  useEffect(() => {
    if (!bridge.setInteraction) return
    const element = document.querySelector('[data-testid="island"]')
    if (!element) return
    let last = ''
    const syncBounds = (): void => {
      const rect = element.getBoundingClientRect()
      const next = `${interacting}:${Math.round(rect.x)}:${Math.round(rect.y)}:${Math.round(rect.width)}:${Math.round(rect.height)}`
      if (next !== last) {
        last = next
        bridge.setInteraction?.({ expanded: interacting, x: rect.x, y: rect.y, width: rect.width, height: rect.height })
      }
    }
    // Spring animations resize the island; an idle island needs no layout polling.
    const observer = new ResizeObserver(syncBounds)
    observer.observe(element)
    window.addEventListener('resize', syncBounds)
    syncBounds()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', syncBounds)
    }
  }, [bridge, interacting])

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
    setSelectedId(null)
  }

  return (
    <>
      <div className="stage" onMouseDown={collapseFromOutside}>
        <div className="sr-only" aria-live="polite">
          {activities.length > 0 ? activities.map((item) => `${item.agent} ${STATE_LABEL[item.state]} ${item.title}`).join('，') : '空闲'}
        </div>
        <Island
          bridge={bridge}
          hovered={hovered}
          onHover={setHovered}
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
          <button type="button" data-testid="simulate-capabilities" onClick={() => bridge.simulateCapabilities?.()}>
            MCP / Skill / 命令
          </button>
          <button type="button" data-testid="simulate-approval" onClick={() => bridge.simulateApproval?.()}>
            需要审批
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
