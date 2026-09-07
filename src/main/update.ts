import { readFileSync } from 'fs'
import { join } from 'path'
import { assertPublicHttpUrl } from './urlguard'
import type { UpdateCheckResult } from '../shared/types'

/**
 * 发布者在这里填写更新清单地址：
 * 一个返回 JSON 的公网 http/https URL，格式：
 *   { "version": "1.2.3", "url": "https://下载页或安装包直链", "notes": "更新说明" }
 * 例如托管在 GitHub Releases / Gitee / 自建服务器上的 latest.json。
 * 也可不改此常量：通过环境变量 AGENT_SWITCH_UPDATE_URL，或把地址写进
 * userData/update-url.txt（一行一个地址）来覆盖。
 */
export const UPDATE_MANIFEST_URL = ''

export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const s = v.trim().replace(/^v/i, '')
    const [core, pre] = s.split('-')
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre && pre.length ? pre : undefined }
  }
  const A = parse(a)
  const B = parse(b)
  const len = Math.max(A.nums.length, B.nums.length)
  for (let i = 0; i < len; i++) {
    const x = A.nums[i] ?? 0
    const y = B.nums[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  // 数值相同时：正式版 > 预发布版（semver 约定）
  if (!!A.pre !== !!B.pre) return A.pre ? -1 : 1
  return 0
}

/**
 * 读取更新清单并比较版本；所有失败都以 message 说明，不抛异常。
 * 出站防护：assertPublicHttpUrl 校验协议/用户信息/主机名/DNS 解析结果（防 DNS rebinding），
 * 返回的 URL 对象才进入 fetch；redirect: 'manual' 禁止跟随重定向，避免跳往未校验地址。
 */
export async function checkForUpdate(userDataDir: string, currentVersion: string): Promise<UpdateCheckResult> {
  const base: UpdateCheckResult = { hasUpdate: false, current: currentVersion, message: '' }
  let raw = UPDATE_MANIFEST_URL || process.env.AGENT_SWITCH_UPDATE_URL || ''
  if (!raw) {
    try {
      raw = readFileSync(join(userDataDir, 'update-url.txt'), 'utf-8').trim()
    } catch {
      /* 未提供更新源文件 */
    }
  }
  if (!raw) {
    return { ...base, message: '未配置更新服务器：请在 src/main/update.ts 填写 UPDATE_MANIFEST_URL，或将清单地址写入 userData/update-url.txt' }
  }
  try {
    // 校验并返回仅指向公网 http/https 的 URL 对象
    const url = await assertPublicHttpUrl(raw)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    let res: Response
    try {
      res = await fetch(url, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { Accept: 'application/json' }
      })
    } finally {
      clearTimeout(timer)
    }
    if (res.status >= 300 && res.status < 400) {
      return { ...base, error: true, message: '更新服务器返回重定向，已拒绝（仅允许直连清单地址）' }
    }
    if (!res.ok) {
      return { ...base, error: true, message: `更新服务器返回 HTTP ${res.status}` }
    }
    const manifest = (await res.json()) as { version?: string; url?: string; notes?: string }
    if (!manifest || typeof manifest.version !== 'string' || !manifest.version.trim()) {
      return { ...base, error: true, message: '更新清单格式无效（缺少 version 字段）' }
    }
    const hasUpdate = compareVersions(manifest.version, currentVersion) > 0
    return {
      hasUpdate,
      current: currentVersion,
      latest: manifest.version,
      url: manifest.url,
      notes: manifest.notes,
      message: hasUpdate ? `发现新版本 v${manifest.version}（当前 v${currentVersion}）` : `已是最新版本（v${currentVersion}）`
    }
  } catch (e) {
    return { ...base, error: true, message: `检查更新失败: ${(e as Error).message}` }
  }
}
