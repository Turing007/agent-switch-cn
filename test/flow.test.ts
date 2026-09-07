// 核心链路冒烟测试：不依赖 Electron GUI，直接验证 Store + AgentService 写入
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Store } from '../src/main/store'
import { AgentService } from '../src/main/AgentService'
import { codegeexAgent, genericCliAgent } from '../src/main/agents'
import type { Provider } from '../src/shared/types'

// 测试用假密钥：拼接生成，非真实凭据；避免在源码中硬编码凭据样式
const fakeKey = ['test', 'fake', 'key'].join('-')

const dir = join(tmpdir(), `asc-test-${Date.now()}`)
mkdirSync(dir, { recursive: true })

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
  console.log('OK:', msg)
}

try {
  // ---- Store ----
  const store = new Store(dir)
  const provider: Provider = {
    id: 'p1',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: fakeKey,
    modelName: 'deepseek-chat',
    createdAt: 1,
    updatedAt: 2
  }
  store.upsertProvider(provider)
  assert(store.listProviders().length === 1, 'Store 新增 provider')
  assert(store.getProvider('p1')?.name === 'DeepSeek', 'Store 读取 provider')

  const svc = new AgentService(store)
  const anySvc = svc as unknown as {
    writeProviderToConfig(def: unknown, file: string, p: Provider): void
  }

  // ---- JSON 写入（模拟 CodeGeeX settings.json 扁平键）----
  const jsonFile = join(dir, 'settings.json')
  writeFileSync(jsonFile, JSON.stringify({ 'editor.lineNumbers': 'on' }), 'utf-8')
  anySvc.writeProviderToConfig(codegeexAgent, jsonFile, provider)
  const json = JSON.parse(readFileSync(jsonFile, 'utf-8'))
  assert(json['codegeex.apiBase'] === 'https://api.deepseek.com', 'JSON 写入 codegeex.apiBase')
  assert(json['codegeex.apiKey'] === fakeKey, 'JSON 写入 codegeex.apiKey')
  assert(json['codegeex.model'] === 'deepseek-chat', 'JSON 写入 codegeex.model')
  assert(json['editor.lineNumbers'] === 'on', '保留原有无关配置')

  // ---- TOML 写入（模拟通用 toml 约定）----
  const tomlFile = join(dir, 'config.toml')
  writeFileSync(tomlFile, '[general]\nname = "foo"\n', 'utf-8')
  anySvc.writeProviderToConfig(genericCliAgent, tomlFile, provider)
  const toml = readFileSync(tomlFile, 'utf-8')
  assert(toml.includes('api_base = "https://api.deepseek.com"'), 'TOML 写入 api_base')
  assert(toml.includes(`api_key = "${fakeKey}"`), 'TOML 写入 api_key')
  assert(toml.includes('[general]'), 'TOML 保留原 section')

  // 说明：writeProviderToConfig 的 JSON/TOML 双路径已在上方覆盖；
  // svc.switch() 使用真实探测路径会写到本机 agent 配置，故不在冒烟测试中调用，
  // 避免污染用户环境。切换/备份/恢复链路在 GUI 集成时验证。

  console.log('\nALL PASSED')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
