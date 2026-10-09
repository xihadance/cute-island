/// <reference types="vite/client" />

import type { Activity } from '../../shared/activity'

export interface IslandApi {
  setIgnoreMouse: (ignore: boolean) => void
  getActivities: () => Promise<Activity[]>
  dismiss: (id: string) => Promise<void>
  playDemo: () => Promise<void>
  onActivities: (callback: (activities: Activity[]) => void) => () => void
  simulateError?: () => void
  clear?: () => void
}

declare global {
  interface Window {
    island?: IslandApi
  }
}

export {}
