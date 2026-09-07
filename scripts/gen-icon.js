// 无依赖图标生成：与 build/icon.svg 同几何的栅格化实现（含超采样抗锯齿），
// 输出 build/ 下固定文件名的 PNG 图标，供 BrowserWindow icon 与后续打包使用。
// 用法：node scripts/gen-icon.js
'use strict'
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

// ---- PNG 编码 ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0 // filter: none
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---- 几何（512 设计空间，与 build/icon.svg 一致）----
const SIZE = 512
const BG1 = [0x5b, 0x8c, 0xff]
const BG2 = [0x8f, 0x6b, 0xff]
// 圆角方块
const M = 24 // 外边距
const R = 112 // 圆角半径
// 右向箭头（上）：条 184..284 y213..239，三角基 284 顶点 332
const RIGHT = { bar: { x0: 184, x1: 284, y0: 213, y1: 239 }, tri: [[284, 195], [332, 226], [284, 257]] }
// 左向箭头（下）：条 228..328 y273..299，三角基 228 顶点 180
const LEFT = { bar: { x0: 228, x1: 328, y0: 273, y1: 299 }, tri: [[228, 255], [180, 286], [228, 317]] }

function sdRoundBox(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r)
  const qy = Math.abs(py - cy) - (hy - r)
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r
}
function sdTriangle(px, py, a, b, c) {
  const d = (ax, ay, bx, by) => {
    const ex = bx - ax, ey = by - ay
    const wx = px - ax, wy = py - ay
    const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey)))
    const dx = wx - ex * t, dy = wy - ey * t
    return Math.hypot(dx, dy)
  }
  const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  const sign = (p) => {
    const c1 = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
    const c2 = (c[0] - b[0]) * (p[1] - b[1]) - (c[1] - b[1]) * (p[0] - b[0])
    const c3 = (a[0] - c[0]) * (p[1] - c[1]) - (a[1] - c[1]) * (p[0] - c[0])
    const s = cross > 0 ? [c1, c2, c3] : [-c1, -c2, -c3]
    return Math.min(...s) >= 0 ? -1 : 1 // 内部为负（SDF 约定：外部为正）
  }
  const dist = Math.min(d(a[0], a[1], b[0], b[1]), d(b[0], b[1], c[0], c[1]), d(c[0], c[1], a[0], a[1]))
  return sign([px, py]) * dist
}
function sdArrow(px, py, ar) {
  const bar = sdRoundBox(px, py, (ar.bar.x0 + ar.bar.x1) / 2, (ar.bar.y0 + ar.bar.y1) / 2,
    (ar.bar.x1 - ar.bar.x0) / 2, (ar.bar.y1 - ar.bar.y0) / 2, 4)
  const tri = sdTriangle(px, py, ar.tri[0], ar.tri[1], ar.tri[2])
  return Math.min(bar, tri)
}
function boxSdf(px, py) {
  const cx = SIZE / 2, cy = SIZE / 2, half = (SIZE - 2 * M) / 2
  return sdRoundBox(px, py, cx, cy, half, half, R)
}
function glyphSdf(px, py) {
  return Math.min(sdArrow(px, py, RIGHT), sdArrow(px, py, LEFT))
}
const clamp01 = (v) => Math.max(0, Math.min(1, v))
// alpha: d=0 为边界，±0.75px 过渡带（512 设计空间）
const aa = (d) => clamp01(0.75 - d)

function render(size) {
  const SS = size >= 512 ? 2 : 3 // 小尺寸用更高倍超采样
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let aBg = 0, r = 0, g = 0, b = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = ((x + (sx + 0.5) / SS) * SIZE) / size
          const py = ((y + (sy + 0.5) / SS) * SIZE) / size
          const bg = aa(boxSdf(px, py))
          if (bg <= 0) continue
          const t = clamp01((px + py) / (2 * SIZE))
          let cr = BG1[0] + (BG2[0] - BG1[0]) * t
          let cg = BG1[1] + (BG2[1] - BG1[1]) * t
          let cb = BG1[2] + (BG2[2] - BG1[2]) * t
          const gl = aa(glyphSdf(px, py))
          if (gl > 0) {
            cr += (255 - cr) * gl
            cg += (255 - cg) * gl
            cb += (255 - cb) * gl
          }
          aBg += bg
          r += cr * bg
          g += cg * bg
          b += cb * bg
        }
      }
      const n = SS * SS
      const A = aBg / n
      const idx = (y * size + x) * 4
      if (A > 0) {
        buf[idx] = Math.round(r / aBg)
        buf[idx + 1] = Math.round(g / aBg)
        buf[idx + 2] = Math.round(b / aBg)
      }
      buf[idx + 3] = Math.round(A * 255)
    }
  }
  return buf
}

// 固定输出清单（文件名全部为静态字面量）
const OUTPUT_DIR = path.join(__dirname, '..', 'build')
const OUTPUTS = [
  [512, 'icon.png'],
  [256, 'icon-256.png'],
  [64, 'icon-64.png'],
  [32, 'icon-32.png'],
  [16, 'icon-16.png']
]

fs.mkdirSync(OUTPUT_DIR, { recursive: true })
for (const [size, name] of OUTPUTS) {
  const target = path.join(OUTPUT_DIR, name)
  if (!target.startsWith(OUTPUT_DIR + path.sep)) throw new Error('非法输出路径: ' + name)
  const png = encodePng(size, size, render(size))
  fs.writeFileSync(target, png)
  console.log('written', target, png.length, 'bytes')
}

// 打包 build/icon.ico（PNG 条目的 ICO 容器，Vista+ 支持；供 electron-builder 使用）
const ICO_SOURCES = [
  [256, 'icon-256.png'],
  [64, 'icon-64.png'],
  [32, 'icon-32.png'],
  [16, 'icon-16.png']
]
const pngBlobs = ICO_SOURCES.map(([size, name]) => {
  const file = path.join(OUTPUT_DIR, name)
  if (!file.startsWith(OUTPUT_DIR + path.sep)) throw new Error('非法输入路径: ' + name)
  return { size, data: fs.readFileSync(file) }
})
const iconDir = Buffer.alloc(6)
iconDir.writeUInt16LE(0, 0) // reserved
iconDir.writeUInt16LE(1, 2) // type: icon
iconDir.writeUInt16LE(pngBlobs.length, 4)
const entries = []
let offset = 6 + 16 * pngBlobs.length
for (const { size, data } of pngBlobs) {
  const e = Buffer.alloc(16)
  e[0] = size === 256 ? 0 : size // 0 表示 256
  e[1] = e[0]
  e[2] = 0 // palette
  e[3] = 0 // reserved
  e.writeUInt16LE(1, 4) // planes
  e.writeUInt16LE(32, 6) // bpp
  e.writeUInt32LE(data.length, 8)
  e.writeUInt32LE(offset, 12)
  offset += data.length
  entries.push(e)
}
const icoTarget = path.join(OUTPUT_DIR, 'icon.ico')
if (!icoTarget.startsWith(OUTPUT_DIR + path.sep)) throw new Error('非法输出路径: icon.ico')
fs.writeFileSync(icoTarget, Buffer.concat([iconDir, ...entries, ...pngBlobs.map((p) => p.data)]))
console.log('written', icoTarget, 'entries:', pngBlobs.length)
