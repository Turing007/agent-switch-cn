import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import type { Provider, AgentInstance } from '../shared/types'

/**
 * 本地明文 JSON 存储：保存在 Electron userData 目录下。
 * - config.json: providers 列表 + 每个 agent 当前激活的 provider
 */
export interface StoreData {
  providers: Provider[]
  active: Record<string, string> // agentId -> providerId
}

export class Store {
  private filePath: string
  private data: StoreData

  constructor(storeDir: string) {
    this.filePath = join(storeDir, 'config.json')
    if (!existsSync(storeDir)) mkdirSync(storeDir, { recursive: true })
    this.data = this.load()
  }

  getConfigFile(): string {
    return this.filePath
  }

  getBackupDir(): string {
    return join(join(this.filePath, '..'), 'backups')
  }

  private load(): StoreData {
    if (!existsSync(this.filePath)) return { providers: [], active: {} }
    try {
      const raw = readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      return {
        providers: Array.isArray(parsed.providers) ? parsed.providers : [],
        active: parsed.active && typeof parsed.active === 'object' ? parsed.active : {}
      }
    } catch {
      return { providers: [], active: {} }
    }
  }

  private save(): void {
    mkdirSync(join(this.filePath, '..'), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8')
  }

  listProviders(): Provider[] {
    return this.data.providers
  }

  getProvider(id: string): Provider | undefined {
    return this.data.providers.find((p) => p.id === id)
  }

  upsertProvider(p: Provider): void {
    const idx = this.data.providers.findIndex((x) => x.id === p.id)
    if (idx >= 0) this.data.providers[idx] = p
    else this.data.providers.push(p)
    this.save()
  }

  deleteProvider(id: string): void {
    this.data.providers = this.data.providers.filter((p) => p.id !== id)
    for (const k of Object.keys(this.data.active)) {
      if (this.data.active[k] === id) delete this.data.active[k]
    }
    this.save()
  }

  getActive(agentId: string): string | undefined {
    return this.data.active[agentId]
  }

  setActive(agentId: string, providerId: string): void {
    this.data.active[agentId] = providerId
    this.save()
  }

  listBackups(limit = 20): string[] {
    const dir = this.getBackupDir()
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .map((f) => join(dir, f))
      .sort((a, b) => (a > b ? -1 : 1))
      .slice(0, limit)
  }
}