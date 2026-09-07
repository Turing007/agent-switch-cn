import type { AgentDef, AgentField, Provider, SwitchStatus, AgentApplyCtx, AgentStatusCtx } from '../shared/types'

/**
 * 内置 Agent 适配器注册表。
 * 每个 agent 以数据驱动方式描述：配置文件路径模板 + 字段写入规则。
 * 新增 agent 只需在此追加定义，不改核心逻辑。
 * 对结构特殊的 agent（如 ZCode 需要整块 provider 对象），可提供自定义 apply/readStatus 钩子。
 */

export function platformConfigPaths(paths: Record<string, string[]>): string[] {
  const p = process.platform as string
  if (paths[p]) return paths[p]
  return paths['default'] || []
}

/** 工具：从 provider 推出 ZCode 兼容的 kind */
function zcodeKind(baseUrl: string): 'anthropic' | 'openai-compatible' {
  return /anthropic|#fh/i.test(baseUrl) ? 'anthropic' : 'openai-compatible'
}

/** ZCode 专用 provider 键前缀，避免与用户内置/自定义 provider 冲突 */
export const ZCODE_PROVIDER_PREFIX = 'agent-switch:'

/** 将应用的 Provider 写成 ZCode config.json provider 结构（非破坏性，仅改目标项并停用其余） */
function zcodeApply(file: string, provider: Provider, ctx: AgentApplyCtx): void {
  const data = (ctx.fileExists(file) ? (ctx.readJson(file) as Record<string, unknown>) : {}) || {}
  if (data.provider == null || typeof data.provider !== 'object') data.provider = {}
  const providers = data.provider as Record<string, any>

  const targetKey = `${ZCODE_PROVIDER_PREFIX}${provider.id}`
  // 停用除当前目标外的所有 provider
  for (const key of Object.keys(providers)) {
    if (key !== targetKey) {
      const entry = providers[key]
      if (entry && typeof entry === 'object' && entry.enabled != null) entry.enabled = false
    }
  }

  const models: Record<string, unknown> = {}
  if (provider.modelName) {
    models[provider.modelName] = {
      limit: { context: 999999, output: 32000 },
      modalities: { input: ['text', 'image'], output: ['text'] },
      zcode: { modified: true }
    }
  }

  providers[targetKey] = {
    name: provider.name,
    kind: zcodeKind(provider.baseUrl),
    options: {
      apiKey: provider.apiKey || '',
      baseURL: provider.baseUrl,
      apiKeyRequired: true
    },
    enabled: true,
    source: 'custom',
    ...(Object.keys(models).length ? { models } : {})
  }

  ctx.writeJson(file, data)
}

/** 读取 ZCode 当前启用 provider，识别是否指向本应用配置的某个 Provider */
function zcodeReadStatus(file: string, ctx: AgentStatusCtx): SwitchStatus {
  if (!ctx.fileExists(file)) return { configured: false }
  let data: { provider?: Record<string, any> }
  try {
    data = ctx.readJson(file) as { provider?: Record<string, any> }
  } catch {
    return { configured: false }
  }
  const providers = data?.provider ?? {}
  // 优先取本应用写入的 provider；否则取任一 enabled 的 provider
  const entries = Object.entries(providers).filter(([, e]) => e && typeof e === 'object' && e.enabled)
  const ours = entries.find(([k]) => k.startsWith(ZCODE_PROVIDER_PREFIX))
  const entry = ours ?? entries[0]
  if (!entry) return { configured: false }
  const [, def] = entry
  const base = String(def?.options?.baseURL ?? '')
  const modelName = def?.models ? Object.keys(def.models)[0] : undefined
  const providerName = ctx.listProviders().find(
    (p) => p.baseUrl.trim().replace(/\/+$/, '') === base.trim().replace(/\/+$/, '')
  )?.name
  return {
    configured: base.length > 0,
    providerName,
    modelName: modelName ? String(modelName) : undefined
  }
}

