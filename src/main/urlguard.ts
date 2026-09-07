import { isIP } from 'net'
import { lookup } from 'dns/promises'

/**
 * 出站请求地址白名单校验：
 * 仅允许公网 http/https 地址，拒绝 localhost、环回、私有和保留地址，
 * 域名会先做 DNS 解析，任一解析结果落在保留段同样拒绝（防 DNS rebinding）。
 */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error('URL 格式无效')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('仅允许 http/https 地址')
  }
  if (u.username || u.password) {
    throw new Error('地址中不允许携带用户名密码')
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('不允许访问本地/内网地址')
  }
  if (isIP(host)) {
    if (isReservedIp(host)) throw new Error('不允许访问内网/保留地址')
    return u
  }
  let addrs: { address: string }[]
  try {
    addrs = await lookup(host, { all: true })
  } catch {
    throw new Error('域名无法解析')
  }
  if (addrs.length === 0) throw new Error('域名无法解析')
  for (const a of addrs) {
    if (isReservedIp(a.address)) throw new Error('域名解析到内网/保留地址，已拒绝访问')
  }
  return u
}

export function isReservedIp(ip: string): boolean {
  if (isIP(ip) === 4) return isReservedIPv4(ip)
  if (isIP(ip) === 6) return isReservedIPv6(ip)
  return true // 非法地址一律按保留处理
}

function isReservedIPv4(ip: string): boolean {
  const o = ip.split('.').map(Number)
  const [a, b, c] = o
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 169 && b === 254) return true // link-local
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0 && c === 0) return true
  if (a === 198 && (b === 18 || b === 19)) return true // benchmark
  if (a >= 224) return true // multicast + reserved
  return false
}

function isReservedIPv6(ip: string): boolean {
  const words = expandIPv6(ip)
  // 全零 ::
  if (words.every((w) => w === 0)) return true
  // ::1
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true
  // IPv4-mapped ::ffff:0:0/96 与 IPv4-compatible
  if (words.slice(0, 5).every((w) => w === 0) && (words[5] === 0xffff || words[5] === 0)) {
    const v4 = `${(words[6] >> 8) & 0xff}.${words[6] & 0xff}.${(words[7] >> 8) & 0xff}.${words[7] & 0xff}`
    if (isReservedIPv4(v4)) return true
  }
  // fc00::/7 unique-local
  if ((words[0] & 0xfe00) === 0xfc00) return true
  // fe80::/10 link-local
  if ((words[0] & 0xffc0) === 0xfe80) return true
  // 2001:db8::/32 文档段
  if (words[0] === 0x2001 && words[1] === 0x0db8) return true
  // 64:ff9b::/96 NAT64
  if (words[0] === 0x0064 && words[1] === 0xff9b) return true
  return false
}

function expandIPv6(ip: string): number[] {
  const [head, tail] = ip.split('::')
  const h = head ? head.split(':').filter(Boolean) : []
  const t = tail !== undefined ? tail.split(':').filter(Boolean) : []
  const pad = 8 - h.length - t.length
  const all = tail === undefined ? h : [...h, ...Array(Math.max(0, pad)).fill('0'), ...t]
  return all.map((w) => parseInt(w || '0', 16))
}
