// Trae (TraeWork / Trae CN 桌面版) 的 CDP 自动化驱动。
// Trae 是 Electron(VSCode 分支)，聊天/模型 UI 不对 Windows UIA 开放，
// 因此必须通过 Chromium DevTools Protocol(CDP) 驱动 DOM。
// 前置条件：Trae 需以 `--remote-debugging-port=<port>` 启动（或由本应用代为重启）。
import { spawn, execFileSync, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import WebSocket from 'ws'
import type { Provider } from '../shared/types'

export const TRAE_DEBUG_PORT = 9333

/** 已知的 Trae 安装路径候选（按平台） */
function executableCandidates(): string[] {
  const candidates: string[] = []
  const local = process.env['LOCALAPPDATA']
  if (local) {
    candidates.push(
      join(local, 'Programs', 'TRAE SOLO CN', 'TRAE SOLO CN.exe'),
      join(local, 'Programs', 'Trae CN', 'Trae.exe'),
      join(local, 'Programs', 'Trae CN', 'Trae CN.exe'),
      join(local, 'Programs', 'Trae CN', 'Trae Code.exe')
    )
  }
  return candidates
}

export function findTraeExecutable(): string | undefined {
  for (const p of executableCandidates()) {
    if (existsSync(p)) return p
  }
  return undefined
}

const RUNNING_IMAGES = ['TRAE SOLO CN.exe', 'Trae.exe', 'Trae CN.exe', 'Trae Code.exe']

/** 是否有 Trae 进程在运行（同步，供实例探测） */
export function isTraeProcessRunning(): boolean {
  try {
    const out = execFileSync('tasklist', [], { encoding: 'utf8' })
    return RUNNING_IMAGES.some((img) => out.toUpperCase().includes(img.toUpperCase()))
  } catch {
    return false
  }
}

async function fetchTargets(port: number): Promise<{ type: string; url: string; title: string; wsUrl: string }[]> {
  const timeout = setTimeout(() => undefined, 4000)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`)
    if (!res.ok) return []
    const list = (await res.json()) as Array<{
      type?: string
      url?: string
      title?: string
      webSocketDebuggerUrl?: string
    }>
    return (list ?? [])
      .filter((t) => t.type)
      .map((t) => ({
        type: t.type ?? '',
        url: t.url ?? '',
        title: t.title ?? '',
        wsUrl: t.webSocketDebuggerUrl ?? ''
      }))
  } catch {
    return []
  } finally {
    clearTimeout(timeout)
  }
}

/** 调试端口是否可达 */
export async function isDebugUp(port = TRAE_DEBUG_PORT): Promise<boolean> {
  return (await fetchTargets(port)).length > 0
}

class CdpSession {
  private ws?: WebSocket
  private seq = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()

  constructor(private port: number) {}

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return
    const targets = await fetchTargets(this.port)
    const target = targets[pickTargetIndex(targets)]
    if (!target) throw new Error('未发现 Trae 可调试页面，请确认已用 --remote-debugging-port 启动')
    const wsUrl = target.wsUrl
    if (!wsUrl) throw new Error('无法获取调试 WebSocket 地址')
    const ws = new WebSocket(wsUrl)
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', (e) => reject(e))
    })
    ws.on('message', (raw) => this.onMessage(raw))
    this.ws = ws
    await this.send('Runtime.enable')
    await this.send('Page.enable')
  }

  private onMessage(raw: WebSocket.Data): void {
    let msg: any
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
    }
  }

  private send(method: string, params?: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq
      this.pending.set(id, { resolve, reject })
      const ws = this.ws
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('调试连接已断开'))
        return
      }
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression: string, awaitPromise = true): Promise<any> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (r?.exceptionDetails) throw new Error(`页面脚本异常: ${r.exceptionDetails.text ?? 'unknown'}`)
    return r?.result?.value
  }

  async dispatchMouse(x: number, y: number, type: 'press' | 'release' = 'press'): Promise<void> {
    await this.send('Input.dispatchMouseEvent', {
      type,
      x: Math.round(x),
      y: Math.round(y),
      button: 'left',
      clickCount: 1
    })
  }

  async close(): Promise<void> {
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    this.ws = undefined
  }
}

/** 优先 webview（VSCode 工作台），否则工作台/聊天 page */
function pickTargetIndex(targets: { type: string; url: string; title: string }[]): number {
  const webview = targets.findIndex((t) => t.type === 'webview')
  if (webview >= 0) return webview
  const byUrl = targets.findIndex((t) => /workbench|index\.html|trae|chat/i.test(t.url))
  return byUrl >= 0 ? byUrl : 0
}

const sessions = new Map<number, CdpSession>()
async function sessionFor(port: number): Promise<CdpSession> {
  let s = sessions.get(port)
  if (!s) {
    s = new CdpSession(port)
    sessions.set(port, s)
  }
  await s.connect()
  return s
}

export async function disconnect(port = TRAE_DEBUG_PORT): Promise<void> {
  const s = sessions.get(port)
  if (s) {
    await s.close()
    sessions.delete(port)
  }
}

// ===== 状态探测 =====

export interface TraePreflight {
  executable?: string
  running: boolean
  debugUp: boolean
  message: string
}

export async function preflight(port = TRAE_DEBUG_PORT): Promise<TraePreflight> {
  const executable = findTraeExecutable()
  const debugUp = await isDebugUp(port)
  const running = isTraeProcessRunning()
  let message: string
  if (debugUp) message = 'Trae 已以调试模式运行，可直接切换。'
  else if (running) message = 'Trae 正在运行但未开调试端口。切换时将先退出 Trae，再以调试模式重启。'
  else message = 'Trae 未在运行，切换时将自动以调试模式启动。'
  return { executable, running, debugUp, message }
}

/** 读取当前聊天模型选择器上的模型文本（尽量） */
export async function readCurrentModel(port = TRAE_DEBUG_PORT): Promise<{ model?: string; candidates: string[] }> {
  const s = await sessionFor(port)
  const raw = await s.evaluate(
    `(() => {
      const texts = Array.from(document.querySelectorAll('*'))
        .filter(e => e.children.length === 0 && e.innerText && e.innerText.trim().length <= 40)
        .map(e => e.innerText.trim())
        .filter((t, i, a) => a.indexOf(t) === i)
        .slice(-80);
      return JSON.stringify(texts);
    })()`
  )
  return { candidates: safeParse<string[]>(raw) ?? [] }
}

/** 一次性接管：以调试模式确保 Trae 就绪 */
export async function ensureDebugMode(port = TRAE_DEBUG_PORT): Promise<{
  ok: boolean
  message: string
  relaunched?: boolean
}> {
  if (await isDebugUp(port)) return { ok: true, message: '调试就绪' }
  const exe = findTraeExecutable()
  if (!exe) return { ok: false, message: '未找到 Trae 可执行文件，请在“设置”中指定路径' }
  // 若正在运行但未开端口，先退出已有实例（已给用户明确提示）
  if (isTraeProcessRunning()) {
    try {
      execFileSync('taskkill', ['/IM', 'TRAE SOLO CN.exe', '/F'], { stdio: 'ignore' })
      execFileSync('taskkill', ['/IM', 'Trae.exe', '/F'], { stdio: 'ignore' })
      await sleep(1200)
    } catch {
      /* 已退出则忽略 */
    }
  }
  spawn(exe, [`--remote-debugging-port=${port}`], { detached: true, stdio: 'ignore' }).unref()
  await sleep(1500)
  if (await isDebugUp(port)) return { ok: true, message: 'Trae 已以调试模式启动', relaunched: true }
  return { ok: false, message: 'Trae 已尝试重启，但调试端口未就绪，请稍候重试' }
}

// ===== 切换 =====

interface Candidate {
  why: string
  tag: string
  cls: string
  text: string
  x: number
  y: number
  w: number
  h: number
}

/**
 * 把聊天面板模型选择器切到目标 provider 对应的模型。
 * 采用「几何定位 + 文本选择一个半自动」策略；若目标模型未预先存在于 Trae 列表，
 * 返回可操作的诊断信息（首次需通过校准定位选择器）。
 */
export async function switchTo(
  provider: Provider,
  port = TRAE_DEBUG_PORT
): Promise<{ ok: boolean; message: string }> {
  if (!provider.modelName) {
    return { ok: false, message: 'Trae 切换需要先填写“模型 ID”' }
  }
  const modelLabel = provider.modelName
  const s = await sessionFor(port)

  // 1) 采集候选：输入框 + 输入区右侧的可能“模型选择器”
  const raw = await s.evaluate(
    `(() => {
      const out = [];
      const push = (e, why) => {
        const r = e.getBoundingClientRect();
        if (r.width < 5 || r.height < 5) return;
        out.push({ why, tag: e.tagName, cls: (e.className||'').toString().slice(0,80),
          text: ((e.innerText||'').trim().replace(/\\s+/g,' ')).slice(0,60),
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
      };
      const inp = document.querySelector('textarea[contenteditable], [role="textbox"], textarea, [class*="input"][contenteditable], [class*="composer"] textarea');
      let inputRect = null;
      if (inp) { inputRect = inp.getBoundingClientRect(); push(inp, 'inputbox'); }
      // 输入行右侧：位于输入框右边一列、同行、可点击、短文本的元素
      Array.from(document.querySelectorAll('button, [role="button"], [class*="model"], [class*="select"], [class*="toggle"], [aria-haspopup]'))
        .forEach(e => {
          const r = e.getBoundingClientRect();
          if (r.width < 5 || r.height < 5) return;
          const text = (e.innerText||'').trim().replace(/\\s+/g,' ');
          const isShort = text.length > 0 && text.length <= 40 && e.children.length <= 2;
          const nearInput = !inputRect || (Math.abs(r.bottom - inputRect.bottom) < 40 && r.left > inputRect.left - 40);
          if (isShort && nearInput) push(e, 'modelish');
        });
      return JSON.stringify(out.slice(-60));
    })()`
  )
  const cand = safeParse<Candidate[]>(raw) ?? []

  // 候选里优先选“模型选择器”：排除输入框，剩下的短文本元素中最接近输入区右下角的
  const selector = cand
    .filter((c) => c.why !== 'inputbox' && c.text && c.y > 50)
    .sort((a, b) => b.x - a.x)[0]

  if (!selector) {
    return {
      ok: false,
      message:
        '未能自动定位 Trae 的模型选择器。候选元素：\n' +
        cand.map((c) => `  ${c.why} ${c.tag} "${c.text}" @${c.x},${c.y}`).join('\n') +
        '\n\n提示：请先在 Trae 的设置→模型里手动添加目标模型一次，然后告诉我校准定位。'
    }
  }

  // 2) 点击模型选择器，展开列表
  await s.dispatchMouse(selector.x + selector.w / 2, selector.y + selector.h / 2, 'press')
  await s.dispatchMouse(selector.x + selector.w / 2, selector.y + selector.h / 2, 'release')
  await sleep(450)

  // 3) 在弹出列表里按文本选择目标模型
  const picked = await s.evaluate(
    `(() => {
      const want = ${JSON.stringify(modelLabel)};
      const items = Array.from(document.querySelectorAll('div, li, button, [role="option"], [role="menuitem"]'))
        .map(e => ({ text: (e.innerText||'').trim().replace(/\\s+/g,' '), el: e }))
        .filter(x => x.text && x.text.length <= 60);
      const hit = items.find(x => x.text === want || x.text.includes(want) || want.includes(x.text));
      if (!hit) return null;
      const r = hit.el.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2, text: hit.text });
    })()`
  )
  const pick = safeParse<{ x: number; y: number; text: string }>(picked)
  if (pick) {
    await s.dispatchMouse(pick.x, pick.y, 'press')
    await s.dispatchMouse(pick.x, pick.y, 'release')
    await sleep(200)
    return { ok: true, message: `已在 Trae 中选择模型「${pick.text}」` }
  }

  return {
    ok: false,
    message:
      `已打开模型列表，但未找到目标模型「${modelLabel}」。` +
      '请先在 Trae 设置→模型中手动添加该模型（或告诉我做“自动添加”）。' +
      '\n\n用于校准：已将模型选择器定位在 ' + `${Math.round(selector.x)},${Math.round(selector.y)}。`
  }
}

function safeParse<T>(s: string | null | undefined): T | undefined {
  if (!s) return undefined
  try {
    return JSON.parse(String(s)) as T
  } catch {
    return undefined
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// 保留导出避免未使用告警
export type { ChildProcess }