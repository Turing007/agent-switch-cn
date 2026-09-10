import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import { invoke } from '@tauri-apps/api/core'
import type { Api } from '../../preload/index'
import type { Provider, AgentInstance, AgentDef, SwitchResult, SwitchStatus, UpdateCheckResult } from '../../shared/types'

/**
 * 渲染层桥接：
 * - Electron 构建下，preload 已通过 contextBridge 注入 window.api，这里不做任何事；
 * - Tauri 构建下（无 preload），用 invoke 实现同构的 window.api，上层组件零改动。
 */
function installTauriBridge(): void {
  const w = window as unknown as { api?: Api }
  if (w.api) return
  const t = <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => invoke<T>(cmd, args)
  const shim: Api = {
    providers: {
      list: () => t<Provider[]>('providers_list'),
      save: (p) => t<Provider>('providers_save', { p }),
      delete: (id) => t<boolean>('providers_delete', { id })
    },
    models: {
      fetch: (baseUrl, apiKey) => t<string[]>('models_fetch', { baseUrl, apiKey })
    },
    app: {
      openExternal: (url) => t<boolean>('app_open_external', { url }),
      copyText: (text) => t<boolean>('app_copy_text', { text }),
      checkUpdate: () => t<UpdateCheckResult>('app_check_update')
    },
    agents: {
      list: () => t<AgentDef[]>('agents_list'),
      detect: () => t<AgentInstance[]>('agents_detect'),
      status: (i) => t<SwitchStatus>('agents_status', { i }),
      switch: (agentId, providerId) => t<SwitchResult>('agents_switch', { agentId, providerId })
    },
    backups: {
      list: () => t<string[]>('backups_list')
    },
    trae: {
      preflight: () => t<unknown>('trae_preflight'),
      readModel: () => t<unknown>('trae_read_model')
    }
  }
  w.api = shim
}

installTauriBridge()
createApp(App).mount('#app')
