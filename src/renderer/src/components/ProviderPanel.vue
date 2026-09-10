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

const form = ref({
  name: '',
  baseUrl: '',
  apiKey: '',
  modelName: '',
  website: '',
  modelNames: [] as string[]
})

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

/** 有勾选时，默认模型跟随勾选首项；无勾选时保留手动输入的模型名 */
function syncDefaultModel(): void {
  if (form.value.modelNames.length) form.value.modelName = form.value.modelNames[0]
}

function toggleModel(m: string): void {
  const list = form.value.modelNames
  const i = list.indexOf(m)
  if (i >= 0) list.splice(i, 1)
  else list.push(m)
  syncDefaultModel()
}

/** 勾选当前搜索结果 */
function selectAllModels(): void {
  for (const m of filteredModels.value) {
    if (!form.value.modelNames.includes(m)) form.value.modelNames.push(m)
  }
  syncDefaultModel()
}

function clearModels(): void {
  form.value.modelNames = []
}

/** 卡片上的模型摘要：多选时显示「默认模型 等 N 个」 */
function modelSummary(p: Provider): string {
  const total = p.modelNames?.length ?? 0
  const first = p.modelName ?? p.modelNames?.[0] ?? ''
  if (!first) return ''
  return total > 1 ? `${first} 等 ${total} 个` : first
}

function openCreate(): void {
  editing.value = null
  form.value = { name: '', baseUrl: '', apiKey: '', modelName: '', website: '', modelNames: [] }
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
    website: p.website ?? '',
    // 旧数据只有单个 modelName，回退成单元素勾选列表
    modelNames: [...(p.modelNames ?? (p.modelName ? [p.modelName] : []))]
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
  const typedDefault = form.value.modelName.trim()
  const selected = form.value.modelNames.length
    ? [...form.value.modelNames]
    : typedDefault
      ? [typedDefault]
      : []
  const payload: Provider = {
    id: editing.value?.id ?? '',
    name: form.value.name,
    baseUrl: form.value.baseUrl,
    apiKey: form.value.apiKey,
    modelName: selected[0] || undefined,
    modelNames: selected.length ? selected : undefined,
    website: form.value.website.trim() || undefined,
    // 注意：必须是普通数组。Vue 响应式数组是 Proxy，无法被 IPC 结构化克隆
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
      if (!form.value.modelNames.length) form.value.modelNames = [models[0]]
      syncDefaultModel()
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

/** 复制 API Key 到系统剪贴板 */
async function copyKey(key: string): Promise<void> {
  if (!key) return
  try {
    await window.api.app.copyText(key)
    props.notify('已复制 API Key', 'ok')
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
          <span v-if="modelSummary(p)">模型: {{ modelSummary(p) }}</span>
          <span
            v-if="p.apiKey"
            class="key-copy"
            title="点击复制 API Key"
            @click="copyKey(p.apiKey)"
          >Key: 已配置 ⧉</span>
          <span v-else>Key: 未配置</span>
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
        <label>API Key
          <div class="model-row">
            <input v-model="form.apiKey" type="password" placeholder="sk-..." />
            <button
              class="ghost small"
              :disabled="!form.apiKey"
              title="复制 API Key"
              @click="copyKey(form.apiKey)"
            >复制</button>
          </div>
        </label>
        <label>官网链接 <input v-model="form.website" placeholder="https://www.deepseek.com（可选）" /></label>
        <label>默认模型
          <div class="model-row">
            <input
              v-model="form.modelName"
              list="model-options"
              :placeholder="pickerModels.length ? '从下方列表勾选，或手动输入' : '如 deepseek-chat，可点击拉取'"
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
            <span>模型列表（共 {{ pickerModels.length }} 个，已选 {{ form.modelNames.length }}）</span>
            <input v-model="modelFilter" class="picker-filter" placeholder="搜索过滤…" />
            <button class="ghost small" @click="selectAllModels">全选</button>
            <button class="ghost small" :disabled="!form.modelNames.length" @click="clearModels">清空</button>
            <button class="ghost small" @click="copyAllModels">复制全部</button>
          </div>
          <div class="picker-hint">
            勾选多个模型会全部写入 Qoder / ZCode；第一个勾选项作为默认模型（供 CodeGeeX、通用 CLI Agent、Trae 使用）。
          </div>
          <div v-if="filteredModels.length" class="model-list">
            <div
              v-for="m in filteredModels"
              :key="m"
              class="model-item"
              :class="{ active: form.modelNames.includes(m) }"
              :title="`点击勾选/取消，按钮复制：${m}`"
              @click="toggleModel(m)"
            >
              <span class="mi-check">{{ form.modelNames.includes(m) ? '✓' : '' }}</span>
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
.panel { padding: 24px; max-width: 920px; margin: 0 auto; }
.toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }

.empty {
  color: var(--muted); text-align: center; padding: 56px 24px;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: var(--radius); font-size: 12.5px;
}

/* 卡片：白色磁贴 + 悬浮轻抬升 */
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
  transition: box-shadow 0.24s var(--ease), transform 0.24s var(--ease),
    border-color 0.24s var(--ease);
}
.card:hover {
  box-shadow: var(--shadow-1);
  transform: translateY(-1px);
  border-color: transparent;
}
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.name { font-weight: 600; font-size: 14px; letter-spacing: -0.016em; }
.actions { display: flex; gap: 4px; opacity: 0; transition: opacity 0.2s var(--ease); }
.card:hover .actions, .card:focus-within .actions { opacity: 1; }
.actions button { padding: 4px 10px; font-size: 11.5px; }

.base {
  font-family: var(--mono); color: var(--muted); font-size: 11px;
  word-break: break-all; margin-bottom: 8px; letter-spacing: -0.01em;
}
.meta { display: flex; flex-wrap: wrap; gap: 10px; color: var(--muted); font-size: 11px; }
.key-copy { cursor: pointer; user-select: none; transition: color 0.18s var(--ease); }
.key-copy:hover { color: var(--accent); }

.website {
  display: inline-block; margin-top: 10px; font-size: 12px;
  color: var(--accent); text-decoration: none; font-weight: 500;
}
.website:hover { text-decoration: underline; }

.models-toggle {
  margin-top: 12px; font-size: 12px; color: var(--accent); font-weight: 500;
  cursor: pointer; user-select: none; display: inline-block;
}
.models-toggle:hover { opacity: 0.8; }

/* iOS 分组内嵌列表 */
.card-model-list {
  margin-top: 10px; max-height: 180px; overflow-y: auto;
  background: var(--panel-2); border-radius: var(--radius-md);
}
.card-model-row {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 7px 11px; font-size: 12px; color: var(--text);
  cursor: pointer; transition: background 0.15s var(--ease);
}
.card-model-row + .card-model-row { border-top: 1px solid var(--border); }
.card-model-row:hover { background: var(--panel-3); }
.cm-name {
  flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--mono); font-size: 11.5px;
}
.cm-copy { flex: none; color: var(--muted); font-size: 11px; visibility: hidden; }
.card-model-row:hover .cm-copy { visibility: visible; color: var(--accent); }

/* 弹层：macOS sheet —— 磨砂遮罩 + 大圆角 */
.overlay {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.32);
  backdrop-filter: blur(16px) saturate(160%);
  -webkit-backdrop-filter: blur(16px) saturate(160%);
  display: grid; place-items: center; z-index: 10;
  animation: overlay-in 0.24s var(--ease);
}
.modal {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 22px;
  width: 470px; max-height: 86vh; overflow-y: auto;
  box-shadow: var(--shadow-2);
  animation: sheet-in 0.34s var(--ease);
}
.modal h3 { margin-bottom: 16px; }
.modal label {
  display: block; margin-bottom: 12px;
  font-size: 11.5px; color: var(--muted); font-weight: 500;
}
.modal label input { margin-top: 5px; color: var(--text); }

