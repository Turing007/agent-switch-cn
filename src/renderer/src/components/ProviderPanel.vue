<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import type { Provider } from '../../../shared/types'
import { providerState, refreshProviders, ensureProvidersLoaded } from '../stores/providers'

const props = defineProps<{ notify: (msg: string, type?: 'ok' | 'err') => void }>()

const showForm = ref(false)
const editing = ref<Provider | null>(null)
const fetching = ref(false)
const fetchedModels = ref<string[]>([])
const modelFilter = ref('')

const form = ref({ name: '', baseUrl: '', apiKey: '', modelName: '', website: '' })

onMounted(() => ensureProvidersLoaded())

/** 表单里当前可用于选择的模型列表（刚拉取的，或该 Provider 已保存的缓存） */
const pickerModels = computed(() => {
  if (fetchedModels.value.length) return fetchedModels.value
  return editing.value?.models ?? []
})

const filteredModels = computed(() => {
  const kw = modelFilter.value.trim().toLowerCase()
  if (!kw) return pickerModels.value
  return pickerModels.value.filter((m) => m.toLowerCase().includes(kw))
})

function openCreate(): void {
  editing.value = null
  form.value = { name: '', baseUrl: '', apiKey: '', modelName: '', website: '' }
  fetchedModels.value = []
  modelFilter.value = ''
  showForm.value = true
}

function openEdit(p: Provider): void {
  editing.value = p
  form.value = {
    name: p.name,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    modelName: p.modelName ?? '',
    website: p.website ?? ''
  }
  fetchedModels.value = []
  modelFilter.value = ''
  showForm.value = true
}

async function save(): Promise<void> {
  if (!form.value.name.trim() || !form.value.baseUrl.trim()) {
    props.notify('名称和 Base URL 为必填项', 'err')
    return
  }
  if (form.value.website.trim() && !/^https?:\/\//i.test(form.value.website.trim())) {
    props.notify('官网链接需以 http:// 或 https:// 开头', 'err')
    return
  }
  const payload: Provider = {
    id: editing.value?.id ?? '',
    name: form.value.name,
    baseUrl: form.value.baseUrl,
    apiKey: form.value.apiKey,
    modelName: form.value.modelName || undefined,
    website: form.value.website.trim() || undefined,
    // 注意：必须是普通数组。Vue 响应式数组是 Proxy，无法被 Electron IPC 结构化克隆
    models: pickerModels.value.length ? [...pickerModels.value] : undefined,
    createdAt: editing.value?.createdAt ?? 0,
    updatedAt: Date.now()
  }
  await window.api.providers.save(payload)
  showForm.value = false
  fetchedModels.value = []
  await refreshProviders()
  props.notify(editing.value ? '已更新' : '已添加模型配置')
}

async function remove(p: Provider): Promise<void> {
  if (!confirm(`确定删除「${p.name}」？`)) return
  await window.api.providers.delete(p.id)
  await refreshProviders()
  props.notify('已删除', 'ok')
}

/** 根据当前表单的 Base URL + API Key 拉取可用模型列表 */
async function fetchModels(): Promise<void> {
  if (!form.value.baseUrl.trim()) {
    props.notify('请先填写 Base URL', 'err')
    return
  }
  fetching.value = true
  try {
    const models = await window.api.models.fetch(form.value.baseUrl, form.value.apiKey)
    fetchedModels.value = models
    modelFilter.value = ''
    if (models.length === 0) {
      props.notify('未拉到模型列表，请检查接口是否支持 /models', 'err')
    } else {
      if (!form.value.modelName || !models.includes(form.value.modelName)) {
        form.value.modelName = models[0]
      }
      props.notify(`已拉取 ${models.length} 个模型`)
    }
  } catch (e) {
    props.notify(`拉取失败: ${(e as Error).message}`, 'err')
  } finally {
    fetching.value = false
  }
}

/** 用系统默认浏览器打开官网链接 */
async function openWebsite(p: Provider): Promise<void> {
  try {
    await window.api.app.openExternal(p.website!)
  } catch (e) {
    props.notify(`打开失败: ${(e as Error).message}`, 'err')
  }
}

