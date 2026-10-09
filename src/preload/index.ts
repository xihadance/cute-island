import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Activity } from '../shared/activity'

const island = {
  setIgnoreMouse(ignore: boolean): void {
    ipcRenderer.send('island:set-ignore-mouse', ignore)
  },
  getActivities(): Promise<Activity[]> {
    return ipcRenderer.invoke('island:get-activities')
  },
  dismiss(id: string): Promise<void> {
    return ipcRenderer.invoke('island:dismiss', id)
  },
  playDemo(): Promise<void> {
    return ipcRenderer.invoke('island:play-demo')
  },
  onActivities(callback: (activities: Activity[]) => void): () => void {
    const listener = (_event: IpcRendererEvent, activities: Activity[]): void => {
      callback(activities)
    }
    ipcRenderer.on('island:activities', listener)
    return () => {
      ipcRenderer.removeListener('island:activities', listener)
    }
  }
}

contextBridge.exposeInMainWorld('island', island)
