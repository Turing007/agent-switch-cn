import { reactive } from 'vue'
import type { Provider } from '../../../shared/types'

/**
 * 全局共享的 Provider 响应式状态：
 * 两个面板（模型管理 / Agent 切换）共用同一份数组，
 * 任何一处保存/删除后刷新，另一处立即可见，无需切 Tab 重挂载。
 */
export const providerState = reactive<{ list: Provider[]; loaded: boolean }>({
  list: [],
  loaded: false
})

export async function refreshProviders(): Promise<Provider[]> {
  providerState.list = await window.api.providers.list()
  providerState.loaded = true
  return providerState.list
}

export async function ensureProvidersLoaded(): Promise<void> {
  if (!providerState.loaded) await refreshProviders()
}

export function getProvider(id: string): Provider | undefined {
  return providerState.list.find((p) => p.id === id)
}