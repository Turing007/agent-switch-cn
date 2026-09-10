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
            <span class="label">当前</span>
            <span v-if="statuses[inst.agentId]?.configured" class="current-value selectable">
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
.panel { padding: 24px; max-width: 920px; margin: 0 auto; }
.toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.hint { color: var(--muted); font-size: 12px; margin-bottom: 20px; }

.empty {
  color: var(--muted); text-align: center; padding: 56px 24px;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: var(--radius); font-size: 12.5px;
}

.agent-list { display: flex; flex-direction: column; gap: 16px; }
.agent {
  background: var(--panel); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 16px;
  transition: box-shadow 0.24s var(--ease), border-color 0.24s var(--ease);
}
.agent:hover { box-shadow: var(--shadow-1); border-color: transparent; }
.agent-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.name { font-weight: 600; font-size: 14px; letter-spacing: -0.016em; }
.path {
  color: var(--muted); font-size: 11px; word-break: break-all; margin-top: 4px;
  font-family: var(--mono); letter-spacing: -0.01em;
}

.badge {
  font-size: 11px; font-weight: 500; padding: 3px 10px;
  border-radius: var(--radius-pill); white-space: nowrap;
}
.badge.ok { color: var(--green); background: var(--green-soft); }
.badge.missing { color: var(--muted); background: var(--panel-2); }

.agent-body { border-top: 1px solid var(--border); padding-top: 14px; }
.current { margin-bottom: 12px; font-size: 12.5px; display: flex; gap: 6px; flex-wrap: wrap; }
.label { color: var(--muted); }
.current-value { font-weight: 500; }
.muted { color: var(--muted); }

/* 胶囊选择器：选中态为系统色浅底（iOS 标签选择） */
.picker { display: flex; flex-wrap: wrap; gap: 8px; }
.choice {
  position: relative;
  display: inline-flex; align-items: center; gap: 6px;
  background: var(--panel-2); border: 1px solid transparent;
  padding: 6px 13px; border-radius: var(--radius-pill);
  cursor: pointer; font-size: 12px; font-weight: 500;
  transition: background 0.18s var(--ease), color 0.18s var(--ease),
    border-color 0.18s var(--ease);
}
.choice:hover { background: var(--panel-3); }
.choice input {
  position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; pointer-events: none;
}
.choice:has(input:checked) {
  background: var(--accent-soft); color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 35%, transparent);
}
.choice:has(input:checked)::after {
  content: '✓'; font-size: 11px; font-weight: 700; line-height: 1;
}
.choice:has(input:focus-visible) {
  outline: 3px solid var(--accent-soft); outline-offset: 1px;
}
</style>