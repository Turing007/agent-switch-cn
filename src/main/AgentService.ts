import type { Provider, AgentDef, AgentInstance, AgentField, SwitchResult, SwitchStatus, AgentApplyCtx, AgentStatusCtx } from '../shared/types'
import { AGENT_REGISTRY, getAgentDef } from './agents'
import { Store } from './store'
import { findTraeExecutable, ensureDebugMode, switchTo as traeSwitchTo } from './trae'
import {
  resolveTmpl,
  detectFormat,
  readJson,
  writeJson,
  readTomlFlat,
  writeTomlFlat,
  getByPath,
  setByPath,
  backupFile,
  fileExists
} from './fsutil'

export class AgentService {
  constructor(private store: Store) {}

  listAgents(): AgentDef[] {
    return AGENT_REGISTRY
  }

  /** 探测每个内置 agent 实际命中的配置文件 */
  detectAgents(): AgentInstance[] {
    const instances: AgentInstance[] = []
    for (const def of AGENT_REGISTRY) {
      const resolvedPaths = def.configPaths.map((t) => resolveTmpl(t))
      if (def.detection === 'first') {
        const hit = resolvedPaths.find((p) => fileExists(p))
        const exists = def.kind === 'cdp' ? findTraeExecutable() != null : hit != null
        instances.push(this.toInstance(def, def.kind === 'cdp' ? '' : (hit ?? resolvedPaths[0]), exists))
      } else {
        for (const p of resolvedPaths) {
          if (fileExists(p)) instances.push(this.toInstance(def, p, true))
        }
      }
    }
    return instances
  }

  private toInstance(def: AgentDef, file: string, exists: boolean): AgentInstance {
    return {
      agentId: def.id,
      agentName: def.name,
      configFilePath: file,
      format: detectFormat(file),
      exists
    }
  }

  /** 根据字段定义从 provider 取值（可空） */
  private fieldValue(f: AgentField, provider: Provider): string | null {
    switch (f.source) {
      case 'baseUrl':
        return provider.baseUrl
      case 'apiKey':
        return provider.apiKey
      case 'modelName':
        return provider.modelName || null
      case 'const':
        return f.value ?? null
      case 'header:':
        return provider.headers?.[f.name.replace(/^header:/, '')] ?? null
      default:
        return null
    }
  }

  /** 将 provider 写入 agent 配置文件 */
  private writeProviderToConfig(def: AgentDef, file: string, provider: Provider): void {
    if (def.apply) {
      const ctx: AgentApplyCtx = {
        fileExists,
        readJson,
        writeJson,
        backupFile,
        getBackupDir: () => this.store.getBackupDir()
      }
      def.apply(file, provider, ctx)
      return
    }
    const format = detectFormat(file)
    if (format === 'toml') {
      const data: Record<string, string> = fileExists(file) ? readTomlFlat(file) : {}
      for (const f of def.fields) {
        const key = f.tomlPath || f.name
        const value = this.fieldValue(f, provider)
        if (value != null) data[key] = value
      }
      writeTomlFlat(file, data)
    } else {
      const data = (fileExists(file) ? readJson(file) : {}) as Record<string, unknown>
      for (const f of def.fields) {
        const path = f.jsonPath
        if (!path) continue
        const value = this.fieldValue(f, provider)
        if (value != null) {
          if (f.flat) data[path] = value
          else setByPath(data, path, value)
        }
      }
      writeJson(file, data)
    }
  }

  /** 检测 agent 当前是否已指向某个已配置的 provider */
  readStatus(instance: AgentInstance): SwitchStatus {
    const def = getAgentDef(instance.agentId)
    if (!def || !instance.exists) return { configured: false }
    // CDP 型(如 Trae)无配置文件可读，回显上次设置的 provider
    if (def.kind === 'cdp') {
      const pid = this.store.getActive(def.id)
      const p = pid ? this.store.getProvider(pid) : undefined
      return { configured: !!p, providerName: p?.name, modelName: p?.modelName }
    }
    try {
      if (def.readStatus) {
        const ctx: AgentStatusCtx = {
          fileExists,
          readJson,
          listProviders: () => this.store.listProviders()
        }
        return def.readStatus(instance.configFilePath, ctx)
      }
      const values: Record<string, unknown> = {}
      if (instance.format === 'toml') {
        const data = readTomlFlat(instance.configFilePath)
        for (const f of def.fields) {
          const key = f.tomlPath || f.name
          values[f.source] = data[key]
        }
      } else {
        const data = readJson(instance.configFilePath) as Record<string, unknown>
        for (const f of def.fields) {
          if (f.jsonPath) {
            const v = f.flat ? data[f.jsonPath] : getByPath(data, f.jsonPath)
            if (v !== undefined) values[f.source] = v
          }
        }
      }
      const baseVal = values['baseUrl']
      const providerName = this.store
        .listProviders()
        .find((p) => normalizedBase(p.baseUrl) === normalizedBase(String(baseVal ?? '')))
      return {
        configured: baseVal != null && String(baseVal).length > 0,
        providerName: providerName ? providerName.name : undefined,
        modelName: values['modelName'] != null ? String(values['modelName']) : undefined
      }
    } catch {
      return { configured: false }
    }
  }

  /** 切换 agent 到指定 provider，切换前自动备份 */
  async switch(agentId: string, providerId: string): Promise<SwitchResult> {
    const def = getAgentDef(agentId)
    const provider = this.store.getProvider(providerId)
    if (!def) return { ok: false, message: `未知 agent: ${agentId}` }
    if (!provider) return { ok: false, message: `未知 provider: ${providerId}` }

    // CDP 型：通过 GUI 自动化驱动（如 Trae）
    if (def.kind === 'cdp') {
      try {
        const pre = await ensureDebugMode()
        if (!pre.ok) return { ok: false, message: pre.message }
        const r = await traeSwitchTo(provider)
        if (!r.ok) return { ok: false, message: r.message }
        this.store.setActive(agentId, providerId)
        return { ok: true, message: r.message }
      } catch (e) {
        return { ok: false, message: `Trae 切换失败: ${(e as Error).message}` }
      }
    }

    const instance = this.detectAgents().find((i) => i.agentId === agentId)
    if (!instance) return { ok: false, message: '未找到 agent 配置' }
    try {
      let backupPath: string | undefined
      if (instance.exists) {
        backupPath = backupFile(instance.configFilePath, this.store.getBackupDir())
      }
      this.writeProviderToConfig(def, instance.configFilePath, provider)
      this.store.setActive(agentId, providerId)
      return { ok: true, message: `已切换 ${def.name} → ${provider.name}`, backupPath }
    } catch (e) {
      return { ok: false, message: `切换失败: ${(e as Error).message}` }
    }
  }
}

function normalizedBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}