import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { STATE_LABEL, type Activity } from '../../shared/activity'
import { getBridge } from './bridge'
import { Island } from './Island'
import { useIslandDrag } from './useIslandDrag'
import { useIslandBehavior } from './useIslandBehavior'
import { isPassive } from '../../shared/island-behavior'
import type { IslandApi } from './env'

export function App() {
  const bridgeRef = useRef<IslandApi | null>(null)
  if (!bridgeRef.current) bridgeRef.current = getBridge()
  const bridge = bridgeRef.current
  const behavior = useIslandBehavior(bridge)
  const [activities, setActivities] = useState<Activity[]>([])
  const [expanded, setExpanded] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pointerNear, setPointerNear] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [resting, setResting] = useState(false)
  const expandedRef = useRef(false)
  const hoveringRef = useRef(false)
  const managed = behavior.mode === 'managed'
  const pending = activities.filter(item => behavior.attentionIds.includes(item.id))
  const attention = managed && pending.length > 0
  const passive = isPassive(behavior)
  const drag = useIslandDrag(bridge, !passive, attention)
  const visibleActivities = managed ? attention ? pending : activities.slice(0, 1) : activities
  const visibleSelectedId = managed ? (pending.find(item => item.id === selectedId)?.id ?? pending[0]?.id ?? null) : selectedId
  const interacting = managed ? attention : !drag.dock.collapsed && (expanded || selectedId !== null || drag.dock.edge !== null)
  const passiveRef = useRef(passive)
  passiveRef.current = passive
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
    if (managed) return
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
  }, [primary, stacked, managed])

  useEffect(() => {
    if (!managed && stacked && attentionId) setSelectedId(attentionId)
  }, [stacked, attentionId, managed])

  useEffect(() => {
    if (primary || (!passive && (pointerNear || expanded))) {
      setResting(false)
      return
    }
    const timer = window.setTimeout(() => setResting(true), 2200)
    return () => window.clearTimeout(timer)
  }, [primary, pointerNear, expanded, passive])

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
      bridge.setIgnoreMouse(passiveRef.current || !(overIsland || expandedRef.current))
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
    bridge.setIgnoreMouse(passive || !(hoveringRef.current || interacting))
  }, [bridge, interacting, passive])

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
    if (managed) return
    if (drag.dock.edge) {
      drag.setDockExpanded(drag.dock.collapsed)
      if (drag.dock.collapsed) {
        setResting(false)
        setExpanded(!!primary && !stacked)
      }
      return
    }
    if (!primary || primary.state === 'error') {
      if (primary?.state === 'error') setExpanded(true)
      return
    }
    setExpanded((value) => !value)
  }

  const collapseFromOutside = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (managed) return
    if (event.target !== event.currentTarget) return
    if (drag.dock.edge) drag.setDockExpanded(false)
    if (primary?.state === 'error') return
    setExpanded(false)
    setSelectedId(null)
  }

  return (
    <>
      <div className="stage" data-passive={passive} onMouseDown={collapseFromOutside}>
        <div className="sr-only" aria-live={passive ? 'off' : 'polite'}>
          {activities.length > 0 ? activities.map((item) => `${item.agent}，${item.client ?? '未知客户端'}，${STATE_LABEL[item.state]} ${item.title}`).join('，') : '空闲'}
        </div>
        <Island
          drag={drag}
          behaviorMode={behavior.mode}
          passive={passive}
          attention={attention}
          onAcknowledge={attention ? (id) => bridge.acknowledge(id) : undefined}
          hovered={hovered}
          onHover={setHovered}
          activities={visibleActivities}
          expanded={managed ? attention && pending.length === 1 : expanded && !!primary && !stacked}
          selectedId={managed && !attention ? null : visibleSelectedId}
          resting={resting && !primary && !drag.dock.edge}
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
          <div className="mode-switch" role="group" aria-label="灵动岛模式">
            <button type="button" data-testid="mode-focus" aria-pressed={!managed} onClick={() => bridge.setMode('focus')}>关注模式</button>
            <button type="button" data-testid="mode-managed" aria-pressed={managed} onClick={() => bridge.setMode('managed')}>托管模式</button>
          </div>
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
          <button type="button" data-testid="simulate-tasks" onClick={() => bridge.simulateTasks?.()}>
            子 Agent / 后台任务
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