.model-row { display: flex; gap: 6px; align-items: center; margin-top: 5px; }
.model-row input { flex: 1; margin-top: 0; }
.model-row button.small { padding: 7px 12px; font-size: 11.5px; white-space: nowrap; }

/* 模型选择器：内嵌分组列表 */
.model-picker {
  border: 1px solid var(--border); border-radius: var(--radius-md);
  margin-bottom: 12px; overflow: hidden; background: var(--panel-2);
}
.picker-head {
  display: flex; align-items: center; justify-content: flex-start; gap: 8px;
  flex-wrap: wrap;
  padding: 9px 12px; font-size: 11.5px; color: var(--muted);
  border-bottom: 1px solid var(--border);
}
.picker-head > span:first-child { margin-right: auto; }
.picker-hint {
  padding: 8px 12px; font-size: 11px; line-height: 1.6; color: var(--muted);
  background: var(--accent-soft); border-bottom: 1px solid var(--border);
}
.picker-filter {
  width: 150px; padding: 5px 10px; font-size: 12px;
  margin-top: 0 !important; border-radius: 7px;
}
.picker-head button.small { padding: 4px 10px; font-size: 11px; white-space: nowrap; }

.model-list { max-height: 240px; overflow-y: auto; }
.model-item {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; font-size: 12px; color: var(--text);
  cursor: pointer; transition: background 0.15s var(--ease);
}
.model-item + .model-item { border-top: 1px solid var(--border); }
.model-item:hover { background: var(--panel-3); }
.model-item.active {
  color: var(--accent); background: var(--accent-soft); font-weight: 600;
}
.mi-check {
  flex: none; width: 14px; text-align: center; font-size: 11px; color: var(--accent);
}
.mi-name {
  flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--mono); font-size: 11.5px;
}
.mi-copy {
  flex: none; padding: 3px 10px; font-size: 11px;
  visibility: hidden; white-space: nowrap;
}
.model-item:hover .mi-copy { visibility: visible; }

.picker-empty { padding: 16px 12px; font-size: 12px; color: var(--muted); text-align: center; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }

@keyframes overlay-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes sheet-in {
  from { opacity: 0; transform: translateY(8px) scale(0.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
</style>