/** 复制单个模型名到系统剪贴板 */
async function copyModel(m: string): Promise<void> {
  try {
    await window.api.app.copyText(m)
    props.notify(`已复制 ${m}`, 'ok')
  } catch (e) {
    props.notify(`复制失败: ${(e as Error).message}`, 'err')
  }
}

/** 复制当前过滤后的全部模型名（每行一个） */
async function copyAllModels(): Promise<void> {
  const list = filteredModels.value
  if (!list.length) return
  try {
    await window.api.app.copyText(list.join('\n'))
    props.notify(`已复制 ${list.length} 个模型名`, 'ok')
  } catch (e) {
    props.notify(`复制失败: ${(e as Error).message}`, 'err')
  }
}

/** 卡片上展开/收起已保存的模型列表 */
const expandedCards = ref<Set<string>>(new Set())
function toggleCardModels(id: string): void {
  const next = new Set(expandedCards.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedCards.value = next
}
</script>

<template>
  <div class="panel">
    <div class="toolbar">
      <h2>模型配置</h2>
      <button class="primary" @click="openCreate">＋ 新增 Provider</button>
    </div>

    <div v-if="providerState.list.length === 0" class="empty">
      还没有任何模型配置，点击右上角「新增 Provider」开始。
    </div>

    <div class="cards">
      <div v-for="p in providerState.list" :key="p.id" class="card">
        <div class="card-head">
          <div class="name">{{ p.name }}</div>
          <div class="actions">
            <button class="ghost" @click="openEdit(p)">编辑</button>
            <button class="danger" @click="remove(p)">删除</button>
          </div>
        </div>
        <div class="base">{{ p.baseUrl }}</div>
        <div class="meta">
          <span v-if="p.modelName">模型: {{ p.modelName }}</span>
          <span>Key: {{ p.apiKey ? '已配置' : '未配置' }}</span>
        </div>
        <div v-if="p.models?.length" class="models-toggle" @click="toggleCardModels(p.id)">
          模型列表（{{ p.models.length }}）{{ expandedCards.has(p.id) ? '▴' : '▾' }}
        </div>
        <div v-if="p.models?.length && expandedCards.has(p.id)" class="card-model-list">
          <div
            v-for="m in p.models"
            :key="m"
            class="card-model-row"
            :title="`点击复制 ${m}`"
            @click="copyModel(m)"
          >
            <span class="cm-name">{{ m }}</span>
            <span class="cm-copy">复制</span>
          </div>
        </div>
        <a v-if="p.website" class="website" href="#" @click.prevent="openWebsite(p)">
          🌐 官网 ↗
        </a>
      </div>
    </div>

    <!-- 表单弹层 -->
    <div v-if="showForm" class="overlay" @click.self="showForm = false">
      <div class="modal">
        <h3>{{ editing ? '编辑 Provider' : '新增 Provider' }}</h3>
        <label>名称 <input v-model="form.name" placeholder="如 DeepSeek / 智谱 GLM" /></label>
        <label>Base URL <input v-model="form.baseUrl" placeholder="https://api.deepseek.com" /></label>
        <label>API Key <input v-model="form.apiKey" type="password" placeholder="sk-..." /></label>
        <label>官网链接 <input v-model="form.website" placeholder="https://www.deepseek.com（可选）" /></label>
        <label>模型名
          <div class="model-row">
            <input
              v-model="form.modelName"
              list="model-options"
              :placeholder="pickerModels.length ? '从下方列表选择或手动输入' : '如 deepseek-chat，可点击拉取'"
            />
            <button class="ghost small" :disabled="fetching" @click="fetchModels">
              {{ fetching ? '拉取中…' : '拉取模型' }}
            </button>
            <datalist id="model-options">
              <option v-for="m in pickerModels" :key="m" :value="m">{{ m }}</option>
            </datalist>
          </div>
        </label>

        <!-- 拉取成功后展示模型列表 -->
        <div v-if="pickerModels.length" class="model-picker">
          <div class="picker-head">
            <span>模型列表（共 {{ pickerModels.length }} 个）</span>
            <input v-model="modelFilter" class="picker-filter" placeholder="搜索过滤…" />
            <button class="ghost small" @click="copyAllModels">复制全部</button>
          </div>
          <div v-if="filteredModels.length" class="model-list">
            <div
              v-for="m in filteredModels"
              :key="m"
              class="model-item"
              :class="{ active: m === form.modelName }"
              :title="`点击选择，按钮复制：${m}`"
              @click="form.modelName = m"
            >
              <span class="mi-name">{{ m }}</span>
              <button class="mi-copy" title="复制模型名" @click.stop="copyModel(m)">复制</button>
            </div>
          </div>
          <div v-else class="picker-empty">没有匹配「{{ modelFilter }}」的模型</div>
        </div>

        <div class="modal-actions">
          <button class="ghost" @click="showForm = false">取消</button>
          <button class="primary" @click="save">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel { padding: 20px; max-width: 900px; margin: 0 auto; }
.toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
.empty { color: var(--muted); text-align: center; padding: 48px 0; border: 1px dashed var(--border); border-radius: var(--radius); }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; }
.card-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.name { font-weight: 600; }
.actions { display: flex; gap: 6px; }
.base { color: var(--muted); font-size: 12px; word-break: break-all; margin-bottom: 8px; }
.meta { display: flex; flex-wrap: wrap; gap: 12px; color: var(--muted); font-size: 11px; }
.website {
  display: inline-block; margin-top: 10px; font-size: 12px;
  color: var(--accent); text-decoration: none;
}
.website:hover { text-decoration: underline; }
.models-toggle {
  margin-top: 10px; font-size: 12px; color: var(--accent);
  cursor: pointer; user-select: none;
}
.models-toggle:hover { text-decoration: underline; }
.card-model-list {
  margin-top: 8px; max-height: 180px; overflow-y: auto;
  border: 1px solid var(--border); border-radius: 6px;
}
.card-model-row {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 5px 10px; font-size: 12px; color: var(--text);
  cursor: pointer; border-bottom: 1px solid var(--border);
}
.card-model-row:last-child { border-bottom: none; }
.card-model-row:hover { background: var(--panel-2); }
.cm-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cm-copy { flex: none; color: var(--muted); font-size: 11px; visibility: hidden; }
.card-model-row:hover .cm-copy { visibility: visible; color: var(--accent); }
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: grid; place-items: center; z-index: 10; }
.modal { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; width: 460px; max-height: 86vh; overflow-y: auto; }
.modal h3 { margin-bottom: 14px; }
.modal label { display: block; margin-bottom: 10px; font-size: 12px; color: var(--muted); }
.modal label input { margin-top: 4px; color: var(--text); }
.model-row { display: flex; gap: 6px; align-items: center; margin-top: 4px; }
.model-row input { flex: 1; margin-top: 0; }
.model-row button.small { padding: 6px 10px; font-size: 12px; white-space: nowrap; }
.model-picker { border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 10px; }
.picker-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  flex-wrap: wrap;
  padding: 8px 10px; font-size: 12px; color: var(--muted);
  border-bottom: 1px solid var(--border);
}
.picker-filter {
  width: 140px; padding: 4px 8px; font-size: 12px; margin-top: 0 !important;
}
.picker-head button.small { padding: 4px 8px; font-size: 11px; white-space: nowrap; }
.model-list { max-height: 220px; overflow-y: auto; }
.model-item {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 7px 12px; font-size: 13px; color: var(--text);
  cursor: pointer; border-bottom: 1px solid var(--border);
}
.model-item:last-child { border-bottom: none; }
.model-item:hover { background: var(--panel-2); }
.model-item.active { color: var(--accent); background: var(--panel-2); font-weight: 600; }
.mi-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mi-copy {
  flex: none; padding: 2px 8px; font-size: 11px;
  visibility: hidden; white-space: nowrap;
}
.model-item:hover .mi-copy { visibility: visible; }
.picker-empty { padding: 14px 12px; font-size: 12px; color: var(--muted); text-align: center; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
</style>
