import { contextBridge, ipcRenderer } from 'electron'
import type { Provider, AgentDef, AgentInstance, SwitchResult, SwitchStatus, UpdateCheckResult } from '../shared/types'

const api = {
  providers: {
    list: (): Promise<Provider[]> => ipcRenderer.invoke('providers:list'),
    save: (p: Provider): Promise<Provider> => ipcRenderer.invoke('providers:save', p),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('providers:delete', id)
  },
  models: {
    fetch: (baseUrl: string, apiKey: string): Promise<string[]> =>
      ipcRenderer.invoke('models:fetch', baseUrl, apiKey)
  },
  app: {
    openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('app:openExternal', url),
    copyText: (text: string): Promise<boolean> => ipcRenderer.invoke('app:copyText', text),
    checkUpdate: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('app:checkUpdate')
  },
  agents: {
    list: (): Promise<AgentDef[]> => ipcRenderer.invoke('agents:list'),
    detect: (): Promise<AgentInstance[]> => ipcRenderer.invoke('agents:detect'),
    status: (i: AgentInstance): Promise<SwitchStatus> => ipcRenderer.invoke('agents:status', i),
    switch: (agentId: string, providerId: string): Promise<SwitchResult> =>
      ipcRenderer.invoke('agents:switch', agentId, providerId)
  },
  backups: {
    list: (): Promise<string[]> => ipcRenderer.invoke('backups:list')
  },
  trae: {
    preflight: (): Promise<unknown> => ipcRenderer.invoke('trae:preflight'),
    readModel: () => ipcRenderer.invoke('trae:readModel')
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api