/**
 * 智谱 CodeGeeX（VSCode 插件）
 * 在 VSCode 用户 settings.json 中以扁平键写入自定义模型：
 *   codegeex.apiBase / codegeex.apiKey / codegeex.model
 */
export const codegeexAgent: AgentDef = {
  id: 'codegeex-vscode',
  name: 'CodeGeeX (VSCode 插件)',
  description: '智谱 CodeGeeX 插件，通过 VSCode settings.json 的 codegeex.* 扁平键接入任意 OpenAI 兼容 API',
  configPaths: platformConfigPaths({
    win32: ['{appdata}/Code/User/settings.json'],
    darwin: ['{home}/Library/Application Support/Code/User/settings.json', '{appdata}/Code/User/settings.json'],
    default: ['{config}/Code/User/settings.json', '{home}/.config/Code/User/settings.json']
  }),
  fields: [
    { name: 'baseUrl', jsonPath: 'codegeex.apiBase', flat: true, source: 'baseUrl' },
    { name: 'apiKey', jsonPath: 'codegeex.apiKey', flat: true, source: 'apiKey' },
    { name: 'modelName', jsonPath: 'codegeex.model', flat: true, source: 'modelName' }
  ],
  detection: 'first'
}

/**
 * 通用 CLI agent 适配器。
 * 适用于以 JSON 配置文件组织 OpenAI 兼容模型设置的 CLI 工具，
 * 常见约定字段：api_base / api_base_url、api_key、model。
 * 可用于临时接入暂未内置的国产 CLI agent。
 */
export const genericCliAgent: AgentDef = {
  id: 'generic-cli',
  name: '通用 CLI Agent（JSON 约定）',
  description: '面向以 config.json + api_base/api_key/model 为约定的国产 CLI agent，属试配用的兜底适配器',
  configPaths: [
    '{config}/agent-switch-cn/custom.json',
    '{home}/.agent-switch-cn/custom.json'
  ],
  fields: [
    { name: 'baseUrl', jsonPath: 'api_base', tomlPath: 'api_base', source: 'baseUrl' },
    { name: 'apiKey', jsonPath: 'api_key', tomlPath: 'api_key', source: 'apiKey' },
    { name: 'modelName', jsonPath: 'model', tomlPath: 'model', source: 'modelName' }
  ],
  detection: 'first'
}

/**
 * ZCode（智谱 Z.ai 桌面 Agent）
 * 配置在 ~/.zcode/v2/config.json 的 provider 映射中，每个 provider 含
 * options.apiKey/baseURL、models、enabled。切换需整块写入并管理 enabled 状态。
 */
export const zcodeAgent: AgentDef = {
  id: 'zcode',
  name: 'ZCode (Z.ai 桌面 Agent)',
  description: '智谱 ZCode，通过改写 ~/.zcode/v2/config.json 的 provider 区块接入任意 API（非破坏性写入）',
  configPaths: platformConfigPaths({
    win32: ['{home}/.zcode/v2/config.json'],
    default: ['{home}/.zcode/v2/config.json']
  }),
  fields: [],
  detection: 'first',
  apply: zcodeApply,
  readStatus: zcodeReadStatus
}

/**
 * Trae（TraeWork / Trae CN 桌面版）
 * 采用 CDP(GUI 自动化) 驱动，无配置文件可写；需以 --remote-debugging-port 运行。
 */
export const traeAgent: AgentDef = {
  id: 'trae',
  name: 'Trae (桌面版)',
  description: '通过 Chrome DevTools Protocol 驱动 Trae 桌面版的模型选择器（需以调试模式运行）',
  configPaths: ['{home}/.trae/.keep'],
  fields: [],
  detection: 'first',
  kind: 'cdp'
}

export const AGENT_REGISTRY: AgentDef[] = [codegeexAgent, zcodeAgent, traeAgent, genericCliAgent]

export function getAgentDef(id: string): AgentDef | undefined {
  return AGENT_REGISTRY.find((a) => a.id === id)
}