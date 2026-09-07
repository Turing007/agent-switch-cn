import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { Store } from './store'
import { AgentService } from './AgentService'
import { preflight as traePreflight, readCurrentModel as traeReadCurrentModel } from './trae'
import { assertPublicHttpUrl } from './urlguard'
import { checkForUpdate } from './update'
import type { Provider } from '../shared/types'

let win: BrowserWindow | null = null
let store: Store
let agents: AgentService

// 数据目录隔离：安装版（日常使用）用 agent-switch-cn，开发/测试态用 agent-switch-cn-dev，
// 避免开发调试污染正式配置
app.setName(app.isPackaged ? 'agent-switch-cn' : 'agent-switch-cn-dev')

function createWindow(): void {
  // 打包后图标在 extraResources（process.resourcesPath），开发态在项目 build/ 下
  const iconCandidates = [join(process.resourcesPath || '', 'icon.png'), join(app.getAppPath(), 'build', 'icon.png')]
  const iconPath = iconCandidates.find((p) => p.length > 0 && existsSync(p))
  win = new BrowserWindow({
    width: 1024,
    height: 720,
    minWidth: 800,
    minHeight: 560,
    title: 'agent-switch-cn',
    icon: iconPath ? iconPath : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // electron-vite 开发模式下走 renderer dev server
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  // ---- Provider CRUD ----
  ipcMain.handle('providers:list', () => store.listProviders())

  ipcMain.handle('providers:save', (_e, p: Provider) => {
    const now = Date.now()
    const models = Array.isArray(p.models)
      ? [...new Set(p.models.map((m) => String(m).trim()).filter(Boolean))].slice(0, 500)
      : undefined
    let website: string | undefined
    if (p.website && /^https?:\/\//i.test(p.website.trim())) website = p.website.trim()
    const provider: Provider = {
      id: p.id || randomUUID(),
      name: p.name?.trim(),
      baseUrl: p.baseUrl?.trim(),
      apiKey: p.apiKey?.trim() ?? '',
      modelName: p.modelName?.trim() || undefined,
      headers: p.headers,
      models: models && models.length ? models : undefined,
      website,
      createdAt: p.createdAt || now,
      updatedAt: now
    }
    store.upsertProvider(provider)
    return provider
  })

  ipcMain.handle('providers:delete', (_e, id: string) => {
    store.deleteProvider(id)
    return true
  })

  // ---- 官网链接（仅允许公网 http/https，用系统默认浏览器打开）----
  ipcMain.handle('app:openExternal', async (_e, raw: string) => {
    const u = await assertPublicHttpUrl(String(raw || ''))
    await shell.openExternal(u.toString())
    return true
  })

  // ---- 剪贴板（渲染层写系统剪贴板）----
  ipcMain.handle('app:copyText', (_e, text: unknown) => {
    clipboard.writeText(String(text ?? ''))
    return true
  })

  // ---- 检查更新 ----
  ipcMain.handle('app:checkUpdate', () =>
    checkForUpdate(app.getPath('userData'), app.getVersion())
  )

  // ---- 模型拉取（OpenAI 兼容 /models 接口）----
  ipcMain.handle('models:fetch', async (_e, baseUrl: string, apiKey: string) => {
    try {
      const models = await fetchModels(baseUrl, apiKey)
      return models
    } catch (err) {
      throw new Error((err as Error).message)
    }
  })

  // ---- Agent 探测 & 切换 ----
  ipcMain.handle('agents:list', () => agents.listAgents())
  ipcMain.handle('agents:detect', () => agents.detectAgents())
  ipcMain.handle('agents:status', (_e, instance) => agents.readStatus(instance))
  ipcMain.handle('agents:switch', async (_e, agentId: string, providerId: string) =>
    agents.switch(agentId, providerId)
  )

  // ---- Trae CDP 状态/调试 ----
  ipcMain.handle('trae:preflight', () => traePreflight())
  ipcMain.handle('trae:readModel', () => traeReadCurrentModel())

  // ---- 备份 ----
  ipcMain.handle('backups:list', () => store.listBackups())
}

app.whenReady().then(() => {
  app.setAppUserModelId('cn.agentswitch.app')
  store = new Store(app.getPath('userData'))
  agents = new AgentService(store)
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/** 调 OpenAI 兼容 /models 接口拉取可用模型 id 列表 */
async function fetchModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const base = baseUrl.trim().replace(/\/+$/, '')
  const url = /\/models$/.test(base) ? base : `${base}/models`
  // 出站前校验：仅允许公网 http/https
  await assertPublicHttpUrl(url)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      signal: controller.signal
    })
    if (!res.ok) {
      throw new Error(`拉取失败 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    const json = (await res.json()) as { data?: Array<{ id?: string }> }
    const ids = (json.data ?? [])
      .map((m) => m.id)
      .filter((x): x is string => typeof x === 'string' && x.length > 0)
    return ids
  } finally {
    clearTimeout(timer)
  }
}