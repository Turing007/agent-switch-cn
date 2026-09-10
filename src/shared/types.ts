// 统一建模层：面向国产 CLI Agent 的模型配置切换

/** 厂商/Provider：一个模型供应商（如 DeepSeek、智谱 GLM、Kimi、Qwen 等） */
export interface Provider {
  id: string
  name: string          // 显示名
  baseUrl: string       // 兼容 base_url（OpenAI 或 Anthropic）
  apiKey: string        // 明文存储到本地 JSON（MVP 决策）
  /** 可附加的自定义请求头（可选） */
  headers?: Record<string, string>
  /** 模型名（可选，覆盖 agent 默认） */
  modelName?: string
  /** 拉取到的模型 id 列表缓存（可选，便于回显选择） */
  models?: string[]
  /** 官网链接（可选，卡片上可点击打开） */
  website?: string
  createdAt: number
  updatedAt: number
}

/** 目标 agent（国产 CLI agent），如 CodeGeeX */
export interface AgentDef {
  id: string
  name: string
  description: string
  /** 配置文件路径模板（相对用户 home），支持 {home} 占位 */
  configPaths: string[]
  /** 配置文件中用于写模型/Key 的字段定义 */
  fields: AgentField[]
  /** 探测优先级：highest=第一个存在的文件优先 */
  detection: 'first' | 'all'
  /** 适配方式：file=写配置文件（默认）；cdp=通过 Chromium DevTools Protocol 驱动桌面 GUI */
  kind?: 'file' | 'cdp'
  /** 自定义写入：覆盖默认字段化写入（如 ZCode 需要整块 provider 结构） */
  apply?: (file: string, provider: Provider, ctx: AgentApplyCtx) => void
  /** 自定义读取：覆盖默认字段读取 */
  readStatus?: (file: string, ctx: AgentStatusCtx) => SwitchStatus
}

/** ZCode 等适配器自定义写入时所需的上下文能力 */
export interface AgentApplyCtx {
  fileExists: (f: string) => boolean
  readJson: (f: string) => unknown
  writeJson: (f: string, data: unknown) => void
  backupFile: (f: string, dir: string) => string
  getBackupDir: () => string
}

export interface AgentStatusCtx {
  fileExists: (f: string) => boolean
  readJson: (f: string) => unknown
  listProviders: () => Provider[]
}

export interface AgentField {
  name: string          // 字段逻辑名，如 baseUrl / apiKey / model
  /** 在配置文件 JSON 中的路径（support.a.b 表示嵌套）或扁平键（codegeex.apiBase） */
  jsonPath?: string
  /** 在配置文件 TOML 中的 key 路径 */
  tomlPath?: string
  source: 'baseUrl' | 'apiKey' | 'modelName' | 'header:' | 'const'
  /** source=const 时的固定值；source=header:xxx 时前缀的 header 名 */
  value?: string
  /** true = jsonPath 是扁平键（如 VSCode settings.json 的 codegeex.apiBase），false = 嵌套路径 */
  flat?: boolean
}

/** 已安装的一个 agent 实例及其配置文件位置 */
export interface AgentInstance {
  agentId: string
  agentName: string
  /** 实际命中的配置文件绝对路径 */
  configFilePath: string
  format: 'json' | 'toml'
  exists: boolean
}

export interface SwitchResult {
  ok: boolean
  message?: string
  backupPath?: string
}

export interface SwitchStatus {
  configured: boolean
  providerName?: string
  modelName?: string
}

/** 检查更新结果 */
export interface UpdateCheckResult {
  hasUpdate: boolean
  current: string
  latest?: string
  /** 新版本下载页/安装包地址（来自更新清单） */
  url?: string
  notes?: string
  /** 面向用户的提示文案 */
  message: string
  /** true = 检查过程出错（网络/配置/清单格式） */
  error?: boolean
}

/**
 * 渲染层到后端的统一桥接接口。
 * Tauri 构建下由 src/renderer/src/main.ts 用 invoke 实现；
 * 接口形状与后端命令一一对应。
 */
export interface AppApi {
  providers: {
    list(): Promise<Provider[]>
    save(p: Provider): Promise<Provider>
    delete(id: string): Promise<boolean>
  }
  models: {
    fetch(baseUrl: string, apiKey: string): Promise<string[]>
  }
  app: {
    openExternal(url: string): Promise<boolean>
    copyText(text: string): Promise<boolean>
    checkUpdate(): Promise<UpdateCheckResult>
  }
  agents: {
    list(): Promise<AgentDef[]>
    detect(): Promise<AgentInstance[]>
    status(i: AgentInstance): Promise<SwitchStatus>
    switch(agentId: string, providerId: string): Promise<SwitchResult>
  }
  backups: {
    list(): Promise<string[]>
  }
  trae: {
    preflight(): Promise<unknown>
    readModel(): Promise<unknown>
  }
}