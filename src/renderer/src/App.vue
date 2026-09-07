<script setup lang="ts">
import { ref } from 'vue'
import ProviderPanel from './components/ProviderPanel.vue'
import AgentPanel from './components/AgentPanel.vue'
import logoUrl from './assets/logo.svg'
import type { UpdateCheckResult } from '../../shared/types'

type Tab = 'providers' | 'agents'

const tab = ref<Tab>('providers')
const toast = ref<{ msg: string; type: 'ok' | 'err' } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null

function notify(msg: string, type: 'ok' | 'err' = 'ok'): void {
  toast.value = { msg, type }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = null), 3000)
}

// ---- 检查更新 ----
const checking = ref(false)
const updateInfo = ref<UpdateCheckResult | null>(null)

async function checkUpdate(): Promise<void> {
  if (checking.value) return
  checking.value = true
  updateInfo.value = null
  try {
    const r = await window.api.app.checkUpdate()
    updateInfo.value = r
    notify(r.message, r.error ? 'err' : 'ok')
  } catch (e) {
    notify(`检查更新失败: ${(e as Error).message}`, 'err')
  } finally {
    checking.value = false
  }
}

async function openUpdateUrl(): Promise<void> {
  const url = updateInfo.value?.url
  if (!url) {
    notify('更新清单未提供下载地址', 'err')
    return
  }
  try {
    await window.api.app.openExternal(url)
  } catch (e) {
    notify(`打开下载页失败: ${(e as Error).message}`, 'err')
  }
}
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <img class="logo-img" :src="logoUrl" alt="agent-switch-cn logo" />
        <div>
          <strong>agent-switch-cn</strong>
          <span class="subtitle">国产 CLI Agent 模型切换器</span>
        </div>
      </div>
      <div class="top-actions">
        <button
          v-if="updateInfo?.hasUpdate"
          class="update-badge"
          :title="updateInfo.url ? '打开下载页' : '更新清单未提供下载地址'"
          @click="openUpdateUrl"
        >
          ⬆ 新版本 v{{ updateInfo.latest }}
        </button>
        <button class="ghost check-update" :disabled="checking" @click="checkUpdate">
          {{ checking ? '检查中…' : '检查更新' }}
        </button>
      </div>
      <nav class="tabs">
        <button :class="{ active: tab === 'providers' }" @click="tab = 'providers'">模型管理</button>
        <button :class="{ active: tab === 'agents' }" @click="tab = 'agents'">Agent 切换</button>
      </nav>
    </header>

    <main class="content">
      <ProviderPanel v-if="tab === 'providers'" :notify="notify" />
      <AgentPanel v-else :notify="notify" />
    </main>

    <div v-if="toast" class="toast" :class="toast.type">{{ toast.msg }}</div>
  </div>
</template>

<style scoped>
.shell { height: 100%; display: flex; flex-direction: column; }
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
.brand { display: flex; align-items: center; gap: 10px; }
.logo-img { width: 34px; height: 34px; display: block; }
.subtitle { display: block; color: var(--muted); font-size: 11px; font-weight: 400; }
.tabs { display: flex; gap: 6px; }
.tabs button { padding: 8px 16px; font-size: 13px; background: transparent; }
.tabs button.active { background: var(--accent); color: #fff; }
.top-actions { display: flex; align-items: center; gap: 10px; }
.check-update { padding: 6px 12px; font-size: 12px; white-space: nowrap; }
.update-badge {
  padding: 6px 12px; font-size: 12px; white-space: nowrap;
  color: var(--green); background: transparent; border-color: var(--green);
}
.update-badge:hover { border-color: var(--green); color: var(--green); }
.content { flex: 1; overflow: auto; }
.toast {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
  padding: 10px 18px; border-radius: 8px; background: var(--panel-2);
  border: 1px solid var(--border); box-shadow: 0 8px 24px rgba(0,0,0,0.4); z-index: 20;
}
.toast.ok { border-color: var(--green); }
.toast.err { border-color: var(--red); }
</style>