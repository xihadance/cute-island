/// <reference types="vite/client" />

import type { Activity } from '../../shared/activity'

export interface PointerSample {
  x: number
  y: number
  overWindow: boolean
  overIsland: boolean
}

export interface IslandHit {
  expanded: boolean
  x: number
  y: number
  width: number
  height: number
}

export interface IslandApi {
  setIgnoreMouse: (ignore: boolean) => void
  getActivities: () => Promise<Activity[]>
  dismiss: (id: string) => Promise<void>
  playDemo: () => Promise<void>
  onActivities: (callback: (activities: Activity[]) => void) => () => void
  setInteraction?: (hit: IslandHit) => void
  onPointer?: (callback: (sample: PointerSample) => void) => () => void
  simulateError?: () => void
  simulateAgents?: () => void
  simulateSessions?: () => void
  clear?: () => void
}

declare global {
  interface Window {
    island?: IslandApi
  }
}

export {}
