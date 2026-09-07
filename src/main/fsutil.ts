import { existsSync, readFileSync, mkdirSync, writeFileSync, copyFileSync } from 'fs'
import { dirname, join } from 'path'
import { platform, homedir } from 'os'

/** 简单工具：读写 JSON / TOML 配置文件，支持备份 */

export function readJson(file: string): unknown {
  const raw = readFileSync(file, 'utf-8')
  return JSON.parse(raw)
}

export function writeJson(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8')
}

/**
 * TOML 极简解析/写入。
 * 仅支持扁平的 `key = value` 和 `[section]` 结构，返回值以字符串为单位。
 * 足够满足多数 CLI agent 的配置需求；复杂 TOML 不在 MVP 范围内。
 */
export function readTomlFlat(file: string): Record<string, string> {
  const raw = readFileSync(file, 'utf-8')
  const result: Record<string, string> = {}
  let section = ''
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const sectionMatch = trimmed.match(/^\[(.+)\]$/)
    if (sectionMatch) {
      section = sectionMatch[1].trim()
      continue
    }
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    value = stripTomlQuotes(value)
    const fullKey = section ? `${section}.${key}` : key
    result[fullKey] = value
  }
  return result
}

export function writeTomlFlat(file: string, data: Record<string, string>): void {
  // 按 section 分组，重写为规范 TOML
  const sections = new Map<string, Record<string, string>>()
  for (const [key, value] of Object.entries(data)) {
    const dot = key.indexOf('.')
    if (dot > 0) {
      const sec = key.slice(0, dot)
      const k = key.slice(dot + 1)
      if (!sections.has(sec)) sections.set(sec, {})
      sections.get(sec)![k] = value
    } else {
      if (!sections.has('')) sections.set('', {})
      sections.get('')![key] = value
    }
  }
  const lines: string[] = []
  for (const [sec, kv] of sections) {
    if (sec) {
      lines.push('')
      lines.push(`[${sec}]`)
    }
    for (const [k, v] of Object.entries(kv)) {
      lines.push(`${k} = ${quoteToml(v)}`)
    }
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
}

function stripTomlQuotes(v: string): string {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1)
  }
  return v
}

function quoteToml(v: string): string {
  if (/^-?\d+$/.test(v) || /^-?\d+\.\d+$/.test(v) || v === 'true' || v === 'false') {
    return v
  }
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** 带时间戳的备份，返回备份文件路径 */
export function backupFile(file: string, storeDir: string): string {
  if (!existsSync(file)) throw new Error(`配置文件不存在: ${file}`)
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const base = `${dirname(file).replace(/[\\/:]/g, '_')}_${file.split(/[\\/]/).pop()}`
  const backupPath = join(storeDir, 'backups', `${base}.${ts}`)
  mkdirSync(dirname(backupPath), { recursive: true })
  copyFileSync(file, backupPath)
  return backupPath
}

/** 按 key 路径读取嵌套 JSON 值（support.a.b） */
export function getByPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

/** 按 key 路径写入嵌套 JSON 值，自动创建中间对象 */
export function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.')
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]
    if (typeof cur[k] !== 'object' || cur[k] === null) {
      cur[k] = {}
    }
    cur = cur[k] as Record<string, unknown>
  }
  cur[keys[keys.length - 1]] = value
}

/** 解析 ~ 为用户 home，以及 {home}/{appdata} 占位 */
export function expandHome(p: string, home: string): string {
  if (p === '~') return home
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return join(home, p.slice(2))
  }
  return p
}

/** 平台相关路径模板 → 绝对路径：支持 ~、{home}、{appdata}、{config} 占位 */
export function resolveTmpl(tmpl: string): string {
  const home = homedir()
  const appdata = process.env.APPDATA || join(home, '.config')
  const config =
    process.platform === 'win32'
      ? join(home, 'AppData', 'Roaming')
      : (process.env.XDG_CONFIG_HOME || join(home, '.config'))
  let out = tmpl
  out = out.replace(/{appdata}/g, appdata)
  out = out.replace(/{config}/g, config)
  out = out.replace(/{home}/g, home)
  out = expandHome(out, home)
  return out
}

export function detectFormat(file: string): 'json' | 'toml' {
  const lower = file.toLowerCase()
  if (lower.endsWith('.toml') || lower.endsWith('.tml')) return 'toml'
  return 'json'
}

export function fileExists(p: string): boolean {
  return existsSync(p)
}