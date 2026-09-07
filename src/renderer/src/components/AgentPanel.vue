<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { AgentInstance, AgentDef, SwitchStatus } from '../../../shared/types'
import { providerState, refreshProviders, ensureProvidersLoaded } from '../stores/providers'

const props = defineProps<{ notify: (msg: string, type?: 'ok' | 'err') => void }>()

const agents = ref<AgentDef[]>([])
const instances = ref<AgentInstance[]>([])
const statuses = ref<Record<string, SwitchStatus>>({})
const busyAgent = ref<string | null>(null)

onMounted(async () => {
  agents.value = await window.api.agents.list()
  await ensureProvidersLoaded()
  await refresh()
})

async function refresh(): Promise<void> {
  instances.value = await window.api.agents.detect()
  await refreshProviders()
  for (const inst of instances.value) {
    statuses.value[inst.agentId] = await window.api.agents.status(inst)
  }
}

async function doSwitch(agentId: string, providerId: string): Promise<void> {
  busyAgent.value = agentId
  const res = await window.api.agents.switch(agentId, providerId)
  if (res.ok) {
    props.notify(res.message ?? '切换成功')
    if (res.backupPath) props.notify(`已备份原配置 → ${res.backupPath}`)
  } else {
    props.notify(res.message ?? '切换失败', 'err')
  }
  busyAgent.value = null
  await refresh()
}
</script>

<template>
  <div class="panel">
    <div class="toolbar">
      <h2>Agent 切换</h2>
      <button @click="refresh">重新检测</button>
    </div>

    <div class="hint">
      检测到的配置文件均为本地明文读写，切换前会自动备份到应用数据目录。
    </div>

    <div v-if="instances.length === 0" class="empty">
      未检测到内置 agent 的配置文件，请确认已安装。若使用通用适配器，需先配置自定义配置文件。
    </div>

    <div class="agent-list">
      <div v-for="inst in instances" :key="inst.agentId" class="agent">
        <div class="agent-head">
          <div>
            <div class="name">{{ inst.agentName }}</div>
            <div class="path">{{ inst.configFilePath }}</div>
          </div>
          <span
            class="badge"
            :class="inst.exists ? 'ok' : 'missing'"
          >{{ inst.exists ? '已找到配置' : '未找到配置' }}</span>
        </div>

        <div class="agent-body">
          <div class="current">
            <span class="label">当前：</span>
            <span v-if="statuses[inst.agentId]?.configured">
              {{ statuses[inst.agentId].providerName || '自定义/未识别 provider' }}
              <template v-if="statuses[inst.agentId].modelName"> · {{ statuses[inst.agentId].modelName }}</template>
            </span>
            <span v-else class="muted">未配置模型</span>
          </div>

          <div v-if="providerState.list.length" class="picker">
            <label v-for="p in providerState.list" :key="p.id" class="choice">
              <input
                type="radio"
                :name="inst.agentId"
                :value="p.id"
                :checked="statuses[inst.agentId]?.providerName === p.name"
                @change="doSwitch(inst.agentId, p.id)"
              />
              <span>{{ p.name }}</span>
            </label>
          </div>
          <div v-else class="muted">请先在「模型管理」中添加 Provider。</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel { padding: 20px; max-width: 900px; margin: 0 auto; }
.toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.hint { color: var(--muted); font-size: 12px; margin-bottom: 16px; }
.empty { color: var(--muted); text-align: center; padding: 48px 0; border: 1px dashed var(--border); border-radius: var(--radius); }
.agent-list { display: flex; flex-direction: column; gap: 16px; }
.agent { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
.agent-head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 12px; }
.name { font-weight: 600; font-size: 14px; }
.path { color: var(--muted); font-size: 11px; word-break: break-all; margin-top: 4px; }
.badge { font-size: 11px; padding: 3px 8px; border-radius: 6px; white-space: nowrap; }
.badge.ok { color: var(--green); background: rgba(62,207,142,0.12); }
.badge.missing { color: var(--muted); background: var(--panel-2); }
.agent-body { border-top: 1px solid var(--border); padding-top: 12px; }
.current { margin-bottom: 10px; font-size: 13px; }
.label { color: var(--muted); }
.muted { color: var(--muted); }
.picker { display: flex; flex-wrap: wrap; gap: 8px; }
.choice {
  display: inline-flex; align-items: center; gap: 6px;
  background: var(--panel-2); border: 1px solid var(--border);
  padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px;
}
.choice input { width: auto; accent-color: var(--accent); }
.choice:has(input:checked) { border-color: var(--accent); }
</style>