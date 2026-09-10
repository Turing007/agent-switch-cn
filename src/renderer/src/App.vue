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

/* macOS 工具栏：半透明 + 毛玻璃 + 发丝分隔线 */
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-blur);
  backdrop-filter: saturate(180%) blur(20px);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  position: relative;
  z-index: 5;
}

.brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.logo-img {
  width: 30px; height: 30px; display: block; border-radius: 8px;
  box-shadow: var(--shadow-1);
}
.brand strong {
  display: block;
  font-size: 13.5px; font-weight: 600; letter-spacing: -0.016em;
}
.subtitle {
  display: block; color: var(--muted); font-size: 11px;
  font-weight: 400; margin-top: 1px;
}

/* 分段控件（macOS Segmented Control） */
.tabs {
  display: flex; gap: 2px; padding: 2px;
  background: var(--panel-2);
  border-radius: var(--radius-pill);
}
.tabs button {
  padding: 6px 16px; font-size: 12.5px; font-weight: 500;
  background: transparent; color: var(--muted);
  border-radius: var(--radius-pill);
}
.tabs button:hover { background: transparent; color: var(--text); }
.tabs button:active { transform: none; }
.tabs button.active {
  background: var(--panel); color: var(--text);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12), 0 0 0 0.5px rgba(0, 0, 0, 0.04);
}

.top-actions { display: flex; align-items: center; gap: 10px; }
.check-update { padding: 6px 13px; font-size: 12px; white-space: nowrap; }
.update-badge {
  padding: 6px 13px; font-size: 12px; white-space: nowrap;
  color: var(--green); background: var(--green-soft); border: none;
}
.update-badge:hover { background: var(--green-soft); color: var(--green); }

.content { flex: 1; overflow: auto; }

/* 提示条：磨砂胶囊 */
.toast {
  position: fixed; bottom: 26px; left: 50%; transform: translateX(-50%);
  padding: 10px 18px; border-radius: var(--radius-pill);
  background: var(--bg-blur);
  backdrop-filter: saturate(180%) blur(20px);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-2);
  font-size: 12.5px; font-weight: 500; letter-spacing: -0.006em;
  z-index: 20; max-width: 70vw; text-align: center;
  animation: toast-in 0.34s var(--ease);
}
.toast::before {
  content: ''; display: inline-block; vertical-align: 1px;
  width: 7px; height: 7px; border-radius: 50%;
  margin-right: 8px; background: var(--green);
}
.toast.err::before { background: var(--red); }

@keyframes toast-in {
  from { opacity: 0; transform: translateX(-50%) translateY(10px) scale(0.96); }
  to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
}
</style>