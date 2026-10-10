import { useEffect, useState } from 'react'
import type { IslandBehavior } from '../../shared/island-behavior'
import type { IslandApi } from './env'

export function useIslandBehavior(bridge: IslandApi): IslandBehavior {
  const [behavior, setBehavior] = useState<IslandBehavior>({ mode: 'focus', attentionIds: [] })
  useEffect(() => {
    let active = true
    let received = false
    const stop = bridge.onBehavior(next => { received = true; setBehavior(next) })
    void bridge.getBehavior().then(next => {
      if (active && !received) setBehavior(next)
    }).catch(console.error)
    return () => { active = false; stop() }
  }, [bridge])
  return behavior
}
